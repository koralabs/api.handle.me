import { randomUUID } from 'node:crypto';
import { LockedLambdaReason, type UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import { HandlesRepository } from '../repositories/handlesRepository';
import { RedisHandlesStore } from '../stores/redis';
import { getApiCacheKey, getApiLocalRepairEpochKey, getApiLocalRepairJournalKey, getApiMetricsKey, getApiMptRebuildPendingKey, getApiScannerLeaseKey, getApiScannerRecoveryKey } from '../stores/redis/keys';
import { repairPreflight, type RepairTarget } from './repairPreflight';
import { buildAndStoreMptRootHash } from './snapshotVerification';
import { createKoiosRepairReader } from './koiosRepairReader';

interface Lease {
    acquire(owner: string): boolean;
    renew(owner: string): boolean;
    release(owner: string): void;
}
interface Journal { version: 1; targets: RepairTarget[]; oldIds: string[]; cursor: { hash: string; slot: number } }
interface Fence { key: string; owner: string; scannerKey: string; scannerOwner: string; ownsScannerLease: boolean }

/** Run the isolated repair using Koios observations anchored to the stored scanner cursor. */
export async function localKoiosRepair(
    store: RedisHandlesStore,
    lease: Lease,
    targets: RepairTarget[] | undefined,
    options: { query?: Parameters<typeof createKoiosRepairReader>[1]; afterFirstWrite?: () => Promise<void> | void } = {}
): Promise<void> {
    const repo = new HandlesRepository(store);
    const read = createKoiosRepairReader(() => {
        const metrics = repo.getMetrics();
        return { hash: metrics.currentBlockHash ?? '', slot: Number(metrics.currentSlot) };
    }, options.query);
    return localRepair(store, lease, targets, read, options.afterFirstWrite);
}

/** Experimental isolated-Valkey executor, deliberately unavailable against a deployed store. */
export async function localRepair(
    store: RedisHandlesStore,
    lease: Lease,
    targets: RepairTarget[] | undefined,
    readCanonical: (targets: RepairTarget[]) => Promise<UTxOWithTxInfo[]>,
    afterFirstWrite?: () => Promise<void> | void
): Promise<void> {
    if (process.env.API_TEST_MODE !== 'integration' || !process.env.API_TEST_VALKEY_RECEIPT || process.env.REDIS_HOST !== '127.0.0.1' || process.env.REDIS_PORT !== '6380' || process.env.NETWORK !== 'preview') {
        throw new Error('Local repair is restricted to the isolated preview test Valkey on 127.0.0.1:6380');
    }
    const repo = new HandlesRepository(store);
    const journalKey = getApiLocalRepairJournalKey();
    const epochKey = getApiLocalRepairEpochKey();
    const snapshotKey = getApiCacheKey('local-repair:lease');
    const progressKey = getApiCacheKey('local-repair:progress');
    const pendingKey = getApiMptRebuildPendingKey();
    const scannerKey = getApiScannerLeaseKey();
    const rawJournal = store.redisClientCall('get', journalKey) as string | null;
    const journal: Journal | undefined = rawJournal ? JSON.parse(rawJournal) : undefined;
    if (journal && (journal.version !== 1 || !Array.isArray(journal.targets) || !Array.isArray(journal.oldIds) || !journal.cursor?.hash || !Number.isSafeInteger(journal.cursor.slot) || journal.cursor.slot <= 0)) throw new Error('Invalid repair journal');
    if (journal && targets && JSON.stringify(targets) !== JSON.stringify(journal.targets)) throw new Error('Another repair is pending');
    const selected = journal?.targets ?? targets;
    if (!selected) throw new Error('No repair journal or targets');
    let owner = '';
    let fence: Fence | undefined;
    let outputs: UTxOWithTxInfo[] = [];
    try {
        const plan = await repairPreflight(selected, {
            acquire: value => { owner = value; return lease.acquire(value); },
            renew: lease.renew,
            // The executor retains the same lease through mutation and final validation.
            release: () => {}
        }, name => repo.getHandle(name), id => repo.getUTxO(id) ?? null, async requested => {
            outputs = await readCanonical(requested);
            return outputs;
        });
        if ((store.redisClientCall('get', journalKey) ?? null) !== (rawJournal ?? null)) throw new Error('Repair journal changed');
        const metrics = repo.getMetrics();
        const cursor = { hash: metrics.currentBlockHash ?? '', slot: Number(metrics.currentSlot) };
        if (!cursor.hash || !Number.isSafeInteger(cursor.slot) || cursor.slot <= 0) throw new Error('Invalid scanner cursor');
        if (journal && (journal.cursor.hash !== cursor.hash || journal.cursor.slot !== cursor.slot)) throw new Error('Scanner cursor changed since repair began');
        if (outputs.some(output => !Number.isSafeInteger(output.slot) || output.slot > Number(metrics.currentSlot) || output.id !== `${output.tx_id}#${output.index}` || output.mint?.some(([, assets]) => assets.length) || output.burn?.some(([, assets]) => assets.length))) {
            throw new Error('Only transfer outputs at or behind the scanner cursor are supported');
        }
        if (!journal && (metrics.lockLambdas !== LockedLambdaReason.UNLOCKED || store.redisClientCall('get', pendingKey) || store.redisClientCall('get', getApiScannerRecoveryKey()))) throw new Error('Store already requires maintenance');
        if (journal && metrics.lockLambdas !== LockedLambdaReason.REINDEX) throw new Error('Repair maintenance lock is missing');
        fence = { key: snapshotKey, owner: randomUUID(), scannerKey, scannerOwner: owner, ownsScannerLease: false };
        const rawMetrics = store.redisClientCall('hgetall', getApiMetricsKey());
        const originalMetrics = Object.fromEntries(rawMetrics.map(({ field, value }: any) => [String(field), String(value)]));
        if (!store.redisClientCall('snapshotClaim', { fence, scannerOriginal: owner, metricsKey: getApiMetricsKey(), progressKey,
            originalMetrics, originalProgress: {}, requireEmpty: false, pattern: '', dataRoots: [] })) throw new Error('Unable to claim repair fence');
        (store as any).snapshotFence = fence;
        const oldIds = [...new Set([...(journal?.oldIds ?? []), ...plan.sources.map(output => output.id)])];
        const nextJournal: Journal = { version: 1, targets: selected, oldIds, cursor };
        store.pipeline(() => {
            store.redisClientCall('set', journalKey, JSON.stringify(nextJournal));
            store.redisClientCall('set', epochKey, randomUUID());
            store.redisClientCall('set', pendingKey, '1');
            repo.setMetrics({ lockLambdas: LockedLambdaReason.REINDEX });
        });
        repo.addUTxOsWithMintDataAndUpdateIndexes(outputs);
        await afterFirstWrite?.();
        const destinationIds = new Set(outputs.map(output => output.id));
        repo.removeUTxOs(oldIds.filter(id => !destinationIds.has(id)));
        await buildAndStoreMptRootHash(store);
        const final = await readCanonical(selected);
        if (JSON.stringify(final) !== JSON.stringify(outputs)) throw new Error('Canonical state changed during repair; recovery required');
        store.pipeline(() => {
            store.redisClientCall('del', [journalKey, pendingKey]);
            store.redisClientCall('set', epochKey, randomUUID());
            repo.setMetrics({ lockLambdas: LockedLambdaReason.UNLOCKED });
        });
    } finally {
        (store as any).snapshotFence = undefined;
        if (fence) store.redisClientCall('snapshotRelease', fence);
        if (owner) lease.release(owner);
    }
}
