import { randomUUID } from 'node:crypto';
import { buildHolderInfo, getPaymentKeyHash, IndexNames, LockedLambdaReason, type StoredHandle, type UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import { HandlesRepository } from '../repositories/handlesRepository';
import { RedisHandlesStore } from '../stores/redis';
import { getApiCacheKey, getApiIndexRootKey, getApiLocalRepairEpochKey, getApiLocalRepairJournalKey, getApiMetricsKey, getApiMptRebuildPendingKey, getApiScannerLeaseKey, getApiScannerRecoveryKey } from '../stores/redis/keys';
import { repairPreflight, type RepairOutput, type RepairTarget } from './repairPreflight';
import { buildAndStoreMptRootHash } from './snapshotVerification';
import { createKoiosRepairReader } from './koiosRepairReader';
import { localRepairGate } from './localRepairReaderGate';
import { repairCommonAncestor, type RepairBlock } from './repairCommonAncestor';

interface Lease {
    acquire(owner: string): boolean;
    renew(owner: string): boolean;
    release(owner: string): void;
}
interface UndoImages {
    handles: StoredHandle[];
    utxos: { id: string; value: UTxOWithTxInfo | null }[];
    memberships: { index: IndexNames; key: string; member: string; present: boolean }[];
    utxoSlots: { id: string; score: number | null }[];
    orderedMembers: { index: IndexNames; member: string; score: number | null }[];
    mptRoot: string | null;
}
interface Journal { version: 1; targets: RepairTarget[]; oldIds: string[]; cursor: { hash: string; slot: number }; recoveryOutputs?: RepairOutput[]; undoImages?: UndoImages }
interface Fence { key: string; owner: string; scannerKey: string; scannerOwner: string; ownsScannerLease: boolean; undoLog?: string }

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
    afterFirstWrite?: () => Promise<void> | void,
    readAncestryBlock?: (hash: string) => Promise<RepairBlock | null>
): Promise<void> {
    if (process.env.API_TEST_MODE !== 'integration' || !process.env.API_TEST_VALKEY_RECEIPT || process.env.REDIS_HOST !== '127.0.0.1' || process.env.REDIS_PORT !== '6381' || process.env.NETWORK !== 'preview') {
        throw new Error('Local repair is restricted to the isolated preview test Valkey on 127.0.0.1:6381');
    }
    const repo = new HandlesRepository(store);
    const journalKey = getApiLocalRepairJournalKey();
    const epochKey = getApiLocalRepairEpochKey();
    const snapshotKey = getApiCacheKey('local-repair:lease');
    const progressKey = getApiCacheKey('local-repair:progress');
    const undoLog = getApiCacheKey('local-repair:experimental-undo-log');
    const pendingKey = getApiMptRebuildPendingKey();
    const scannerKey = getApiScannerLeaseKey();
    const rawJournal = store.redisClientCall('get', journalKey) as string | null;
    const journal: Journal | undefined = rawJournal ? JSON.parse(rawJournal) : undefined;
    if (!journal && store.redisClientCall('hget', undoLog, 'sequence') !== null) throw new Error('Orphan experimental undo log');
    if (journal && (journal.version !== 1 || !Array.isArray(journal.targets) || !Array.isArray(journal.oldIds) || (journal.recoveryOutputs !== undefined && !Array.isArray(journal.recoveryOutputs)) || (journal.undoImages !== undefined && (!Array.isArray(journal.undoImages.handles) || !Array.isArray(journal.undoImages.utxos) || !Array.isArray(journal.undoImages.memberships) || !Array.isArray(journal.undoImages.utxoSlots) || !Array.isArray(journal.undoImages.orderedMembers))) || !journal.cursor?.hash || !Number.isSafeInteger(journal.cursor.slot) || journal.cursor.slot <= 0)) throw new Error('Invalid repair journal');
    if (journal && targets && JSON.stringify(targets) !== JSON.stringify(journal.targets)) throw new Error('Another repair is pending');
    const selected = journal?.targets ?? targets;
    if (!selected) throw new Error('No repair journal or targets');
    let owner = '';
    let fence: Fence | undefined;
    let outputs: UTxOWithTxInfo[] = [];
    try {
        const preflightTargets = journal ? selected.map(target => {
            const handle = repo.getHandle(target.name);
            return target.storedHex && handle?.hex === target.hex ? { ...target, storedHex: target.hex } : target;
        }) : selected;
        const plan = await repairPreflight(preflightTargets, {
            acquire: value => { owner = value; return lease.acquire(value); },
            renew: lease.renew,
            // The executor retains the same lease through mutation and final validation.
            release: () => {}
        }, name => repo.getHandle(name), id => repo.getUTxO(id) ?? null, async requested => {
            outputs = await readCanonical(requested);
            return outputs;
        }, journal?.recoveryOutputs);
        if ((store.redisClientCall('get', journalKey) ?? null) !== (rawJournal ?? null)) throw new Error('Repair journal changed');
        const metrics = repo.getMetrics();
        const cursor = { hash: metrics.currentBlockHash ?? '', slot: Number(metrics.currentSlot) };
        if (!cursor.hash || !Number.isSafeInteger(cursor.slot) || cursor.slot <= 0) throw new Error('Invalid scanner cursor');
        if (journal && (journal.cursor.hash !== cursor.hash || journal.cursor.slot !== cursor.slot)) {
            if (readAncestryBlock) {
                const ancestor = await repairCommonAncestor(journal.cursor, cursor, readAncestryBlock);
                throw new Error(`Scanner cursor changed since repair began; common ancestry candidate ${ancestor.hash} at ${ancestor.slot}; canonicality and undo required`);
            }
            throw new Error('Scanner cursor changed since repair began');
        }
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
        if (localRepairGate(store, 'close', fence.owner, fence.scannerOwner) !== 1) throw new Error('Active repair readers');
        (store as any).snapshotFence = fence;
        const oldIds = [...new Set([...(journal?.oldIds ?? []), ...plan.sources.map(output => output.id)])];
        const recoveryOutputs = [...(journal?.recoveryOutputs ?? [])];
        for (const { id, address, handles } of outputs) {
            const recorded = recoveryOutputs.find(output => output.id === id);
            if (recorded && (recorded.address !== address || JSON.stringify(recorded.handles) !== JSON.stringify(handles))) throw new Error('Recorded repair output changed');
            if (!recorded) recoveryOutputs.push({ id, address, handles });
        }
        const undoImages: UndoImages | undefined = journal ? journal.undoImages : {
            handles: plan.stored,
            utxos: oldIds.map(id => ({ id, value: repo.getUTxO(id) ?? null })),
            memberships: [],
            utxoSlots: [],
            orderedMembers: [],
            mptRoot: new RedisHandlesStore().getMptRootHash() ?? null
        };
        if (undoImages) {
            const imageStore = new RedisHandlesStore();
            for (const id of [...oldIds, ...outputs.map(output => output.id)]) {
                if (!undoImages.utxoSlots.some(image => image.id === id)) {
                    const scores = imageStore.redisClientCall('zmscore', getApiIndexRootKey(IndexNames.UTXO_SLOT), [id]) as (number | null)[];
                    if (!Array.isArray(scores) || scores.length !== 1 || (scores[0] !== null && !Number.isFinite(Number(scores[0])))) throw new Error('Unable to capture UTxO-slot preimage');
                    undoImages.utxoSlots.push({ id, score: scores[0] === null ? null : Number(scores[0]) });
                }
            }
            for (const output of outputs) {
                if (!undoImages.utxos.some(image => image.id === output.id)) undoImages.utxos.push({ id: output.id, value: repo.getUTxO(output.id) ?? null });
            }
            for (const handle of plan.stored) {
                const target = selected.find(item => item.name === handle.name)!;
                const output = outputs.find(item => item.handles.some(([policy, assets]) => policy === target.policy && assets.includes(target.hex)))!;
                for (const [index, member] of [[IndexNames.SLOT, handle.name], [IndexNames.HOLDER_COUNT, handle.holder], [IndexNames.HOLDER_COUNT, buildHolderInfo(output.address).address]] as [IndexNames, string][]) {
                    if (!undoImages.orderedMembers.some(image => image.index === index && image.member === member)) {
                        const scores = imageStore.redisClientCall('zmscore', getApiIndexRootKey(index), [member]) as (number | null)[];
                        if (!Array.isArray(scores) || scores.length !== 1 || (scores[0] !== null && !Number.isFinite(Number(scores[0])))) throw new Error('Unable to capture ordered-index preimage');
                        undoImages.orderedMembers.push({ index, member, score: scores[0] === null ? null : Number(scores[0]) });
                    }
                }
                for (const [index, key] of [
                    [IndexNames.HOLDER, handle.holder], [IndexNames.HOLDER, buildHolderInfo(output.address).address],
                    [IndexNames.DEFAULT_HANDLE, handle.holder], [IndexNames.DEFAULT_HANDLE, buildHolderInfo(output.address).address],
                    [IndexNames.ADDRESS, handle.resolved_addresses.ada], [IndexNames.ADDRESS, output.address],
                    [IndexNames.PAYMENT_KEY_HASH, getPaymentKeyHash(handle.resolved_addresses.ada)], [IndexNames.PAYMENT_KEY_HASH, getPaymentKeyHash(output.address)],
                    [IndexNames.RARITY, handle.rarity], [IndexNames.CHARACTER, handle.characters], [IndexNames.NUMERIC_MODIFIER, handle.numeric_modifiers],
                    [IndexNames.LENGTH, String(handle.length)], [IndexNames.HANDLE_TYPE, handle.handle_type],
                    [IndexNames.OG, '0'], [IndexNames.OG, '1'], [IndexNames.PERSONALIZED, '0'], [IndexNames.PERSONALIZED, '1']
                ] as [IndexNames, string | undefined][]) {
                    if (key === undefined || key === null) throw new Error('Unable to capture repair index preimage');
                    if (!undoImages.memberships.some(image => image.index === index && image.key === key && image.member === handle.name)) {
                        undoImages.memberships.push({ index, key, member: handle.name, present: store.getValuesFromIndexedSet(index, key)?.has(handle.name) ?? false });
                    }
                }
            }
        }
        const nextJournal: Journal = { version: 1, targets: selected, oldIds, cursor, recoveryOutputs, undoImages };
        store.pipeline(() => {
            store.redisClientCall('set', journalKey, JSON.stringify(nextJournal));
            store.redisClientCall('set', epochKey, randomUUID());
            store.redisClientCall('set', pendingKey, '1');
            repo.setMetrics({ lockLambdas: LockedLambdaReason.REINDEX });
        });
        fence.undoLog = undoLog;
        repo.addUTxOsWithMintDataAndUpdateIndexes(outputs);
        await afterFirstWrite?.();
        const destinationIds = new Set(outputs.map(output => output.id));
        repo.removeUTxOs(oldIds.filter(id => !destinationIds.has(id)));
        await buildAndStoreMptRootHash(store);
        const final = await readCanonical(selected);
        if (JSON.stringify(final) !== JSON.stringify(outputs)) throw new Error('Canonical state changed during repair; recovery required');
        delete fence.undoLog;
        store.pipeline(() => {
            store.redisClientCall('del', [journalKey, pendingKey, undoLog]);
            store.redisClientCall('set', epochKey, randomUUID());
            repo.setMetrics({ lockLambdas: LockedLambdaReason.UNLOCKED });
        });
        (store as any).snapshotFence = undefined;
        if (localRepairGate(store, 'open', fence.owner, fence.scannerOwner) !== 1) throw new Error('Unable to open repair reader gate');
    } finally {
        (store as any).snapshotFence = undefined;
        if (fence) store.redisClientCall('snapshotRelease', fence);
        if (owner) lease.release(owner);
    }
}
