import { buildHolderInfo, getPaymentKeyHash, IndexNames, LockedLambdaReason, UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import { HandlesRepository } from '../repositories/handlesRepository';
import { RedisHandlesStore } from '../stores/redis';
import { getApiCacheKey, getApiIndexKey, getApiIndexRootKey, getApiMetricsKey, getApiMptRebuildPendingKey, getApiMptRootHashKey, getApiScannerLeaseKey, getApiScannerRecoveryKey } from '../stores/redis/keys';
import { buildAndStoreMptRootHash } from '../utils/snapshotVerification';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { GlideClient } from '@valkey/valkey-glide';
import http from 'node:http';
import express from 'express';
import request from 'supertest';
import { localRepairGuard } from '../utils/localRepairGuard';
import { localRepairGate, localRepairReaderAdmission } from '../utils/localRepairReaderGate';
import * as helpers from '../utils/helpers';
import { repairPreflight } from '../utils/repairPreflight';
import { localKoiosRepair, localRepair } from '../utils/localRepair';

jest.mock('../utils/helpers');
process.env.WHITELISTED_API_KEYS = 'scanner-e2e-key';

const scanner = require('./scanner');
const { lambdaHandler } = scanner;
const mockedHelpers = helpers as jest.Mocked<typeof helpers>;
const actualHelpers = jest.requireActual('../utils/helpers') as typeof helpers;

mockedHelpers.canonicalJsonStringify.mockImplementation(actualHelpers.canonicalJsonStringify);

const policy = 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a';
const handleHex = '000de140726f6c6c6261636b';
const knownAddress = 'addr_test1qzdzhdzf9ud8k2suzryvcdl78l3tfesnwp962vcuh99k8z834r3hjynmsy2cxpc04a6dkqxcsr29qfl7v9cmrd5mm89qfmc97q';
const knownHolder = 'stake_test1urc63cmezfacz9vrqu867axmqrvgp4zsyllxzud3k6danjsn0dn70';

const buildMintedUTxO = (handleName: string): UTxOWithTxInfo => {
    const mintedHandleHex = `000de140${Buffer.from(handleName).toString('hex')}`;
    return {
        id: 'scan_tx#0',
        tx_id: 'scan_tx',
        index: 0,
        blockHash: 'next_hash',
        blockNum: 123,
        slot: 101,
        address: knownAddress,
        lovelace: 1176630,
        handles: [[policy, [mintedHandleHex]]],
        mint: [[policy, [mintedHandleHex]]],
        burn: [],
        metadata: {
            '721': {
                [policy]: {
                    [mintedHandleHex]: {
                        name: `$${handleName}`,
                        image: 'ipfs://some-image',
                        mediaType: 'image/jpeg',
                        og: 0,
                        og_number: 0,
                        rarity: 'basic',
                        length: 9,
                        characters: 'letters',
                        numeric_modifiers: '',
                        version: 1
                    }
                }
            }
        }
    };
};

const buildTrackedUtxo = ({
    id = 'rollback_tx#0',
    tx_id = 'rollback_tx',
    slot = 100,
    blockHash = 'provider_block'
}: {
    id?: string;
    tx_id?: string;
    slot?: number;
    blockHash?: string;
} = {}): UTxOWithTxInfo =>
    ({
        id,
        tx_id,
        index: Number(id.split('#')[1] ?? 0),
        slot,
        address: knownAddress,
        lovelace: 1_000_000,
        handles: [[policy, [handleHex]]],
        mint: [[policy, [handleHex]]],
        metadata: {
            '721': {
                [policy]: {
                    [handleHex]: {
                        name: '$rollback',
                        image: 'ipfs://rollback',
                        mediaType: 'image/png',
                        og: 0,
                        og_number: 0,
                        rarity: 'basic',
                        length: 8,
                        characters: 'letters',
                        numeric_modifiers: '',
                        version: 1
                    }
                }
            }
        },
        blockHash,
        blockNum: 1000
    }) as UTxOWithTxInfo;

describe('Scanner lambda e2e', () => {
    const store = new RedisHandlesStore();
    const repo = new HandlesRepository(store);

    beforeAll(async () => {
        await repo.initialize();
    });

    afterAll(() => {
        repo.destroy();
    });

    beforeEach(() => {
        // Cache resets intentionally preserve control keys. Each case owns its recovery
        // fixture; a prior forced reindex failure must not select recovery in this case.
        store.redisClientCall('del', [getApiScannerRecoveryKey(), getApiCacheKey('local-repair:reader-gate'), getApiCacheKey('local-repair:readers'), getApiCacheKey('local-repair:experimental-undo-log')]);
        repo.rollBackToGenesis();
        repo.addUTxOsWithMintData([buildTrackedUtxo()]);
        repo.setMetrics({
            currentSlot: 140,
            lastSlot: 200,
            currentBlockHash: 'provider_block',
            tipBlockHash: 'provider_block',
            lastMaxRollbackCheck: Date.now(),
            utxoSchemaVersion: Number(store.getUTxOSchemaVersion()),
            indexSchemaVersion: Number(store.getIndexSchemaVersion()),
            lockLambdas: LockedLambdaReason.UNLOCKED
        });
        jest.clearAllMocks();
    });

    // A partial experimental batch must be undoable against real repository index keys.
    // Deleting the preimage-aware recovery makes the injected failure strand the owner changes.
    it.each([
        ['hash', "redis.call('HSET', KEYS[6], ARGV[4], ARGV[5])"],
        ['sets', "if ARGV[13] == 'absent' then redis.call('ZREM', KEYS[10], ARGV[12]) else redis.call('ZADD', KEYS[10], ARGV[13], ARGV[12]) end"]
    ])('recovers a partial experimental batch against repository indexes after %s', async (_phase, marker) => {
        const ownerMint = buildMintedUTxO('journal-owner');
        const siblingMint = buildMintedUTxO('journal-sibling');
        const first: UTxOWithTxInfo = {
            ...ownerMint, id: 'journal-shared#0', tx_id: 'journal-shared',
            handles: [[policy, [...ownerMint.handles[0][1], ...siblingMint.handles[0][1]]]],
            mint: [[policy, [...ownerMint.mint![0][1], ...siblingMint.mint![0][1]]]],
            metadata: { '721': { [policy]: { ...(ownerMint.metadata!['721'] as any)[policy], ...(siblingMint.metadata!['721'] as any)[policy] } } }
        };
        repo.addUTxOsWithMintDataAndUpdateIndexes([first]);
        const handle = repo.getHandle('journal-owner')!;
        const siblingBefore = repo.getHandle('journal-sibling');
        const root = await buildAndStoreMptRootHash(store);
        const metrics = repo.getMetrics();
        const control = ['repair', 'scanner', 'gate', 'readers', 'journal', 'pending', 'sibling-journal'].map(key => getApiCacheKey(`experimental-repository:${key}:${randomUUID()}`));
        const keys = [...control.slice(0, 5), getApiIndexKey(IndexNames.HANDLE, handle.name), getApiIndexKey(IndexNames.HOLDER, handle.holder),
            getApiIndexKey(IndexNames.ADDRESS, first.address), getApiIndexKey(IndexNames.PAYMENT_KEY_HASH, getPaymentKeyHash(first.address)!),
            getApiIndexRootKey(IndexNames.UTXO_SLOT), control[5], getApiMetricsKey()];
        const child = spawnSync(process.execPath, ['--input-type=module', '-e', "import {readerGate,apply,undo} from './workers/experimentalMultiIndexJournal.mjs'; process.stdout.write(JSON.stringify({readerGate,apply,undo}))"], { encoding: 'utf8' });
        expect({ status: child.status, stderr: child.stderr }).toEqual({ status: 0, stderr: '' });
        const scripts = JSON.parse(child.stdout) as { readerGate: string; apply: string; undo: string };
        const owners = ['repair-owner', 'scanner-owner', 'gate-owner'];
        const evalScript = (script: string, args: string[]) => store.redisClientCall('customCommand', ['EVAL', script, `${keys.length}`, ...keys, ...args]);
        try {
            store.redisClientCall('customCommand', ['SET', control[0], owners[0], 'PX', '120000']);
            store.redisClientCall('customCommand', ['SET', control[1], owners[1], 'PX', '120000']);
            expect(evalScript(scripts.readerGate, ['admit', 'active-reader'])).toBe(1);
            expect(evalScript(scripts.readerGate, ['close', ...owners])).toBe(1);
            const injected = scripts.apply.replace(marker, `${marker}; error('injected repository failure')`);
            expect(injected).not.toBe(scripts.apply);
            const args = [...owners, 'utxo', 'wrong#0', handle.name, '0', handle.name, '0', handle.name, '0', first.id, 'absent'];
            expect(() => evalScript(scripts.apply, args)).toThrow('READERS_ACTIVE');
            expect(repo.getHandle(handle.name)).toEqual(handle);
            expect(evalScript(scripts.readerGate, ['release', 'active-reader'])).toBe(1);
            expect(() => evalScript(injected, args)).toThrow('injected repository failure');
            expect(repo.getHandle(handle.name)?.utxo).toBe('wrong#0');
            expect(evalScript(scripts.readerGate, ['admit', 'late-reader'])).toBe(0);
            expect(evalScript(scripts.undo, [...owners, 'partial'])).toBe(1);
            expect(repo.getHandle(handle.name)).toEqual(handle);
            expect(repo.getHandle('journal-sibling')).toEqual(siblingBefore);
            expect(store.getValuesFromIndexedSet(IndexNames.HOLDER, handle.holder)?.has(handle.name)).toBe(true);
            expect(store.getValuesFromIndexedSet(IndexNames.HOLDER, handle.holder)?.has('journal-sibling')).toBe(true);
            expect(store.getValuesFromIndexedSet(IndexNames.ADDRESS, first.address)?.has(handle.name)).toBe(true);
            expect(store.getValuesFromIndexedSet(IndexNames.PAYMENT_KEY_HASH, getPaymentKeyHash(first.address)!)?.has(handle.name)).toBe(true);
            expect(store.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, first.slot)).toContain(first.id);
            expect(repo.getUTxO(first.id)?.handles).toEqual(first.handles);
            expect(repo.getHandle('journal-sibling')?.utxo).toBe(first.id);
            expect(store.getMptRootHash()).toBe(root);
            expect(repo.getMetrics()).toEqual(expect.objectContaining({ currentSlot: metrics.currentSlot, currentBlockHash: metrics.currentBlockHash }));

            // Both shared-output owners need separate journals. Recover in reverse order:
            // the second journal's preimage includes the first write's removed slot member.
            const siblingKeys = [...keys];
            siblingKeys[4] = control[6];
            siblingKeys[5] = getApiIndexKey(IndexNames.HANDLE, 'journal-sibling');
            const siblingArgs = [...owners, 'utxo', 'wrong-sibling#0', 'journal-sibling', '0', 'journal-sibling', '0', 'journal-sibling', '0', first.id, 'absent'];
            const evalSibling = (script: string, args: string[]) => store.redisClientCall('customCommand', ['EVAL', script, `${siblingKeys.length}`, ...siblingKeys, ...args]);
            expect(evalScript(scripts.apply, args)).toBe(1);
            expect(() => evalSibling(injected, siblingArgs)).toThrow('injected repository failure');
            expect(repo.getHandle('journal-sibling')?.utxo).toBe('wrong-sibling#0');
            expect(evalSibling(scripts.undo, [...owners, 'partial'])).toBe(1);
            expect(evalSibling(scripts.readerGate, ['open', ...owners])).toBe(0);
            expect(evalSibling(scripts.readerGate, ['admit', 'late-reader'])).toBe(0);
            expect(evalScript(scripts.undo, owners)).toBe(1);
            expect(repo.getHandle(handle.name)).toEqual(handle);
            expect(repo.getHandle('journal-sibling')).toEqual(siblingBefore);
            expect(repo.getUTxO(first.id)?.handles).toEqual(first.handles);
            expect(store.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, first.slot)).toContain(first.id);
            for (const name of [handle.name, 'journal-sibling']) {
                expect(store.getValuesFromIndexedSet(IndexNames.HOLDER, handle.holder)?.has(name)).toBe(true);
                expect(store.getValuesFromIndexedSet(IndexNames.ADDRESS, first.address)?.has(name)).toBe(true);
                expect(store.getValuesFromIndexedSet(IndexNames.PAYMENT_KEY_HASH, getPaymentKeyHash(first.address)!)?.has(name)).toBe(true);
            }
            expect(store.getMptRootHash()).toBe(root);
            expect(repo.getMetrics()).toEqual(expect.objectContaining({ currentSlot: metrics.currentSlot, currentBlockHash: metrics.currentBlockHash }));
            expect(evalScript(scripts.readerGate, ['open', ...owners])).toBe(1);
        } finally {
            store.redisClientCall('del', control);
        }
    });

    // The repository itself must move every owner of a shared output and its indexes.
    // Removing index updates or leaving the old UTxO makes these observable checks fail.
    // Captured batch keys identify the real mutation scope; they are not a recovery journal.
    it('traces actual repository writes for a shared-output transfer', () => {
        const a = buildMintedUTxO('trace-owner-a');
        const b = buildMintedUTxO('trace-owner-b');
        const old: UTxOWithTxInfo = {
            ...a, id: 'trace-old#0', tx_id: 'trace-old',
            handles: [[policy, [...a.handles[0][1], ...b.handles[0][1]]]],
            mint: [[policy, [...a.mint![0][1], ...b.mint![0][1]]]],
            metadata: { '721': { [policy]: { ...(a.metadata!['721'] as any)[policy], ...(b.metadata!['721'] as any)[policy] } } }
        };
        repo.addUTxOsWithMintDataAndUpdateIndexes([old]);
        const oldHandle = repo.getHandle('trace-owner-a')!;
        const address = 'addr_test1qz8zyhdetz270qzfvkym38wx4wsqzx0m49urfu3wjkqsuchs8t4235v9t0x5grxm2hel388ypz0q3fng8k6am5hqzacq0fc746';
        const moved: UTxOWithTxInfo = { ...old, id: 'trace-new#0', tx_id: 'trace-new', slot: 120, address, mint: [], metadata: undefined };
        const calls = jest.spyOn(store, 'redisClientCall');
        try {
            repo.addUTxOsWithMintDataAndUpdateIndexes([moved]);
            repo.removeUTxOs([old.id]);
            const newHandle = repo.getHandle('trace-owner-a')!;
            for (const name of ['trace-owner-a', 'trace-owner-b']) {
                expect(repo.getHandle(name)).toEqual(expect.objectContaining({ utxo: moved.id, resolved_addresses: expect.objectContaining({ ada: address }) }));
                expect(store.getValuesFromIndexedSet(IndexNames.ADDRESS, address)?.has(name)).toBe(true);
                expect(store.getValuesFromIndexedSet(IndexNames.ADDRESS, old.address)?.has(name) ?? false).toBe(false);
                expect(store.getValuesFromIndexedSet(IndexNames.HOLDER, newHandle.holder)?.has(name)).toBe(true);
                expect(store.getValuesFromIndexedSet(IndexNames.HOLDER, oldHandle.holder)?.has(name) ?? false).toBe(false);
                expect(store.getValuesFromIndexedSet(IndexNames.PAYMENT_KEY_HASH, getPaymentKeyHash(address)!)?.has(name)).toBe(true);
                expect(store.getValuesFromIndexedSet(IndexNames.PAYMENT_KEY_HASH, getPaymentKeyHash(old.address)!)?.has(name) ?? false).toBe(false);
            }
            expect(repo.getUTxO(old.id) ?? null).toBeNull();
            expect(repo.getUTxO(moved.id)?.handles).toEqual(moved.handles);
            expect(store.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, moved.slot)).toContain(moved.id);
            expect(store.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, 0) ?? []).not.toContain(old.id);
            const commands = calls.mock.calls.filter(([method]) => method === 'batch').flatMap(([, batch]) => batch as [string, any[]][]);
            const serialized = JSON.stringify(commands);
            for (const key of [getApiIndexKey(IndexNames.HANDLE, 'trace-owner-a'), getApiIndexKey(IndexNames.HANDLE, 'trace-owner-b'),
                getApiIndexKey(IndexNames.UTXO, old.id), getApiIndexKey(IndexNames.UTXO, moved.id), getApiIndexRootKey(IndexNames.UTXO_SLOT),
                getApiIndexKey(IndexNames.ADDRESS, address), getApiIndexKey(IndexNames.PAYMENT_KEY_HASH, getPaymentKeyHash(address)!)]) {
                expect(serialized).toContain(key);
            }
        } finally { calls.mockRestore(); }
    });

    it('exits before the Fn cap without advancing an unprocessed block, then resumes it', async () => {
        // Invariant: a scheduled scan leaves a resumable cursor and releases its lock before Fn's 300s cap.
        // Failure caught: the 720s software deadline cannot fire before Fn kills the call.
        // Negative control: restore the fixed 720s handler deadline; the first cursor assertion fails.
        const previousDefer = process.env.KORA_SCANNER_DEFER_IMPORTS;
        process.env.KORA_SCANNER_DEFER_IMPORTS = 'true';
        let now = Date.now();
        const clock = jest.spyOn(Date, 'now').mockImplementation(() => now);
        mockedHelpers.blockfrostApiCall.mockResolvedValue({ ok: true, json: async () => ({ height: 5000, slot: 220, hash: 'tip_hash' }) } as never);
        mockedHelpers.fetchPaginatedResults.mockImplementation(async (path: string) => {
            if (path === 'blocks/provider_block/next') {
                now += 240_001;
                return [{ hash: 'budget_block', slot: 201, confirmations: 21, tx_count: 0 }] as never;
            }
            return [] as never;
        });
        mockedHelpers.fetchKoios.mockResolvedValue([] as never);
        mockedHelpers.buildUTxOsFromKoiosTxs.mockImplementation(actualHelpers.buildUTxOsFromKoiosTxs);
        try {
            await lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context);
            expect(repo.getMetrics()).toEqual(expect.objectContaining({
                currentSlot: 140, currentBlockHash: 'provider_block', lockLambdas: LockedLambdaReason.UNLOCKED
            }));
            expect([...store.getScannedBlockHashesInRange(201, 201)]).toEqual([]);

            mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'budget_block', slot: 201, confirmations: 21, tx_count: 0 }] as never);
            await lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context);
            expect(repo.getMetrics()).toEqual(expect.objectContaining({
                currentSlot: 201, currentBlockHash: 'budget_block', lockLambdas: LockedLambdaReason.UNLOCKED
            }));
            expect([...store.getScannedBlockHashesInRange(201, 201)]).toEqual(['budget_block']);
        } finally {
            clock.mockRestore();
            if (previousDefer === undefined) delete process.env.KORA_SCANNER_DEFER_IMPORTS;
            else process.env.KORA_SCANNER_DEFER_IMPORTS = previousDefer;
        }
    });

    it('preserves the index when the invocation has no work time left', async () => {
        // Invariant: an invocation inside its cleanup reserve must not begin scanning.
        // Failure caught: ignoring a short context starts provider work and advances the cursor.
        // Negative control: ignore remainingTimeMs in scannerBudgetMs; the cursor advances to 201.
        mockedHelpers.blockfrostApiCall.mockResolvedValue({ ok: true, json: async () => ({ height: 5000, slot: 220, hash: 'tip_hash' }) } as never);
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'budget_block', slot: 201, confirmations: 21, tx_count: 0 }] as never);
        mockedHelpers.fetchKoios.mockResolvedValue([] as never);
        mockedHelpers.buildUTxOsFromKoiosTxs.mockImplementation(actualHelpers.buildUTxOsFromKoiosTxs);
        const before = repo.getMetrics();
        const existingUtxo = repo.getUTxO('rollback_tx#0');
        await lambdaHandler({} as AWSLambda.ALBEvent, { getRemainingTimeInMillis: () => 60_000 } as AWSLambda.Context);
        expect(repo.getMetrics()).toEqual(before);
        expect(repo.getUTxO('rollback_tx#0')).toEqual(existingUtxo);
        expect([...store.getScannedBlockHashesInRange(201, 201)]).toEqual([]);
    });

    it('keeps the persisted cursor and handle when a discovered transaction is assigned to another block', async () => {
        // Invariant: an incomplete block must not alter the durable cursor or indexed owner.
        // Without per-block transaction coverage, the cursor advances and the stored scan ledger records the block.
        mockedHelpers.blockfrostApiCall.mockResolvedValue({ ok: true, json: async () => ({ height: 5000, slot: 220, hash: 'tip_hash' }) } as never);
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'next_hash', slot: 201, confirmations: 21, tx_count: 1 }] as never);
        mockedHelpers.fetchKoios.mockImplementation(async (path: string) => {
            if (path === 'block_txs') return [{ block_hash: 'next_hash', tx_hash: 'tx_1' }] as never;
            if (path === 'tx_info') return [{ tx_hash: 'tx_1', block_hash: 'other_hash', inputs: [], outputs: [], assets_minted: [] }] as never;
            return [] as never;
        });
        const oldHandle = repo.getHandle('rollback');
        await lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context);
        expect(repo.getMetrics()).toEqual(expect.objectContaining({ currentSlot: 140, currentBlockHash: 'provider_block', lockLambdas: LockedLambdaReason.UNLOCKED }));
        expect([...store.getScannedBlockHashesInRange(201, 201)]).toEqual([]);
        expect(repo.getHandle('rollback')).toEqual(oldHandle);
    });

    it('scans block updates and persists handle + metrics', async () => {
        const handleName = `scanner-${Date.now()}`;

        mockedHelpers.blockfrostApiCall.mockResolvedValue({ ok: true, json: async () => ({ height: 5000 }) } as never);
        mockedHelpers.fetchPaginatedResults.mockImplementation(async (path: string) =>
            (path === 'blocks/provider_block/next' ? [{ hash: 'next_hash', slot: 101, confirmations: 21, tx_count: 1 }] : []) as never);
        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([buildMintedUTxO(handleName)]);
        mockedHelpers.fetchKoios.mockImplementation(async (path: string) => {
            if (path === 'block_txs') return [{ block_hash: 'next_hash', tx_hash: 'scan_tx' }] as never;
            if (path === 'tx_info') return [{ tx_hash: 'scan_tx', block_hash: 'next_hash', inputs: [] }] as never;
            return [] as never;
        });

        const result = await lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context);

        expect(result).toEqual({ isBase64Encoded: false, statusCode: 200, body: '' });
        const handle = repo.getHandle(handleName);
        expect(handle).toEqual(
            expect.objectContaining({
                name: handleName,
                utxo: 'scan_tx#0',
                image: 'ipfs://some-image',
                policy,
                has_datum: false
            })
        );
        const indexedHandles = store.getValuesFromIndexedSet(IndexNames.HOLDER, handle!.holder) as Set<string>;
        expect(indexedHandles.has(handleName)).toBe(true);
        expect(repo.getMetrics().currentSlot).toBeGreaterThanOrEqual(101);
    });

    it('retries tx_info when Koios returns a PGRST003 pool timeout response object', async () => {
        const handleName = `scanner-pgrst-${Date.now()}`;
        let txInfoAttempts = 0;

        mockedHelpers.blockfrostApiCall.mockResolvedValue({ ok: true, json: async () => ({ height: 5000 }) } as never);
        mockedHelpers.fetchPaginatedResults
            .mockResolvedValueOnce([{ hash: 'next_hash', slot: 101, confirmations: 21, tx_count: 1 }] as never)
            .mockResolvedValueOnce([] as never);
        mockedHelpers.fetchKoios.mockImplementation(async (path: string) => {
            if (path === 'block_txs') return [{ block_hash: 'next_hash', tx_hash: 'scan_tx' }] as never;
            if (path === 'tx_info') {
                txInfoAttempts++;
                if (txInfoAttempts === 1) {
                    return {
                        code: 'PGRST003',
                        details: null,
                        hint: null,
                        message: 'Timed out acquiring connection from connection pool.'
                    } as never;
                }
                return [{ tx_hash: 'scan_tx', block_hash: 'next_hash', inputs: [] }] as never;
            }
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([buildMintedUTxO(handleName)]);

        const result = await lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context);

        expect(result).toEqual({ isBase64Encoded: false, statusCode: 200, body: '' });
        expect(txInfoAttempts).toBe(2);
        expect(repo.getHandle(handleName)).toEqual(expect.objectContaining({ name: handleName, utxo: 'scan_tx#0' }));
    });

    it('recovers immediately when a reindex lock is stale', async () => {
        repo.setMetrics({
            lockLambdas: LockedLambdaReason.REINDEX,
            lockLambdasTimestamp: Date.now() - 11 * 60 * 1000
        });

        const result = await lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context);

        expect(result).toBeUndefined();
        const finalMetrics = repo.getMetrics();
        expect(finalMetrics.lockLambdas).toBe(LockedLambdaReason.UNLOCKED);
    });

    it('successfully reindexes and completes unlocked when schema version is behind', async () => {
        repo.setMetrics({ indexSchemaVersion: 0, lockLambdas: LockedLambdaReason.UNLOCKED });

        const result = await lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context);

        expect(result).toBeUndefined();
        const finalMetrics = repo.getMetrics();
        expect(finalMetrics.lockLambdas).toBe(LockedLambdaReason.UNLOCKED);
        expect(finalMetrics.indexSchemaVersion).toBeDefined();
    });

    it('runs recovery reindex when recovery flag is set', async () => {
        store.redisClientCall('set', getApiScannerRecoveryKey(), 'reindex');
        repo.setMetrics({
            lockLambdas: LockedLambdaReason.UNLOCKED,
            indexSchemaVersion: Number(store.getIndexSchemaVersion()),
            currentBlockHash: 'provider_block',
            currentSlot: 140
        });

        const result = await lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context);

        expect(result).toBeUndefined();
        expect(store.redisClientCall('get', getApiScannerRecoveryKey())).toBeFalsy();
    });

    it('requires whitelisted api-key for function-url reindex shortcut', async () => {
        const result = await lambdaHandler({
            requestContext: { http: { method: 'POST', path: '/reindex' } },
            headers: { 'api-key': 'wrong-key' }
        } as any, {} as AWSLambda.Context);

        expect(result).toEqual(
            expect.objectContaining({
                statusCode: 401,
                body: JSON.stringify({ message: 'Unauthorized' })
            })
        );
    });

    it('unlocks lambdas when reindexing fails', async () => {
        repo.setMetrics({ indexSchemaVersion: 0, lockLambdas: LockedLambdaReason.UNLOCKED });
        const repopulateSpy = jest.spyOn(RedisHandlesStore.prototype, 'repopulateIndexesFromUTxOs').mockImplementation(() => {
            throw new Error('forced failure');
        });

        await expect(lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context)).rejects.toThrow('forced failure');

        expect(repo.getMetrics().lockLambdas).toBe(LockedLambdaReason.UNLOCKED);
        repopulateSpy.mockRestore();
    });

    // Postmerge69ac/run38542623382 failed here on a three-argument mock assertion after
    // admission gained a fourth argument, before checking persisted state. The contract
    // survives: canonical ownership/UTxOs must remain intact and the lock must release.
    // Negative control: delete the tracked UTxO in the real no-repair scanner branch;
    // the persisted UTxO/ownership assertions fail, independently of helper call shape.
    it('keeps lock healthy and skips rollback replay when hashes match', async () => {
        repo.addUTxOsWithMintDataAndUpdateIndexes([buildTrackedUtxo()]);
        repo.setMetrics({ currentSlot: 100, lastSlot: 100, tipBlockHash: 'provider_block' });
        store.recordScannedBlock(20, 'older_scanned_block');
        const initialUtxo = repo.getUTxO('rollback_tx#0');
        const initialHandle = repo.getHandle('rollback')!;
        const methods = ['blockfrostApiCall', 'fetchPaginatedResults', 'fetchKoios', 'buildUTxOsFromKoiosTxs'] as const;
        const previous = methods.map((name) => helpers[name]);
        methods.forEach((name) => Object.defineProperty(helpers, name, { configurable: true, writable: true, value: actualHelpers[name] }));
        const requests: { path: string; method: string; body: unknown }[] = [];
        const unexpectedRequests: string[] = [];
        const asset = { policy_id: policy, asset_name: handleHex, quantity: '1', decimals: 0, fingerprint: 'fixture' };
        const fetchSpy = jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
            const url = new URL(String(input));
            const body = init?.body ? JSON.parse(String(init.body)) : null;
            requests.push({ path: url.pathname, method: init?.method ?? 'GET', body });
            let result: unknown;
            if (url.hostname.endsWith('.blockfrost.io')) {
                if (url.pathname === '/api/v0/blocks/latest') result = { height: 1000, slot: 100, hash: 'provider_block' };
                else if (url.pathname === '/api/v0/blocks/provider_block/next') result = [];
                else if (url.pathname === '/api/v0/blocks/980/next') result = [{ hash: 'provider_block', slot: 100, height: 1000 }];
            } else if (url.hostname.endsWith('.koios.rest')) {
                if (url.pathname === '/api/v1/block_txs') result = [{ block_hash: 'provider_block', tx_hash: 'rollback_tx' }];
                else if (url.pathname === '/api/v1/tx_info') result = [{
                    tx_hash: 'rollback_tx', block_hash: 'provider_block', block_height: 1000, absolute_slot: 100,
                    inputs: [], reference_inputs: [], assets_minted: [asset], metadata: buildTrackedUtxo().metadata,
                    outputs: [{ tx_hash: 'rollback_tx', tx_index: 0, value: '1000000', payment_addr: { bech32: knownAddress, cred: '' },
                        asset_list: [asset], datum_hash: null, stake_addr: null, inline_datum: null, reference_script: null }]
                }];
                else if (url.pathname === '/api/v1/asset_utxos') result = [{ tx_hash: 'rollback_tx', tx_index: 0, asset_list: [asset] }];
            }
            if (result === undefined) {
                unexpectedRequests.push(url.href);
                throw new Error(`Unexpected fixture HTTP request: ${url.href}`);
            }
            return new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } });
        });
        try {
            await lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context);
            const persistedStore = new RedisHandlesStore();
            const persistedRepo = await new HandlesRepository(persistedStore).initialize();
            expect(persistedRepo.getMetrics()).toEqual(expect.objectContaining({
                lockLambdas: LockedLambdaReason.UNLOCKED, currentBlockHash: 'provider_block', currentSlot: 100,
                lastSlot: 100, tipBlockHash: 'provider_block'
            }));
            expect(persistedRepo.getUTxO('rollback_tx#0')).toEqual(initialUtxo);
            expect(persistedRepo.getHandle('rollback')).toEqual(initialHandle);
            expect(persistedRepo.getHandle('rollback')).toEqual(expect.objectContaining({ utxo: 'rollback_tx#0', holder: knownHolder, resolved_addresses: { ada: knownAddress }, policy }));
            expect(persistedStore.getValuesFromIndexedSet(IndexNames.HOLDER, knownHolder)).toEqual(new Set(['rollback']));
            expect(persistedStore.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, 0)).toEqual(['rollback_tx#0']);
            expect(persistedStore.listAllScannedBlocks()).toEqual([{ slot: 20, hash: 'older_scanned_block' }]);
            expect(unexpectedRequests).toEqual([]);
            expect(requests.filter((r) => r.path === '/api/v1/block_txs')).toEqual([
                { path: '/api/v1/block_txs', method: 'POST', body: { _block_hashes: ['provider_block'] } }
            ]);
            expect(requests.filter((r) => r.path === '/api/v1/asset_utxos').map((r) => r.body)).toEqual([
                { _asset_list: [[policy, handleHex], [policy, `000643b0${handleHex.slice(8)}`], [policy, `00001070${handleHex.slice(8)}`]], _extended: true }
            ]);
        } finally {
            fetchSpy.mockRestore();
            methods.forEach((name, index) => Object.defineProperty(helpers, name, { configurable: true, writable: true, value: previous[index] }));
        }
    });

    it('replays divergent rollback blocks and updates handle ownership state', async () => {
        repo.rollBackToGenesis();
        repo.addUTxOsWithMintDataAndUpdateIndexes([buildTrackedUtxo({ id: 'stale_tx#0', tx_id: 'stale_tx', blockHash: 'api_block' })]);
        repo.setMetrics({
            currentSlot: 140,
            currentBlockHash: 'api_block',
            lastMaxRollbackCheck: Date.now(),
            utxoSchemaVersion: Number(store.getUTxOSchemaVersion()),
            indexSchemaVersion: Number(store.getIndexSchemaVersion()),
            lockLambdas: LockedLambdaReason.UNLOCKED
        });

        mockedHelpers.blockfrostApiCall.mockResolvedValue({ ok: true, json: async () => ({ height: 5000 }) } as never);
        mockedHelpers.fetchPaginatedResults
            .mockResolvedValueOnce([] as never)
            .mockResolvedValueOnce([{ hash: 'provider_block', slot: 100 }] as never);
        mockedHelpers.fetchKoios.mockImplementation(async (path: string) => {
            if (path === 'block_txs') return [{ tx_hash: 'replay_tx' }] as never;
            if (path === 'asset_utxos') return [{ tx_hash: 'replay_tx' }] as never;
            if (path === 'tx_info') return [{ source: 'tx_info' }] as never;
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockImplementation((txs: any[]) => {
            if (txs?.[0]?.source === 'tx_info') {
                return [buildTrackedUtxo({ id: 'replay_tx#0', tx_id: 'replay_tx', slot: 101, blockHash: 'provider_block' })] as never;
            }
            return [] as never;
        });

        await lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context);

        expect(repo.getUTxO('stale_tx#0')).toBeUndefined();
        expect(repo.getUTxO('replay_tx#0')).toEqual(expect.objectContaining({ tx_id: 'replay_tx' }));
        expect(repo.getHandle('rollback')?.utxo).toBe('replay_tx#0');
        expect(repo.getMetrics().lockLambdas).toBe(LockedLambdaReason.UNLOCKED);
    });

    it('clears lock and falls back to Koios tip when Blockfrost latest fails', async () => {
        mockedHelpers.blockfrostApiCall.mockResolvedValue({ ok: false } as never);
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([] as never);
        mockedHelpers.fetchKoios.mockImplementation(async (path: string) => {
            if (path === 'tip') return [{ hash: 'koios_tip_hash', abs_slot: 140, block_height: 5000 }] as never;
            return [] as never;
        });

        await expect(lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context)).resolves.toEqual({ isBase64Encoded: false, statusCode: 200, body: '' });

        expect(repo.getMetrics().lockLambdas).toBe(LockedLambdaReason.UNLOCKED);
        expect(repo.getMetrics().tipBlockHash).toBe('koios_tip_hash');
    });

    // A block's handle state is its NET effect. Chained txs land in one block (migrate-then-burn, prep +
    // personalize), so a handle can be moved by tx A and burned by tx B in the same block. The scanner
    // applied the burn, then indexed A's output (already spent by B) and resurrected the burned handle.
    // Observed live on preview 2026-09-29 (sub8fc3ns1a@e2e6ge6zr1qz2ag, e2e08lr00jmyr@e2e08lhsm2uaq).
    describe('intra-block chains', () => {
        const { Internal } = require('./scanner.app');
        const hexOf = (name: string) => `000de140${Buffer.from(name).toString('hex')}`;
        const utxo = (id: string, name: string, slot: number, minted: boolean): UTxOWithTxInfo => ({
            ...buildMintedUTxO(name),
            id,
            tx_id: id.split('#')[0],
            index: Number(id.split('#')[1]),
            slot,
            mint: minted ? [[policy, [hexOf(name)]]] : []
        });
        const tx = (hash: string, inputs: string[], burned: string[] = []) => ({
            tx_hash: hash,
            inputs: inputs.map((i) => ({ tx_hash: i.split('#')[0], tx_index: Number(i.split('#')[1]) })),
            assets_minted: burned.map((name) => ({ policy_id: policy, asset_name: hexOf(name), quantity: '-1' }))
        });
        const block = { id: 'intra_block', slot: 150 };
        const tip = { hash: 'tip', slot: 200 };

        it('moves both legacy handles from separate listings into one wallet output', () => {
            // Invariant: one transaction moving multiple legacy handles updates every owner and UTxO.
            // If either asset is dropped during conversion or indexing, its old listing remains visible.
            const names = ['xn--8o8hx2f', 'xn--kong-tz14c'];
            const assets = names.map((name) => Buffer.from(name).toString('hex'));
            for (let i = 0; i < names.length; i++) {
                repo.addUTxOsWithMintDataAndUpdateIndexes([{ ...utxo(`old${i}#0`, names[i], 90, true), handles: [[policy, [assets[i]]]], mint: [[policy, [assets[i]]]] }]);
            }
            const owner = 'addr_test1qz8zyhdetz270qzfvkym38wx4wsqzx0m49urfu3wjkqsuchs8t4235v9t0x5grxm2hel388ypz0q3fng8k6am5hqzacq0fc746';
            mockedHelpers.buildUTxOsFromKoiosTxs.mockImplementation(actualHelpers.buildUTxOsFromKoiosTxs);
            Internal.processScannerBlock(block, [{
                tx_hash: 'cancel', block_hash: block.id, block_height: 123, absolute_slot: block.slot,
                inputs: [{ tx_hash: 'old0', tx_index: 0 }, { tx_hash: 'old1', tx_index: 0 }],
                assets_minted: [], metadata: {}, outputs: [{ tx_hash: 'cancel', tx_index: 0, value: '2000000',
                    payment_addr: { bech32: owner }, asset_list: assets.map((asset_name) => ({ policy_id: policy, asset_name, quantity: '1' })) }]
            }] as never, tip);
            for (const name of names) {
                expect(repo.getHandle(name)).toEqual(expect.objectContaining({ utxo: 'cancel#0', resolved_addresses: expect.objectContaining({ ada: owner }) }));
            }
            expect(repo.getUTxO('old0#0') ?? null).toBeNull();
            expect(repo.getUTxO('old1#0') ?? null).toBeNull();
        });

        // A normal upgrade burns the legacy token before minting the owner and reference tokens.
        // The amount=2 case deliberately seeds an inconsistent pre-existing count: the burn then
        // leaves the old record alive, so removing the hex assignment reproduces a stale identity.
        // This is a hypothesis for the observed records, not evidence of their historical counts.
        // Transaction IDs/output order are real; addresses and datum are safe local fixtures.
        it.each([
            ['epickifer', '0ba4a2d182104e91388b33338c0308531f2f554fa759bdf79967836f2d9420c1', 1],
            ['seniorsolutions', 'd91b54ac42eb985ba8747798ca6ef4a831f58ef684053c591782f259e204feaa', 1],
            ['shaynasmeltzer', '3c86178f3fb91ee07ba73cb6860a36ed4df2464f463d8b847b214892f894f6cc', 1],
            ['epickifer', '0ba4a2d182104e91388b33338c0308531f2f554fa759bdf79967836f2d9420c1', 2]
        ])('indexes burn-and-mint for $%s tx=%s with stored amount %i', (name, txHash, priorAmount) => {
            const legacy = Buffer.from(name).toString('hex');
            const owner222 = `000de140${legacy}`;
            const reference100 = `000643b0${legacy}`;
            const old = { ...utxo('legacy-migration#0', name, 90, true), handles: [[policy, [legacy]]] as [string, string[]][], mint: [[policy, [legacy]]] as [string, string[]][] };
            repo.addUTxOsWithMintDataAndUpdateIndexes([old]);
            const before = store.getHashFromIndex(IndexNames.HANDLE, name) as any;
            store.setHashOnIndex(IndexNames.HANDLE, name, { ...before, amount: priorAmount, image: 'ipfs://legacy-record-only' });
            const newAddress = 'addr_test1qz8zyhdetz270qzfvkym38wx4wsqzx0m49urfu3wjkqsuchs8t4235v9t0x5grxm2hel388ypz0q3fng8k6am5hqzacq0fc746';
            const datum = readFileSync('tests/fixtures/reference-datum.cbor.hex', 'utf8').trim();
            const asset = (asset_name: string, quantity = '1') => ({ policy_id: policy, asset_name, quantity });
            const output = (tx_index: number, asset_name: string, inline_datum: any) => ({ tx_hash: txHash, tx_index, value: '2000000', payment_addr: { bech32: newAddress }, asset_list: [asset(asset_name)], inline_datum, datum_hash: null, reference_script: null });
            const txInfo = { tx_hash: txHash, block_hash: block.id, block_height: 123, absolute_slot: 150, inputs: [{ tx_hash: 'legacy-migration', tx_index: 0 }], assets_minted: [asset(legacy, '-1'), asset(owner222), asset(reference100)], outputs: [output(0, owner222, null), output(1, reference100, { bytes: datum })], metadata: { '721': { [policy]: { [owner222]: { name: `$${name}`, image: 'ipfs://new-owner-mint', version: 1 } } } } };
            mockedHelpers.buildUTxOsFromKoiosTxs.mockImplementation(actualHelpers.buildUTxOsFromKoiosTxs);
            Internal.processScannerBlock(block, [txInfo] as never, tip);
            const result = repo.getHandle(name)!;
            expect(result).toEqual(expect.objectContaining({ name, amount: 1, hex: owner222, utxo: `${txHash}#0`, reference_utxo: `${txHash}#1`, resolved_addresses: expect.objectContaining({ ada: newAddress }) }));
            if (priorAmount === 1) expect(result.image).not.toBe('ipfs://legacy-record-only');
            expect(repo.getHandleByHex(legacy)).toBeNull();
            expect(repo.getHandleByHex(owner222)?.utxo).toBe(`${txHash}#0`);
            expect(repo.getUTxO('legacy-migration#0') ?? null).toBeNull();
            expect(repo.getUTxO(`${txHash}#0`)?.handles).toEqual([[policy, [owner222]]]);
            expect(store.getValuesFromIndexedSet(IndexNames.ADDRESS, newAddress)?.has(name)).toBe(true);
        });

        // Given an already-stale unlabelled identity, a later shared 222 transfer must update
        // both the actual owner UTxOs and exact asset-name lookups. Removing the hex assignment
        // leaves the burned names searchable and the live 222 names missing.
        it('corrects stale owner-token identities when scanning a later shared 222 transfer', () => {
            const names = ['seniorsolutions', 'shaynasmeltzer'];
            const oldHex = names.map(name => Buffer.from(name).toString('hex'));
            const ownerHex = oldHex.map(hex => `000de140${hex}`);
            names.forEach((name, i) => repo.addUTxOsWithMintDataAndUpdateIndexes([{ ...utxo(`stale-source${i}#0`, name, 90, true), handles: [[policy, [oldHex[i]]]], mint: [[policy, [oldHex[i]]]] }]));
            const txHash = '888daf520116f17d351d2c84486f28249408d21a03f0c579243eb3f86ec762f2';
            const newAddress = 'addr_test1qz8zyhdetz270qzfvkym38wx4wsqzx0m49urfu3wjkqsuchs8t4235v9t0x5grxm2hel388ypz0q3fng8k6am5hqzacq0fc746';
            const transfer = { tx_hash: txHash, block_hash: block.id, block_height: 123, absolute_slot: 150, inputs: [{ tx_hash: 'stale-source0', tx_index: 0 }, { tx_hash: 'stale-source1', tx_index: 0 }], assets_minted: [], metadata: {}, outputs: [{ tx_hash: txHash, tx_index: 5, value: '2000000', payment_addr: { bech32: newAddress }, asset_list: ownerHex.map(asset_name => ({ policy_id: policy, asset_name, quantity: '1' })), inline_datum: null, datum_hash: null, reference_script: null }] };
            mockedHelpers.buildUTxOsFromKoiosTxs.mockImplementation(actualHelpers.buildUTxOsFromKoiosTxs);
            Internal.processScannerBlock(block, [transfer] as never, tip);
            names.forEach((name, i) => {
                expect(repo.getHandle(name)).toEqual(expect.objectContaining({ hex: ownerHex[i], utxo: `${txHash}#5`, resolved_addresses: expect.objectContaining({ ada: newAddress }) }));
                expect(repo.getHandleByHex(oldHex[i])).toBeNull();
                expect(repo.getHandleByHex(ownerHex[i])?.name).toBe(name);
                expect(store.getValuesFromIndexedSet(IndexNames.ADDRESS, newAddress)?.has(name)).toBe(true);
            });
            expect(repo.getUTxO(`${txHash}#5`)?.handles).toEqual([[policy, ownerHex]]);
            expect(repo.getUTxO('stale-source0#0') ?? null).toBeNull();
            expect(repo.getUTxO('stale-source1#0') ?? null).toBeNull();
        });

        // A newer 222 owner output must update the stored asset identity as well as its UTxO.
        // Keeping legacy hex after migration makes hex lookup and ownership audits target the burned asset.
        // Negative control: remove the owner-token hex update and this test fails on the stored hex.
        it('tracks the current owner-token hex when a legacy handle becomes a 222 token', () => {
            const name = 'migration-identity';
            const legacy = Buffer.from(name).toString('hex');
            const owner222 = `000de140${legacy}`;
            repo.addUTxOsWithMintDataAndUpdateIndexes([{ ...utxo('legacy#0', name, 90, true), handles: [[policy, [legacy]]], mint: [[policy, [legacy]]] }]);
            expect(repo.getHandle(name)).toEqual(expect.objectContaining({ hex: legacy, utxo: 'legacy#0' }));
            repo.addUTxOsWithMintDataAndUpdateIndexes([{ ...utxo('migrated#0', name, 150, false), handles: [[policy, [owner222]]], mint: [] }]);
            expect(repo.getHandle(name)).toEqual(expect.objectContaining({ hex: owner222, utxo: 'migrated#0' }));
            expect(repo.getHandleByHex(legacy)).toBeNull();
            expect(repo.getHandleByHex(owner222)).toEqual(expect.objectContaining({ name, utxo: 'migrated#0' }));
            repo.addUTxOsWithMintDataAndUpdateIndexes([{ ...utxo('older#0', name, 140, false), handles: [[policy, [legacy]]], mint: [] }]);
            expect(repo.getHandle(name)).toEqual(expect.objectContaining({ hex: owner222, utxo: 'migrated#0' }));
            expect(repo.getHandleByHex('invalid')).toBeNull();
        });

        // Preflight must keep a real scanner lease while checking fresh chain state, require every
        // owner in the shared output, and never mutate the old records or indexes. Removing a lease,
        // state-comparison or sibling guard makes its corresponding negative case succeed.
        it.each(['stable', 'lease-lost', 'chain-moved', 'missing-sibling'] as const)('validates shared-output repair preflight: %s', async (mode) => {
            const names = ['xn--8o8hx2f', 'xn--kong-tz14c'];
            const assets = names.map((name) => Buffer.from(name).toString('hex'));
            for (let i = 0; i < names.length; i++) {
                repo.addUTxOsWithMintDataAndUpdateIndexes([{ ...utxo(`old${i}#0`, names[i], 90, true), handles: [[policy, [assets[i]]]], mint: [[policy, [assets[i]]]] }]);
            }
            const before = names.map(name => repo.getHandle(name));
            const cursor = repo.getMetrics();
            const oldHolder = before[0]!.holder;
            const targets = names.map((name, i) => ({ name, policy, hex: assets[i] }));
            const canonical = [{ id: 'cancel#0', address: knownAddress, handles: [[policy, assets]] as [string, string[]][] }];
            const lease = { acquire: Internal.acquireScannerLease, renew: Internal.renewScannerLease, release: Internal.releaseScannerLease };
            let calls = 0;
            const readCanonical = async () => {
                calls++;
                if (mode === 'lease-lost' && calls === 2) {
                    const owner = store.redisClientCall('get', require('../stores/redis/keys').getApiScannerLeaseKey());
                    Internal.releaseScannerLease(owner);
                    expect(Internal.acquireScannerLease('successor')).toBe(true);
                }
                return mode === 'chain-moved' && calls === 2 ? [{ ...canonical[0], id: 'newer#0' }] : canonical;
            };
            try {
                const pending = repairPreflight(mode === 'missing-sibling' ? targets.slice(0, 1) : targets, lease, name => repo.getHandle(name), id => repo.getUTxO(id) ?? null, readCanonical);
                if (mode === 'stable') expect(await pending).toEqual({ stored: before, sources: [repo.getUTxO('old0#0'), repo.getUTxO('old1#0')], outputs: canonical });
                else await expect(pending).rejects.toThrow(mode === 'lease-lost' ? 'Scanner lease lost' : mode === 'chain-moved' ? 'Canonical state changed' : 'unplanned handle');
                expect(names.map(name => repo.getHandle(name))).toEqual(before);
                expect(repo.getUTxO('old0#0')).toEqual(expect.objectContaining({ id: 'old0#0' }));
                expect(repo.getUTxO('old1#0')).toEqual(expect.objectContaining({ id: 'old1#0' }));
                expect(repo.getUTxO('cancel#0') ?? null).toBeNull();
                for (const name of names) expect(store.getValuesFromIndexedSet(IndexNames.HOLDER, oldHolder)?.has(name)).toBe(true);
                expect(repo.getMetrics()).toEqual(expect.objectContaining({ currentSlot: cursor.currentSlot, currentBlockHash: cursor.currentBlockHash }));
                if (mode === 'lease-lost') expect(Internal.renewScannerLease('successor')).toBe(true);
            } finally {
                if (mode === 'lease-lost') Internal.releaseScannerLease('successor');
            }
        });

        // Invariant: the actual local executor locks status readers before its first write and
        // retains a durable recovery journal across failure, lease replacement, and chain movement.
        // Negative control: clearing the lock or journal before final verification fails these cases.
        it.each(['success', 'failure', 'full-undo', 'full-undo-mpt', 'full-undo-fork', 'full-undo-fork-conflict', 'full-undo-fork-set-conflict', 'full-undo-interrupted', 'partial-batch-start', 'partial-batch', 'partial-batch-end', 'partial-delete', 'partial-batch-cursor', 'lease-lost', 'chain-moved', 'crash', 'partial-crash', 'partial-crash-cursor'] as const)('executes and recovers local repair: %s', async mode => {
            repo.setMetrics({ currentSlot: 200 });
            const names = ['xn--8o8hx2f', 'xn--kong-tz14c'];
            const assets = names.map(name => Buffer.from(name).toString('hex'));
            for (let i = 0; i < names.length; i++) repo.addUTxOsWithMintDataAndUpdateIndexes([{ ...utxo(`old${i}#0`, names[i], 90, true), handles: [[policy, [assets[i]]]], mint: [[policy, [assets[i]]]] }]);
            const ownerAddress = 'addr_test1qz8zyhdetz270qzfvkym38wx4wsqzx0m49urfu3wjkqsuchs8t4235v9t0x5grxm2hel388ypz0q3fng8k6am5hqzacq0fc746';
            const originalHandles = names.map(name => repo.getHandle(name));
            const originalUtxos = ['old0#0', 'old1#0'].map(id => ({ id, value: repo.getUTxO(id) }));
            const oldAddress = repo.getHandle(names[0])!.resolved_addresses.ada;
            const oldHolder = repo.getHandle(names[0])!.holder;
            const cursor = repo.getMetrics();
            const root = await buildAndStoreMptRootHash(store);
            const targets = names.map((name, i) => ({ name, policy, hex: assets[i] }));
            let canonical = { ...utxo('cancel#0', names[0], 150, false), address: ownerAddress, handles: [[policy, assets]] as [string, string[]][] };
            const readCanonical = async () => [canonical];
            const lease = { acquire: Internal.acquireScannerLease, renew: Internal.renewScannerLease, release: Internal.releaseScannerLease };
            const peer = new RedisHandlesStore();
            const reader = new HandlesRepository(peer);
            const journalKey = getApiCacheKey('local-repair:journal');
            try {
                if (mode === 'crash' || mode.startsWith('partial-crash')) {
                    const child = spawnSync(process.execPath, ['--import', 'tsx', 'tests/local-repair-crash-fixture.ts'], {
                        env: { ...process.env, LOCAL_REPAIR_TEST_FIXTURE: JSON.stringify({ targets, outputs: [canonical], partialBatch: mode.startsWith('partial-crash') }) }, encoding: 'utf8', timeout: 30_000
                    });
                    expect({ status: child.status, stderr: child.status === 87 ? '' : child.stderr }).toEqual({ status: 87, stderr: '' });
                    // The dead process did not release its locks. Shorten only these isolated-test TTLs.
                    peer.redisClientCall('customCommand', ['PEXPIRE', getApiScannerLeaseKey(), '1']);
                    peer.redisClientCall('customCommand', ['PEXPIRE', getApiCacheKey('local-repair:lease'), '1']);
                    await new Promise(resolve => setTimeout(resolve, 20));
                } else {
                    const originalCall = store.redisClientCall.bind(store);
                    let injected = false;
                    const interceptor = (mode.startsWith('partial-batch') || mode === 'partial-delete') ? jest.spyOn(store, 'redisClientCall').mockImplementation(((method: string, ...args: any[]) => {
                        const interruptedKey = getApiIndexKey(IndexNames.UTXO, mode === 'partial-delete' ? 'old0#0' : 'cancel#0');
                        if (!injected && method === 'batch' && JSON.stringify(args[0]).includes(interruptedKey)) {
                            const batch = args[0] as any[];
                            expect(batch.length).toBeGreaterThan(1);
                            injected = true;
                            const count = mode === 'partial-batch-start' || mode === 'partial-delete' ? 1 : mode === 'partial-batch-end' ? batch.length - 1 : Math.floor(batch.length / 2);
                            originalCall('batch', batch.slice(0, count));
                            throw new Error('injected partial repository batch');
                        }
                        return originalCall(method, ...args);
                    }) as typeof store.redisClientCall) : undefined;
                    const operation = localRepair(store, lease, targets, readCanonical, () => {
                        expect(reader.currentHttpStatus()).toBe(503);
                        expect(peer.redisClientCall('get', journalKey)).toContain('old0#0');
                        if (mode === 'failure' || mode === 'full-undo' || mode === 'full-undo-fork' || mode === 'full-undo-fork-conflict' || mode === 'full-undo-fork-set-conflict' || mode === 'full-undo-interrupted') throw new Error('simulated process interruption');
                        if (mode === 'lease-lost') peer.redisClientCall('set', getApiScannerLeaseKey(), 'successor');
                        if (mode === 'chain-moved' || mode === 'full-undo-mpt') canonical = { ...canonical, id: 'moved#0', tx_id: 'moved', slot: 160 };
                    });
                    try {
                        if (mode === 'success') await operation;
                        else await expect(operation).rejects.toThrow(mode === 'failure' || mode === 'full-undo' || mode === 'full-undo-fork' || mode === 'full-undo-fork-conflict' || mode === 'full-undo-fork-set-conflict' || mode === 'full-undo-interrupted' ? 'simulated process interruption' : mode.startsWith('partial-batch') || mode === 'partial-delete' ? 'injected partial repository batch' : mode === 'chain-moved' || mode === 'full-undo-mpt' ? 'Canonical state changed' : /fence lost|fence changed/);
                        if (mode.startsWith('partial-batch') || mode === 'partial-delete') expect(injected).toBe(true);
                    } finally { interceptor?.mockRestore(); }
                }
                if (mode !== 'success') {
                    expect(localRepairGate(peer, 'admit', 'interrupted-reader')).toBe(0);
                    expect(reader.currentHttpStatus()).toBe(503);
                    const pendingJournal = JSON.parse(peer.redisClientCall('get', journalKey));
                    const undoLog = getApiCacheKey('local-repair:experimental-undo-log');
                    const sequence = Number(peer.redisClientCall('hget', undoLog, 'sequence'));
                    expect(sequence).toBeGreaterThan(0);
                    const capturedKeys: string[] = [];
                    const capturedBatches: { id: string; keys: string[] }[] = [];
                    for (let i = 1; i <= sequence; i++) {
                        const id = peer.redisClientCall('hget', undoLog, `order:${i}`);
                        expect(typeof id).toBe('string');
                        expect(peer.redisClientCall('hget', undoLog, `${id}:before-ready`)).toBe('1');
                        expect(peer.redisClientCall('hget', undoLog, `${id}:complete`)).toBe('1');
                        const keys = JSON.parse(peer.redisClientCall('hget', undoLog, `${id}:keys`));
                        expect(keys.length).toBeGreaterThan(0);
                        capturedKeys.push(...keys);
                        capturedBatches.push({ id, keys });
                    }
                    if (mode === 'chain-moved' || mode === 'full-undo-mpt') {
                        expect(capturedKeys).toContain(getApiMptRootHashKey());
                        const checked = new Set<string>();
                        const compare = "local d=redis.call('DUMP',KEYS[2]); local e=redis.call('HGET',KEYS[1],ARGV[1]..':after-exists:'..ARGV[2]); local s=redis.call('HGET',KEYS[1],ARGV[1]..':after:'..ARGV[2]); if (not d and e=='0') or (d and e=='1' and d==s) then return 1 else return 0 end";
                        for (const batch of capturedBatches.reverse()) for (let i = 0; i < batch.keys.length; i++) {
                            const key = batch.keys[i];
                            if (checked.has(key)) continue;
                            checked.add(key);
                            expect(peer.redisClientCall('customCommand', ['EVAL', compare, '2', undoLog, key, batch.id, String(i + 1)])).toBe(1);
                        }
                        expect(checked.has(getApiMptRootHashKey())).toBe(true);
                        const handleKey = getApiIndexKey(IndexNames.HANDLE, names[0]);
                        const last = capturedBatches.find(batch => batch.keys.includes(handleKey))!;
                        const index = String(last.keys.indexOf(handleKey) + 1);
                        peer.redisClientCall('hset', handleKey, { utxo: 'intrusion#0' });
                        expect(peer.redisClientCall('customCommand', ['EVAL', compare, '2', undoLog, handleKey, last.id, index])).toBe(0);
                        peer.redisClientCall('hset', handleKey, { utxo: 'cancel#0' });
                        // This equality after an uncoordinated change-and-restore demonstrates
                        // why postimage comparison alone is not a production writer fence.
                        expect(peer.redisClientCall('customCommand', ['EVAL', compare, '2', undoLog, handleKey, last.id, index])).toBe(1);
                    }
                    expect(pendingJournal.undoImages.handles).toEqual(originalHandles);
                    expect(pendingJournal.undoImages.mptRoot).toBe(root);
                    expect(pendingJournal.undoImages.utxos).toEqual([...originalUtxos, { id: 'cancel#0', value: null }]);
                    expect(pendingJournal.undoImages.utxoSlots).toEqual([{ id: 'old0#0', score: 90 }, { id: 'old1#0', score: 90 }, { id: 'cancel#0', score: null }]);
                    expect(pendingJournal.undoImages.orderedMembers).toEqual(expect.arrayContaining([
                        { index: IndexNames.HOLDER_COUNT, member: oldHolder, score: 2 },
                        { index: IndexNames.HOLDER_COUNT, member: buildHolderInfo(ownerAddress).address, score: null }
                    ]));
                    for (const name of names) expect(pendingJournal.undoImages.memberships).toEqual(expect.arrayContaining([
                        { index: IndexNames.RARITY, key: originalHandles[names.indexOf(name)]!.rarity, member: name, present: true },
                        { index: IndexNames.HOLDER, key: oldHolder, member: name, present: true },
                        { index: IndexNames.HOLDER, key: buildHolderInfo(ownerAddress).address, member: name, present: false },
                        { index: IndexNames.DEFAULT_HANDLE, key: buildHolderInfo(ownerAddress).address, member: name, present: false },
                        { index: IndexNames.ADDRESS, key: oldAddress, member: name, present: true },
                        { index: IndexNames.ADDRESS, key: ownerAddress, member: name, present: false },
                        { index: IndexNames.PAYMENT_KEY_HASH, key: getPaymentKeyHash(oldAddress), member: name, present: true },
                        { index: IndexNames.PAYMENT_KEY_HASH, key: getPaymentKeyHash(ownerAddress), member: name, present: false }
                    ]));
                    if (mode === 'full-undo' || mode === 'full-undo-mpt' || mode === 'full-undo-fork' || mode === 'full-undo-fork-conflict' || mode === 'full-undo-fork-set-conflict' || mode === 'full-undo-interrupted') {
                        const repairLease = getApiCacheKey('local-repair:lease');
                        const gateKey = getApiCacheKey('local-repair:reader-gate');
                        const readerKey = getApiCacheKey('local-repair:readers');
                        expect(Internal.acquireScannerLease('undo-scanner')).toBe(true);
                        peer.redisClientCall('customCommand', ['SET', repairLease, 'undo-owner', 'PX', '120000']);
                        expect(localRepairGate(peer, 'close', 'undo-owner', 'undo-scanner')).toBe(1);
                        const script = readFileSync('stores/redis/experimentalUndoKeyImages.lua', 'utf8');
                        const undoKeys = [undoLog, gateKey, readerKey, repairLease, getApiScannerLeaseKey(), ...new Set(capturedKeys)];
                        const runUndo = () => peer.redisClientCall('customCommand', ['EVAL', script, `${undoKeys.length}`, ...undoKeys, 'undo-owner', 'undo-owner', 'undo-scanner']);
                        const handleKey = getApiIndexKey(IndexNames.HANDLE, names[0]);
                        if (mode === 'full-undo-interrupted') {
                            const marker = "else redis.call('RESTORE', key, 0, image.image, 'REPLACE') end";
                            const injected = script.replace(marker, `${marker}; error('injected undo failure')`);
                            expect(injected).not.toBe(script);
                            expect(() => peer.redisClientCall('customCommand', ['EVAL', injected, `${undoKeys.length}`, ...undoKeys, 'undo-owner', 'undo-owner', 'undo-scanner'])).toThrow('injected undo failure');
                            expect(() => runUndo()).toThrow('UNDO_CONFLICT');
                            expect(peer.redisClientCall('get', journalKey)).not.toBeNull();
                            expect(localRepairGate(peer, 'admit', 'undo-reader')).toBe(0);
                            peer.redisClientCall('snapshotRelease', { key: repairLease, owner: 'undo-owner', scannerKey: getApiScannerLeaseKey(), scannerOwner: 'undo-scanner', ownsScannerLease: false });
                            Internal.releaseScannerLease('undo-scanner');
                            return;
                        }
                        if (mode === 'full-undo-fork' || mode === 'full-undo-fork-conflict' || mode === 'full-undo-fork-set-conflict') {
                            peer.setMetrics({ currentSlot: 201, currentBlockHash: 'different-chain' });
                            peer.redisClientCall('zadd', getApiIndexRootKey(IndexNames.UTXO_SLOT), [{ element: 'unrelated-chain#0', score: 201 }]);
                            peer.redisClientCall('sadd', getApiIndexKey(IndexNames.HOLDER, oldHolder), ['unrelated-holder-handle']);
                            peer.redisClientCall('sadd', getApiIndexKey(IndexNames.ADDRESS, ownerAddress), ['unrelated-address-handle']);
                            if (mode === 'full-undo-fork-conflict' || mode === 'full-undo-fork-set-conflict') {
                                if (mode === 'full-undo-fork-conflict') peer.redisClientCall('zadd', getApiIndexRootKey(IndexNames.UTXO_SLOT), [{ element: 'cancel#0', score: 202 }]);
                                else peer.redisClientCall('sadd', getApiIndexKey(IndexNames.HOLDER, oldHolder), [names[0]]);
                                expect(() => runUndo()).toThrow('UNDO_CONFLICT');
                                expect(repo.getHandle(names[0])?.utxo).toBe('cancel#0');
                                if (mode === 'full-undo-fork-conflict') expect(peer.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, 202)).toContain('cancel#0');
                                else expect(peer.getValuesFromIndexedSet(IndexNames.HOLDER, oldHolder)?.has(names[0])).toBe(true);
                            } else {
                                expect(runUndo()).toBe(1);
                                expect(peer.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, 90)).toEqual(expect.arrayContaining(['old0#0', 'old1#0']));
                                expect(names.map(name => repo.getHandle(name))).toEqual(originalHandles);
                                expect(repo.getUTxO('cancel#0') ?? null).toBeNull();
                            }
                            expect(peer.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, 201)).toContain('unrelated-chain#0');
                            expect(peer.getValuesFromIndexedSet(IndexNames.HOLDER, oldHolder)?.has('unrelated-holder-handle')).toBe(true);
                            expect(peer.getValuesFromIndexedSet(IndexNames.ADDRESS, ownerAddress)?.has('unrelated-address-handle')).toBe(true);
                            expect(repo.getMetrics()).toEqual(expect.objectContaining({ currentSlot: 201, currentBlockHash: 'different-chain' }));
                            expect(localRepairGate(peer, 'admit', 'fork-reader')).toBe(0);
                            peer.redisClientCall('snapshotRelease', { key: repairLease, owner: 'undo-owner', scannerKey: getApiScannerLeaseKey(), scannerOwner: 'undo-scanner', ownsScannerLease: false });
                            Internal.releaseScannerLease('undo-scanner');
                            return;
                        }
                        peer.redisClientCall('hset', handleKey, { utxo: 'unexpected#0' });
                        expect(() => runUndo()).toThrow('UNDO_CONFLICT');
                        expect(repo.getHandle(names[0])?.utxo).toBe('unexpected#0');
                        expect(repo.getHandle(names[1])?.utxo).toBe('cancel#0');
                        peer.redisClientCall('hset', handleKey, { utxo: 'cancel#0' });
                        expect(runUndo()).toBe(1);
                        expect(names.map(name => repo.getHandle(name))).toEqual(originalHandles);
                        expect(originalUtxos.map(image => repo.getUTxO(image.id))).toEqual(originalUtxos.map(image => image.value));
                        expect(repo.getUTxO('cancel#0') ?? null).toBeNull();
                        for (const name of names) {
                            expect(peer.getValuesFromIndexedSet(IndexNames.HOLDER, oldHolder)?.has(name)).toBe(true);
                            expect(peer.getValuesFromIndexedSet(IndexNames.ADDRESS, oldAddress)?.has(name)).toBe(true);
                            expect(peer.getValuesFromIndexedSet(IndexNames.PAYMENT_KEY_HASH, getPaymentKeyHash(oldAddress)!)?.has(name)).toBe(true);
                            expect(peer.getValuesFromIndexedSet(IndexNames.ADDRESS, ownerAddress)?.has(name) ?? false).toBe(false);
                        }
                        expect(peer.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, 90)).toEqual(expect.arrayContaining(['old0#0', 'old1#0']));
                        expect(store.getMptRootHash()).toBe(root);
                        expect(localRepairGate(peer, 'admit', 'undo-reader')).toBe(0);
                        peer.redisClientCall('snapshotRelease', { key: repairLease, owner: 'undo-owner', scannerKey: getApiScannerLeaseKey(), scannerOwner: 'undo-scanner', ownsScannerLease: false });
                        Internal.releaseScannerLease('undo-scanner');
                        return;
                    }
                    if (mode === 'lease-lost') Internal.releaseScannerLease('successor');
                    const partial = names.map(name => repo.getHandle(name));
                    if (mode === 'partial-batch-cursor' || mode === 'partial-crash-cursor') {
                        peer.setMetrics({ currentSlot: 201, currentBlockHash: 'different-chain' });
                        const before = { handles: names.map(name => repo.getHandle(name)), utxo: repo.getUTxO(canonical.id), root: store.getMptRootHash(), metrics: repo.getMetrics(), journal: peer.redisClientCall('get', journalKey) };
                        const ancestry = [
                            { hash: 'provider_block', slot: 200, parentHash: 'common-block' },
                            { hash: 'different-chain', slot: 201, parentHash: 'common-block' },
                            { hash: 'common-block', slot: 190, parentHash: null }
                        ];
                        await expect(localRepair(store, lease, undefined, readCanonical, undefined, async hash => ancestry.find(block => block.hash === hash) ?? null))
                            .rejects.toThrow('common ancestry candidate common-block at 190; canonicality and undo required');
                        expect({ handles: names.map(name => repo.getHandle(name)), utxo: repo.getUTxO(canonical.id), root: store.getMptRootHash(), metrics: repo.getMetrics(), journal: peer.redisClientCall('get', journalKey) }).toEqual(before);
                        expect(localRepairGate(peer, 'admit', 'fork-reader')).toBe(0);
                        return;
                    }
                    await lambdaHandler({} as any, { getRemainingTimeInMillis: () => 300_000 } as any);
                    await expect(require('./scanner.app').runSideload('auto')).rejects.toThrow('repair journal is pending');
                    expect(names.map(name => repo.getHandle(name))).toEqual(partial);
                    expect(peer.redisClientCall('get', journalKey)).toContain('old0#0');
                    expect(reader.currentHttpStatus()).toBe(503);
                    await localRepair(store, lease, undefined, readCanonical);
                }
                expect(localRepairGate(peer, 'admit', 'recovered-reader')).toBe(1);
                expect(localRepairGate(peer, 'release', 'recovered-reader')).toBe(1);
                expect(reader.currentHttpStatus()).not.toBe(503);
                expect(peer.redisClientCall('get', journalKey) ?? null).toBeNull();
                expect(peer.redisClientCall('get', getApiMptRebuildPendingKey()) ?? null).toBeNull();
                const newHolder = repo.getHandle(names[0])!.holder;
                expect(newHolder).not.toBe(oldHolder);
                for (const name of names) {
                    expect(repo.getHandle(name)).toEqual(expect.objectContaining({ utxo: canonical.id, holder: newHolder, resolved_addresses: expect.objectContaining({ ada: ownerAddress }) }));
                    expect(store.getValuesFromIndexedSet(IndexNames.ADDRESS, ownerAddress)?.has(name)).toBe(true);
                    expect(store.getValuesFromIndexedSet(IndexNames.ADDRESS, oldAddress)?.has(name) ?? false).toBe(false);
                    expect(store.getValuesFromIndexedSet(IndexNames.HOLDER, newHolder)?.has(name)).toBe(true);
                    expect(store.getValuesFromIndexedSet(IndexNames.HOLDER, oldHolder)?.has(name) ?? false).toBe(false);
                    expect(store.getValuesFromIndexedSet(IndexNames.PAYMENT_KEY_HASH, getPaymentKeyHash(ownerAddress)!)?.has(name)).toBe(true);
                    expect(store.getValuesFromIndexedSet(IndexNames.PAYMENT_KEY_HASH, getPaymentKeyHash(oldAddress)!)?.has(name) ?? false).toBe(false);
                }
                expect(store.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, canonical.slot)).toContain(canonical.id);
                expect(store.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, 90) ?? []).not.toContain('old0#0');
                expect(store.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, 90) ?? []).not.toContain('old1#0');
                expect(repo.getUTxO('old0#0') ?? null).toBeNull();
                expect(repo.getUTxO('old1#0') ?? null).toBeNull();
                if (mode === 'chain-moved') expect(repo.getUTxO('cancel#0') ?? null).toBeNull();
                expect(repo.getUTxO(canonical.id)).toEqual(expect.objectContaining({ handles: canonical.handles }));
                expect(store.getMptRootHash()).toBe(root);
                expect(repo.getMetrics()).toEqual(expect.objectContaining({ currentSlot: cursor.currentSlot, currentBlockHash: cursor.currentBlockHash }));
            } finally {
                Internal.releaseScannerLease('successor');
                store.redisClientCall('del', [journalKey, getApiMptRebuildPendingKey()]);
            }
        });

        // The maintenance ACL must exclude even direct default-user clients while a
        // separately authenticated process runs the actual shared-output repair.
        // Leaving default enabled makes the connection-denial assertion fail.
        it('runs a shared-output repair while direct clients are excluded by isolated ACLs', async () => {
            repo.setMetrics({ currentSlot: 200 });
            const names = ['acl-owner-a', 'acl-owner-b'];
            const assets = names.map(name => Buffer.from(name).toString('hex'));
            for (let i = 0; i < names.length; i++) repo.addUTxOsWithMintDataAndUpdateIndexes([{ ...utxo(`acl-old-${i}#0`, names[i], 90, true), handles: [[policy, [assets[i]]]], mint: [[policy, [assets[i]]]] }]);
            const destination = 'addr_test1qz8zyhdetz270qzfvkym38wx4wsqzx0m49urfu3wjkqsuchs8t4235v9t0x5grxm2hel388ypz0q3fng8k6am5hqzacq0fc746';
            repo.addUTxOsWithMintDataAndUpdateIndexes([{ ...utxo('acl-unrelated#0', 'acl-unrelated', 95, true), address: destination }]);
            const output = { ...utxo('acl-shared#0', names[0], 150, false), address: destination, handles: [[policy, assets]] as [string, string[]][] };
            const targets = names.map((name, i) => ({ name, policy, hex: assets[i] }));
            const root = await buildAndStoreMptRootHash(store);
            const opts = require('../tests/valkey-harness.cjs').connectionOptions({ addresses: [{ host: '127.0.0.1', port: 6381 }], useTLS: false });
            const initial = await GlideClient.createClient(opts);
            const username = `repair-${randomUUID()}`;
            const password = randomBytes(32).toString('hex');
            let admin: GlideClient | undefined;
            try {
                await initial.customCommand(['ACL', 'SETUSER', username, 'reset', 'on', `>${password}`, '~*', '+@all']);
                admin = await GlideClient.createClient({ ...opts, credentials: { username, password } });
                await admin.customCommand(['ACL', 'SETUSER', 'default', 'off']);
                expect(Number(await admin.customCommand(['CLIENT', 'KILL', 'USER', 'default']))).toBeGreaterThan(0);
                await expect(GlideClient.createClient(opts)).rejects.toThrow(/AUTH|auth|disabled|wrongpass|connection/i);
                const child = spawnSync(process.execPath, ['--import', 'tsx', 'tests/local-repair-crash-fixture.ts'], {
                    env: { ...process.env, API_TEST_VALKEY_REPAIR_USER: username, API_TEST_VALKEY_REPAIR_PASSWORD: password,
                        LOCAL_REPAIR_TEST_FIXTURE: JSON.stringify({ targets, outputs: [output], complete: true }) }, encoding: 'utf8', timeout: 30_000
                });
                expect(child.status).toBe(0);
                for (const name of names) {
                    expect(await admin.hget(getApiIndexKey(IndexNames.HANDLE, name), 'utxo')).toBe(output.id);
                    expect(await admin.customCommand(['SISMEMBER', getApiIndexKey(IndexNames.ADDRESS, output.address), name])).toBe(true);
                    expect(await admin.customCommand(['SISMEMBER', getApiIndexKey(IndexNames.ADDRESS, knownAddress), name])).toBe(false);
                    expect(await admin.customCommand(['SISMEMBER', getApiIndexKey(IndexNames.HOLDER, buildHolderInfo(destination).address), name])).toBe(true);
                    expect(await admin.customCommand(['SISMEMBER', getApiIndexKey(IndexNames.PAYMENT_KEY_HASH, getPaymentKeyHash(destination)!), name])).toBe(true);
                }
                expect(await admin.hget(getApiIndexKey(IndexNames.HANDLE, 'acl-unrelated'), 'utxo')).toBe('acl-unrelated#0');
                expect(await admin.customCommand(['SISMEMBER', getApiIndexKey(IndexNames.HOLDER, buildHolderInfo(destination).address), 'acl-unrelated'])).toBe(true);
                expect(await admin.hget(getApiIndexKey(IndexNames.UTXO, 'acl-old-0#0'), 'id')).toBeNull();
                expect(await admin.hget(getApiIndexKey(IndexNames.UTXO, 'acl-old-1#0'), 'id')).toBeNull();
                expect(await admin.hget(getApiIndexKey(IndexNames.UTXO, output.id), 'id')).toBe(output.id);
                expect(await admin.customCommand(['ZSCORE', getApiIndexRootKey(IndexNames.UTXO_SLOT), output.id])).toBe(150);
                expect(await admin.get(getApiMptRootHashKey())).toBe(root);
                await admin.customCommand(['ACL', 'SETUSER', 'default', 'on']);
                const resumed = await GlideClient.createClient(opts);
                try { expect(await resumed.hget(getApiIndexKey(IndexNames.HANDLE, names[0]), 'utxo')).toBe(output.id); }
                finally { resumed.close(); }
            } finally {
                if (admin) {
                    await admin.customCommand(['ACL', 'SETUSER', 'default', 'on']);
                    await admin.customCommand(['ACL', 'DELUSER', username]);
                    admin.close();
                }
                initial.close();
            }
        });

        // A stale source can list a sibling whose Handle already points elsewhere.
        // Omitting that sibling must be refused; including it preserves its live output.
        it('repairs a stale shared source without disturbing its already-moved sibling', async () => {
            repo.setMetrics({ currentSlot: 200 });
            const a = utxo('shared-source#0', 'samanka', 90, true);
            const b = utxo('shared-source#0', 'ventricle', 90, true);
            const aHex = Buffer.from('samanka').toString('hex');
            const bHex = Buffer.from('ventricle').toString('hex');
            const shared: UTxOWithTxInfo = { ...a, handles: [[policy, [aHex, bHex]]], mint: [[policy, [aHex, bHex]]],
                metadata: { '721': { [policy]: { ...(a.metadata!['721'] as any)[policy], ...(b.metadata!['721'] as any)[policy] } } } };
            repo.addUTxOsWithMintDataAndUpdateIndexes([shared]);
            const siblingOutput = { ...utxo('sibling-live#0', 'ventricle', 120, false), handles: [[policy, [bHex]]] as [string, string[]][] };
            repo.addUTxOsWithMintDataAndUpdateIndexes([siblingOutput]);
            const sibling = repo.getHandle('ventricle');
            const targetAddress = 'addr_test1qz8zyhdetz270qzfvkym38wx4wsqzx0m49urfu3wjkqsuchs8t4235v9t0x5grxm2hel388ypz0q3fng8k6am5hqzacq0fc746';
            const targetOutput = { ...utxo('samanka-live#0', 'samanka', 150, false), address: targetAddress, handles: [[policy, [aHex]]] as [string, string[]][] };
            const target = { name: 'samanka', policy, hex: aHex };
            const siblingTarget = { name: 'ventricle', policy, hex: bHex };
            const lease = { acquire: Internal.acquireScannerLease, renew: Internal.renewScannerLease, release: Internal.releaseScannerLease };
            const root = await buildAndStoreMptRootHash(store);
            await expect(localRepair(store, lease, [target], async () => [targetOutput])).rejects.toThrow('unplanned handle');
            expect(repo.getUTxO(shared.id)?.handles).toEqual(shared.handles);
            expect(repo.getHandle('ventricle')).toEqual(sibling);
            await localRepair(store, lease, [target, siblingTarget], async () => [targetOutput, siblingOutput]);
            expect(repo.getHandle('samanka')).toEqual(expect.objectContaining({ utxo: targetOutput.id, resolved_addresses: expect.objectContaining({ ada: targetAddress }) }));
            const { default_in_wallet: _oldDefault, ...siblingFields } = sibling!;
            expect(repo.getHandle('ventricle')).toEqual({ ...siblingFields, default_in_wallet: 'ventricle' });
            expect(repo.getUTxO(siblingOutput.id)?.handles).toEqual(siblingOutput.handles);
            expect(repo.getUTxO(shared.id) ?? null).toBeNull();
            expect(store.getValuesFromIndexedSet(IndexNames.ADDRESS, knownAddress)?.has('ventricle')).toBe(true);
            expect(store.getValuesFromIndexedSet(IndexNames.PAYMENT_KEY_HASH, getPaymentKeyHash(knownAddress)!)?.has('ventricle')).toBe(true);
            expect(store.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, 120)).toContain(siblingOutput.id);
            expect(store.getMptRootHash()).toBe(root);
        });

        // A shared output matching the largest current incident group must recover all
        // owners without erasing an unrelated Handle already held at the destination.
        // Dropping one target or replacing the holder set makes these assertions fail.
        it('recovers twenty Handles sharing one destination without losing another holder member', async () => {
            repo.setMetrics({ currentSlot: 200 });
            const names = ['bot', 'charge', 'compare', 'cupid', 'export', 'israel', 'kyoto', 'lamineyamal', 'poop', 'thedonald',
                'wolf', 'xn--019ha', 'xn--0z9ha', 'xn--1z9haaa', 'xn--2r-mbc', 'xn--ns8hty', 'xn--os9ha', 'xn--oup-dsbby1x', 'xn--p39hb', 'xn--zz9ha'];
            const labelled = new Set(['bot', 'cupid', 'israel', 'kyoto', 'poop', 'thedonald']);
            const assets = names.map(name => `${labelled.has(name) ? '000de140' : ''}${Buffer.from(name).toString('hex')}`);
            for (let i = 0; i < names.length; i++) {
                repo.addUTxOsWithMintDataAndUpdateIndexes([{ ...utxo(`batch-old-${i}#0`, names[i], 90, true),
                    handles: [[policy, [assets[i]]]], mint: [[policy, [assets[i]]]] }]);
            }
            const address = 'addr_test1qz8zyhdetz270qzfvkym38wx4wsqzx0m49urfu3wjkqsuchs8t4235v9t0x5grxm2hel388ypz0q3fng8k6am5hqzacq0fc746';
            repo.addUTxOsWithMintDataAndUpdateIndexes([{ ...utxo('unrelated#0', 'unrelated-owner', 95, true), address }]);
            const unrelated = repo.getHandle('unrelated-owner');
            const oldHolder = repo.getHandle(names[0])!.holder;
            const newHolder = unrelated!.holder;
            const root = await buildAndStoreMptRootHash(store);
            const cursor = repo.getMetrics();
            const target = names.map((name, i) => ({ name, policy, hex: assets[i] }));
            const output = { ...utxo('batch-shared#0', names[0], 150, false), address, handles: [[policy, assets]] as [string, string[]][] };
            const lease = { acquire: Internal.acquireScannerLease, renew: Internal.renewScannerLease, release: Internal.releaseScannerLease };
            await expect(localRepair(store, lease, target, async () => [output], () => { throw new Error('interrupted shared repair'); })).rejects.toThrow('interrupted shared repair');
            expect(repo.currentHttpStatus()).toBe(503);
            await localRepair(store, lease, undefined, async () => [output]);
            expect(repo.getHandle('unrelated-owner')).toEqual(expect.objectContaining({
                hex: unrelated!.hex, utxo: unrelated!.utxo, holder: unrelated!.holder,
                resolved_addresses: unrelated!.resolved_addresses, default_in_wallet: 'bot'
            }));
            expect(store.getValuesFromIndexedSet(IndexNames.HOLDER, newHolder)?.has('unrelated-owner')).toBe(true);
            for (let i = 0; i < names.length; i++) {
                expect(repo.getHandle(names[i])).toEqual(expect.objectContaining({ hex: assets[i], utxo: output.id, holder: newHolder, resolved_addresses: expect.objectContaining({ ada: address }) }));
                expect(store.getValuesFromIndexedSet(IndexNames.HOLDER, oldHolder)?.has(names[i]) ?? false).toBe(false);
                expect(store.getValuesFromIndexedSet(IndexNames.HOLDER, newHolder)?.has(names[i])).toBe(true);
                expect(store.getValuesFromIndexedSet(IndexNames.ADDRESS, address)?.has(names[i])).toBe(true);
                expect(store.getValuesFromIndexedSet(IndexNames.ADDRESS, knownAddress)?.has(names[i]) ?? false).toBe(false);
                expect(store.getValuesFromIndexedSet(IndexNames.PAYMENT_KEY_HASH, getPaymentKeyHash(address)!)?.has(names[i])).toBe(true);
                expect(store.getValuesFromIndexedSet(IndexNames.PAYMENT_KEY_HASH, getPaymentKeyHash(knownAddress)!)?.has(names[i]) ?? false).toBe(false);
                expect(repo.getUTxO(`batch-old-${i}#0`) ?? null).toBeNull();
            }
            expect(repo.getUTxO(output.id)?.handles).toEqual(output.handles);
            expect(store.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, output.slot)).toContain(output.id);
            for (let i = 0; i < names.length; i++) expect(store.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, 90) ?? []).not.toContain(`batch-old-${i}#0`);
            expect(store.redisClientCall('zmscore', getApiIndexRootKey(IndexNames.HOLDER_COUNT), [newHolder])).toEqual([21]);
            expect(store.getMptRootHash()).toBe(root);
            expect(repo.getMetrics()).toEqual(expect.objectContaining({ currentSlot: cursor.currentSlot, currentBlockHash: cursor.currentBlockHash }));
            expect(repo.currentHttpStatus()).not.toBe(503);
        });

        // An actual local repair must wait until an admitted HTTP stream finishes, then
        // reject new readers until its indexes are stable. Removing admission leaks a write.
        it('excludes HTTP streams from the actual local repair', async () => {
            repo.setMetrics({ currentSlot: 200 });
            const name = 'stream-repair';
            const hex = Buffer.from(name).toString('hex');
            repo.addUTxOsWithMintDataAndUpdateIndexes([{ ...utxo('stream-old#0', name, 90, true), handles: [[policy, [hex]]], mint: [[policy, [hex]]] }]);
            const output = { ...utxo('stream-new#0', name, 150, false), handles: [[policy, [hex]]] as [string, string[]][] };
            const lease = { acquire: Internal.acquireScannerLease, renew: Internal.renewScannerLease, release: Internal.releaseScannerLease };
            const app = express();
            app.use(localRepairReaderAdmission(() => store));
            let stream!: express.Response;
            app.get('/stream', (_req, res) => { stream = res; res.write('first'); });
            app.get('/fresh', (_req, res) => res.json({ utxo: repo.getHandle(name)?.utxo }));
            const server = await new Promise<ReturnType<typeof app.listen>>(resolve => {
                const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
            });
            const previousWriterGuard = process.env.API_TEST_REPAIR_WRITER_GUARD;
            process.env.API_TEST_REPAIR_WRITER_GUARD = '1';
            try {
                const port = (server.address() as { port: number }).port;
                const response = await new Promise<http.IncomingMessage>((resolve, reject) => http.get({ host: '127.0.0.1', port, path: '/stream' }, resolve).on('error', reject));
                await new Promise(resolve => response.once('data', resolve));
                await expect(localRepair(store, lease, [{ name, policy, hex }], async () => [output])).rejects.toThrow('Active repair readers');
                expect(repo.getHandle(name)?.utxo).toBe('stream-old#0');
                stream.end('last');
                response.resume();
                await new Promise(resolve => response.once('end', resolve));
                await localRepair(store, lease, [{ name, policy, hex }], async () => [output], async () => {
                    expect((await request(app).get('/fresh')).status).toBe(503);
                    const independentStore = new RedisHandlesStore();
                    const slotBefore = independentStore.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, output.slot);
                    expect(slotBefore).toContain(output.id);
                    expect(() => independentStore.redisClientCall('hset', getApiIndexKey(IndexNames.HANDLE, name), { utxo: 'intrusion#0' })).toThrow('Repair writer gate closed');
                    expect(() => independentStore.pipeline(() => independentStore.redisClientCall('hset', getApiIndexKey(IndexNames.HANDLE, name), { utxo: 'intrusion#0' }))).toThrow('Repair writer gate closed');
                    expect(() => independentStore.redisClientCall('customCommand', ['HSET', getApiIndexKey(IndexNames.HANDLE, name), 'utxo', 'intrusion#0'])).toThrow('Repair writer gate closed');
                    expect(() => independentStore.redisClientCall('customCommand', ['EVAL', "return redis.call('HSET', KEYS[1], 'utxo', 'intrusion#0')", '1', getApiIndexKey(IndexNames.HANDLE, name)])).toThrow('Repair writer gate closed');
                    expect(() => independentStore.pipeline(() => independentStore.redisClientCall('customCommand', ['HSET', getApiIndexKey(IndexNames.HANDLE, name), 'utxo', 'intrusion#0']))).toThrow('Repair writer gate closed');
                    expect(() => independentStore.redisClientCall('del', [getApiIndexKey(IndexNames.UTXO, output.id)])).toThrow('Repair writer gate closed');
                    expect(() => independentStore.redisClientCall('zrem', getApiIndexRootKey(IndexNames.UTXO_SLOT), [output.id])).toThrow('Repair writer gate closed');
                    expect(() => independentStore.redisClientCall('srem', getApiIndexKey(IndexNames.ADDRESS, output.address), [name])).toThrow('Repair writer gate closed');
                    expect(() => independentStore.redisClientCall('hset', getApiMetricsKey(), { currentSlot: '201', currentBlockHash: 'intrusion' })).toThrow('Repair writer gate closed');
                    expect(() => independentStore.redisClientCall('set', getApiScannerLeaseKey(), 'intrusion')).toThrow('Repair writer gate closed');
                    expect(repo.getHandle(name)?.utxo).toBe('stream-new#0');
                    expect(repo.getUTxO(output.id)?.handles).toEqual(output.handles);
                    expect(independentStore.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, output.slot)).toEqual(slotBefore);
                    expect(store.getValuesFromIndexedSet(IndexNames.ADDRESS, output.address)?.has(name)).toBe(true);
                    expect(repo.getMetrics()).toEqual(expect.objectContaining({ currentSlot: 200, currentBlockHash: 'provider_block' }));
                    // A direct Valkey client does not participate in the store guard.
                    // This negative control prevents claiming universal exclusion.
                    const options = require('../tests/valkey-harness.cjs').connectionOptions({ addresses: [{ host: '127.0.0.1', port: 6381 }], useTLS: false });
                    const raw = await GlideClient.createClient(options);
                    try {
                        await raw.hset(getApiIndexKey(IndexNames.HANDLE, name), { utxo: 'raw-bypass#0' });
                        expect(repo.getHandle(name)?.utxo).toBe('raw-bypass#0');
                        await raw.hset(getApiIndexKey(IndexNames.HANDLE, name), { utxo: 'stream-new#0' });
                        expect(repo.getHandle(name)?.utxo).toBe('stream-new#0');
                    } finally { raw.close(); }
                });
                const fresh = await request(app).get('/fresh');
                expect(fresh.status).toBe(200);
                expect(fresh.body).toEqual({ utxo: 'stream-new#0' });
                const independentStore = new RedisHandlesStore();
                independentStore.redisClientCall('customCommand', ['HSET', getApiIndexKey(IndexNames.HANDLE, name), 'utxo', 'later#0']);
                expect(repo.getHandle(name)?.utxo).toBe('later#0');
            } finally {
                if (previousWriterGuard === undefined) delete process.env.API_TEST_REPAIR_WRITER_GUARD;
                else process.env.API_TEST_REPAIR_WRITER_GUARD = previousWriterGuard;
                stream?.destroy();
                await new Promise<void>(resolve => server.close(() => resolve()));
            }
        });

        // A repair interrupted after replacing a burned legacy identity must resume using the
        // journal and preserve the canonical output and lookups, not strand the reader lock.
        // Removing journal-aware identity validation rejects recovery after the first write.
        it('recovers an interrupted repair of a stale owner-token identity', async () => {
            repo.setMetrics({ currentSlot: 200 });
            const name = 'identity-repair';
            const legacy = Buffer.from(name).toString('hex');
            const owner = `000de140${legacy}`;
            repo.addUTxOsWithMintDataAndUpdateIndexes([{ ...utxo('identity-legacy#0', name, 90, true), handles: [[policy, [legacy]]], mint: [[policy, [legacy]]] }]);
            const output = { ...utxo('identity-owner#0', name, 150, false), handles: [[policy, [owner]]] as [string, string[]][], mint: [] };
            repo.addUTxOsWithMintDataAndUpdateIndexes([output]);
            const original = repo.getHandle(name)!;
            store.setHashOnIndex(IndexNames.HANDLE, name, { ...original, hex: legacy });
            const originalRoot = await buildAndStoreMptRootHash(store);
            const originalMetrics = repo.getMetrics();
            const target = { name, policy, hex: owner, storedHex: legacy };
            const lease = { acquire: Internal.acquireScannerLease, renew: Internal.renewScannerLease, release: Internal.releaseScannerLease };
            await expect(localRepair(store, lease, [target], async () => [output], () => { throw new Error('interrupted'); })).rejects.toThrow('interrupted');
            expect(repo.getHandle(name)?.hex).toBe(owner);
            expect(repo.currentHttpStatus()).toBe(503);
            await localRepair(store, lease, undefined, async () => [output]);
            expect(repo.getHandleByHex(legacy)).toBeNull();
            expect(repo.getHandleByHex(owner)).toEqual(expect.objectContaining({ name, utxo: output.id }));
            expect(repo.getUTxO(output.id)?.handles).toEqual(output.handles);
            expect(store.getValuesFromIndexedSet(IndexNames.HOLDER, original.holder)?.has(name)).toBe(true);
            expect(store.getValuesFromIndexedSet(IndexNames.ADDRESS, output.address)?.has(name)).toBe(true);
            expect(store.getValuesFromIndexedSet(IndexNames.PAYMENT_KEY_HASH, getPaymentKeyHash(output.address)!)?.has(name)).toBe(true);
            expect(store.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, output.slot)).toContain(output.id);
            expect(store.getMptRootHash()).toBe(originalRoot);
            expect(repo.getMetrics()).toEqual(expect.objectContaining({ currentSlot: originalMetrics.currentSlot, currentBlockHash: originalMetrics.currentBlockHash }));
            expect(repo.currentHttpStatus()).not.toBe(503);
        });

        // Never replay mint/burn metadata or advance a repair beyond the scanner cursor.
        // Negative control: removing the transfer/cursor guard lets either case mutate the store.
        it.each(['ahead', 'mint'] as const)('refuses unsafe local repair output: %s', async mode => {
            const name = 'unsafe-repair';
            const asset = Buffer.from(name).toString('hex');
            repo.addUTxOsWithMintDataAndUpdateIndexes([{ ...utxo('old-unsafe#0', name, 90, true), handles: [[policy, [asset]]], mint: [[policy, [asset]]] }]);
            const before = repo.getHandle(name);
            const output = { ...utxo('new-unsafe#0', name, mode === 'ahead' ? 150 : 120, mode === 'mint'), handles: [[policy, [asset]]] as [string, string[]][] };
            const lease = { acquire: Internal.acquireScannerLease, renew: Internal.renewScannerLease, release: Internal.releaseScannerLease };
            await expect(localRepair(store, lease, [{ name, policy, hex: asset }], async () => [output])).rejects.toThrow('Only transfer outputs');
            expect(repo.getHandle(name)).toEqual(before);
            expect(repo.getUTxO('old-unsafe#0')).toEqual(expect.objectContaining({ id: 'old-unsafe#0' }));
            expect(repo.getUTxO('new-unsafe#0') ?? null).toBeNull();
            expect(store.redisClientCall('get', getApiCacheKey('local-repair:journal')) ?? null).toBeNull();
        });

        // The real Koios adapter must prove cursor ancestry and bracket its reads with one tip.
        // A fork past the cursor must leave the journal and reader lock in place.
        // Negative control: removing the ancestry check permits an orphaned cursor to be committed.
        it.each(['stable', 'advance', 'rollback', 'spent', 'spent-crash', 'missing', 'historical-sibling'] as const)('anchors the actual repair to Koios and recovers safely: %s', async mode => {
            repo.setMetrics({ currentSlot: 200, currentBlockHash: 'anchor' });
            const names = ['koios-repair-a', 'koios-repair-b'];
            const assets = names.map(name => Buffer.from(name).toString('hex'));
            for (let i = 0; i < names.length; i++) repo.addUTxOsWithMintDataAndUpdateIndexes([{ ...utxo(`koios-old${i}#0`, names[i], 90, true), handles: [[policy, [assets[i]]]], mint: [[policy, [assets[i]]]] }]);
            const targets = names.map((name, i) => ({ name, policy, hex: assets[i] })).slice(0, mode === 'historical-sibling' ? 1 : 2);
            const assetList = assets.map(asset_name => ({ policy_id: policy, asset_name, quantity: '1', decimals: 0, fingerprint: '' }));
            const txOutput = { tx_hash: 'koios-new', tx_index: 0, datum_hash: null, stake_addr: null, value: '2000000', payment_addr: { bech32: knownAddress, cred: '' }, asset_list: assetList, inline_datum: null, reference_script: null };
            const tx = { tx_hash: 'koios-new', block_hash: 'dest-block', block_height: 1, absolute_slot: 150, reference_inputs: [], inputs: [], outputs: [txOutput], assets_minted: [], metadata: {} };
            let tip = mode === 'historical-sibling' ? { hash: 'later', abs_slot: 201 } : { hash: 'anchor', abs_slot: 200 };
            let laterSpend = mode === 'historical-sibling';
            const paths: string[] = [];
            const query = async (path: string, _method?: string, body?: string) => {
                paths.push(path);
                if (path === 'tip') return [tip];
                if (path === 'asset_utxos') {
                    expect(JSON.parse(body!)._asset_list).toEqual(targets.map(t => [t.policy, t.hex]));
                    return mode === 'missing' ? [] : [{ tx_hash: laterSpend ? 'koios-after' : 'koios-new', tx_index: 0, address: knownAddress, value: '2000000', asset_list: mode === 'historical-sibling' ? assetList.slice(0, 1) : assetList }];
                }
                if (path === 'tx_info') {
                    const hashes = JSON.parse(body!)._tx_hashes;
                    return hashes.map((hash: string) => {
                        if (hash === 'koios-new') return tx;
                        if (hash === 'koios-after' && laterSpend) return { ...tx, tx_hash: hash, absolute_slot: 201, inputs: [{ tx_hash: 'koios-new', tx_index: 0 }], outputs: [{ ...txOutput, tx_hash: hash, asset_list: mode === 'historical-sibling' ? assetList.slice(0, 1) : assetList }] };
                        throw new Error(`Unexpected transaction ${hash}`);
                    });
                }
                if (path === 'block_info') {
                    const hash = JSON.parse(body!)._block_hashes[0];
                    if (hash === 'later') return [{ hash, abs_slot: 201, parent_hash: 'anchor' }];
                    if (hash === 'anchor') return [{ hash, abs_slot: 200, parent_hash: 'older' }];
                    if (hash === 'fork') return [{ hash, abs_slot: 200, parent_hash: 'older' }];
                    return [];
                }
                throw new Error(`Unexpected Koios endpoint: ${path}`);
            };
            mockedHelpers.buildUTxOsFromKoiosTxs.mockImplementation(actualHelpers.buildUTxOsFromKoiosTxs);
            const lease = { acquire: Internal.acquireScannerLease, renew: Internal.renewScannerLease, release: Internal.releaseScannerLease };
            const peer = new RedisHandlesStore();
            const reader = new HandlesRepository(peer);
            const journalKey = getApiCacheKey('local-repair:journal');
            let realApp: any;
            if (mode === 'rollback') await buildAndStoreMptRootHash(store);
            if (mode === 'rollback' || mode === 'spent-crash') {
                const previousOgmios = process.env.ENABLE_OGMIOS_SCANNING;
                const previousScanner = process.env.USE_LAMBDA_SCANNER;
                process.env.USE_LAMBDA_SCANNER = 'false';
                try {
                    realApp = new (require('../app').default)({ disableOgmios: true });
                    await realApp.lambda();
                } finally {
                    if (previousOgmios === undefined) delete process.env.ENABLE_OGMIOS_SCANNING;
                    else process.env.ENABLE_OGMIOS_SCANNING = previousOgmios;
                    if (previousScanner === undefined) delete process.env.USE_LAMBDA_SCANNER;
                    else process.env.USE_LAMBDA_SCANNER = previousScanner;
                }
            }
            try {
                const operation = mode === 'spent-crash' ? (async () => {
                    const child = spawnSync(process.execPath, ['--import', 'tsx', 'tests/local-repair-crash-fixture.ts'], {
                        env: { ...process.env, LOCAL_REPAIR_TEST_FIXTURE: JSON.stringify({ targets, koios: { tip, row: { tx_hash: 'koios-new', tx_index: 0, address: knownAddress, value: '2000000', asset_list: assetList }, tx } }) }, encoding: 'utf8', timeout: 30_000
                    });
                    expect({ status: child.status, stderr: child.status === 87 ? '' : child.stderr }).toEqual({ status: 87, stderr: '' });
                    peer.redisClientCall('customCommand', ['PEXPIRE', getApiScannerLeaseKey(), '1']);
                    peer.redisClientCall('customCommand', ['PEXPIRE', getApiCacheKey('local-repair:lease'), '1']);
                    await new Promise(resolve => setTimeout(resolve, 20));
                    tip = { hash: 'later', abs_slot: 201 };
                    laterSpend = true;
                    throw new Error('child exited after first write');
                })() : localKoiosRepair(store, lease, targets, { query, afterFirstWrite: async () => {
                    expect(reader.currentHttpStatus()).toBe(503);
                    if (realApp) {
                        const response = await request(realApp.getServer()).get(`/handles/${names[0]}`);
                        expect(response.status).toBe(503);
                        expect(response.body).toEqual({ error: 'Repair in progress' });
                    }
                    if (mode === 'advance') { tip = { hash: 'later', abs_slot: 201 }; throw new Error('interrupted after chain advance'); }
                    if (mode === 'spent') { tip = { hash: 'later', abs_slot: 201 }; laterSpend = true; throw new Error('interrupted after later spend'); }
                    if (mode === 'rollback') tip = { hash: 'fork', abs_slot: 200 };
                } });
                if (mode === 'stable') await operation;
                else if (mode === 'missing' || mode === 'historical-sibling') {
                    await expect(operation).rejects.toThrow(mode === 'missing' ? 'Owner token is missing' : 'unplanned handle');
                    expect(peer.redisClientCall('get', journalKey) ?? null).toBeNull();
                    expect(names.map(name => repo.getHandle(name)?.utxo)).toEqual(['koios-old0#0', 'koios-old1#0']);
                    return;
                } else {
                    await expect(operation).rejects.toThrow(mode === 'advance' ? 'interrupted after chain advance' : mode === 'spent' ? 'interrupted after later spend' : mode === 'spent-crash' ? 'child exited after first write' : 'Koios tip does not descend from scanner cursor');
                    expect(reader.currentHttpStatus()).toBe(503);
                    expect(peer.redisClientCall('get', journalKey)).toContain('koios-old0#0');
                    if (mode === 'spent-crash') {
                        const blocked = await request(realApp.getServer()).get(`/handles/${names[0]}`);
                        expect(blocked.status).toBe(503);
                        expect(blocked.body).toEqual({ error: 'Repair in progress' });
                    }
                    if (mode === 'rollback') {
                        const address = repo.getHandle(names[0])!.resolved_addresses.ada;
                        const holder = repo.getHandle(names[0])!.holder;
                        const indexImage = () => ({
                            handles: names.map(name => repo.getHandle(name)),
                            sourceUtxos: [repo.getUTxO('koios-old0#0'), repo.getUTxO('koios-old1#0')],
                            destination: repo.getUTxO('koios-new#0'),
                            holder: [...(store.getValuesFromIndexedSet(IndexNames.HOLDER, holder) ?? [])].sort(),
                            address: [...(store.getValuesFromIndexedSet(IndexNames.ADDRESS, address) ?? [])].sort(),
                            payment: [...(store.getValuesFromIndexedSet(IndexNames.PAYMENT_KEY_HASH, getPaymentKeyHash(address)!) ?? [])].sort(),
                            slots: store.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, 0),
                            root: store.getMptRootHash(),
                            metrics: repo.getMetrics(),
                            journal: peer.redisClientCall('get', journalKey)
                        });
                        const beforeRefusal = indexImage();
                        expect(beforeRefusal.root).toMatch(/^[0-9a-f]{64}$/);
                        await expect(localKoiosRepair(store, lease, undefined, { query })).rejects.toThrow('Koios tip does not descend from scanner cursor');
                        expect(indexImage()).toEqual(beforeRefusal);
                        expect(reader.currentHttpStatus()).toBe(503);
                        const blocked = await request(realApp.getServer()).get(`/handles/${names[0]}`);
                        expect(blocked.status).toBe(503);
                        expect(blocked.body).toEqual({ error: 'Repair in progress' });
                        repo.setMetrics({ currentBlockHash: 'fork' });
                        tip = { hash: 'fork', abs_slot: 200 };
                        await expect(localKoiosRepair(store, lease, undefined, { query })).rejects.toThrow('Scanner cursor changed since repair began');
                        expect(reader.currentHttpStatus()).toBe(503);
                        repo.setMetrics({ currentBlockHash: 'anchor' });
                        tip = { hash: 'anchor', abs_slot: 200 };
                    }
                    await localKoiosRepair(store, lease, undefined, { query });
                }
                expect(paths).toContain('asset_utxos');
                expect(paths).toContain('tx_info');
                expect(names.map(name => repo.getHandle(name)?.utxo)).toEqual(['koios-new#0', 'koios-new#0']);
                expect(repo.getUTxO('koios-old0#0') ?? null).toBeNull();
                expect(repo.getUTxO('koios-old1#0') ?? null).toBeNull();
                expect(reader.currentHttpStatus()).not.toBe(503);
                expect(peer.redisClientCall('get', journalKey) ?? null).toBeNull();
                if (mode === 'spent' || mode === 'spent-crash') {
                    const after = { ...tx, tx_hash: 'koios-after', block_hash: 'later', absolute_slot: 201, inputs: [{ tx_hash: 'koios-new', tx_index: 0 }], outputs: [{ ...txOutput, tx_hash: 'koios-after' }] };
                    Internal.processScannerBlock({ id: 'later', slot: 201 }, [after], { hash: 'later', slot: 201 });
                    expect(names.map(name => repo.getHandle(name)?.utxo)).toEqual(['koios-after#0', 'koios-after#0']);
                    expect(repo.getUTxO('koios-new#0') ?? null).toBeNull();
                }
                if (realApp) {
                    const response = await request(realApp.getServer()).get(`/handles/${names[0]}`);
                    expect(response.status).toBe(200);
                    expect(response.body.utxo).toBe(mode === 'spent-crash' ? 'koios-after#0' : 'koios-new#0');
                }
            } finally {
                store.redisClientCall('del', [journalKey, getApiMptRebuildPendingKey()]);
            }
        });

        // A response that began before maintenance must not escape after a complete repair.
        // Negative control: removing the final epoch check returns the stale captured handle as 200.
        it('blocks new HTTP readers and responses spanning the actual local repair', async () => {
            repo.setMetrics({ currentSlot: 200 });
            const name = 'http-repair';
            const asset = Buffer.from(name).toString('hex');
            repo.addUTxOsWithMintDataAndUpdateIndexes([{ ...utxo('old-http#0', name, 90, true), handles: [[policy, [asset]]], mint: [[policy, [asset]]] }]);
            const canonical = { ...utxo('new-http#0', name, 150, false), handles: [[policy, [asset]]] as [string, string[]][] };
            const target = { name, policy, hex: asset };
            const lease = { acquire: Internal.acquireScannerLease, renew: Internal.renewScannerLease, release: Internal.releaseScannerLease };
            const peer = new RedisHandlesStore();
            const previousOgmios = process.env.ENABLE_OGMIOS_SCANNING;
            const previousScanner = process.env.USE_LAMBDA_SCANNER;
            process.env.USE_LAMBDA_SCANNER = 'false';
            let realApp: any;
            try {
                realApp = new (require('../app').default)({ disableOgmios: true });
                await realApp.lambda();
            } finally {
                if (previousOgmios === undefined) delete process.env.ENABLE_OGMIOS_SCANNING;
                else process.env.ENABLE_OGMIOS_SCANNING = previousOgmios;
                if (previousScanner === undefined) delete process.env.USE_LAMBDA_SCANNER;
                else process.env.USE_LAMBDA_SCANNER = previousScanner;
            }
            const app = express();
            app.use(localRepairGuard(() => peer));
            let enter!: () => void;
            let resume!: () => void;
            const entered = new Promise<void>(resolve => { enter = resolve; });
            const continued = new Promise<void>(resolve => { resume = resolve; });
            app.get('/handle', (_req, res) => { res.json(repo.getHandle(name)); });
            app.get('/slow', async (_req, res) => { const captured = repo.getHandle(name); enter(); await continued; res.json(captured); });
            const inFlight = request(app).get('/slow').then(response => response);
            await entered;
            try {
                await localRepair(store, lease, [target], async () => [canonical], async () => {
                    const response = await request(app).get('/handle');
                    expect(response.status).toBe(503);
                    expect(response.body).toEqual({ error: 'Repair in progress' });
                    const actualHandle = await request(realApp.getServer()).get(`/handles/${name}`);
                    expect(actualHandle.status).toBe(503);
                    expect(actualHandle.body).toEqual({ error: 'Repair in progress' });
                    const actualProof = await request(realApp.getServer()).get('/mpt-root/proof?handle=http-repair&label=000643b0&amount=1');
                    expect(actualProof.status).toBe(503);
                    expect(actualProof.body).toEqual({ error: 'Repair in progress' });
                });
                resume();
                const stale = await inFlight;
                expect(stale.status).toBe(503);
                expect(stale.body).toEqual({ error: 'Repair in progress' });
                const fresh = await request(app).get('/handle');
                expect(fresh.status).toBe(200);
                expect(fresh.body.utxo).toBe('new-http#0');
                const actualFresh = await request(realApp.getServer()).get(`/handles/${name}`);
                expect(actualFresh.status).toBe(200);
                expect(actualFresh.body.utxo).toBe('new-http#0');
            } finally {
                resume();
                store.redisClientCall('del', [getApiCacheKey('local-repair:journal'), getApiMptRebuildPendingKey()]);
            }
        });

        // Real preflight, lease, repository pipelines, indexes and MPT rebuild use isolated Valkey.
        // Injecting lease loss after the first repository batch proves partial state needs the saved
        // journal; replay without that journal cannot know which old UTxOs remain to be removed.
        it.each(['success', 'lease-lost', 'crash'] as const)('reconciles a shared output under the real fence: %s', async (mode) => {
            const names = ['xn--8o8hx2f', 'xn--kong-tz14c'];
            const assets = names.map(name => Buffer.from(name).toString('hex'));
            for (let i = 0; i < names.length; i++) {
                repo.addUTxOsWithMintDataAndUpdateIndexes([{ ...utxo(`old${i}#0`, names[i], 90, true), handles: [[policy, [assets[i]]]], mint: [[policy, [assets[i]]]] }]);
            }
            const ownerAddress = 'addr_test1qz8zyhdetz270qzfvkym38wx4wsqzx0m49urfu3wjkqsuchs8t4235v9t0x5grxm2hel388ypz0q3fng8k6am5hqzacq0fc746';
            const oldAddress = repo.getHandle(names[0])!.resolved_addresses.ada;
            const oldHolder = repo.getHandle(names[0])!.holder;
            const beforeMetrics = repo.getMetrics();
            const beforeRoot = await buildAndStoreMptRootHash(store);
            const canonical = { ...utxo('cancel#0', names[0], 150, false), address: ownerAddress, handles: [[policy, assets]] as [string, string[]][] };
            const targets = names.map((name, i) => ({ name, policy, hex: assets[i] }));
            const journalKey = getApiCacheKey(`repair-local-test:${randomUUID()}`);
            const snapshotKey = getApiCacheKey(`repair-local-owner:${randomUUID()}`);
            const progressKey = getApiCacheKey(`repair-local-progress:${randomUUID()}`);
            const pendingKey = getApiMptRebuildPendingKey();
            const scannerKey = getApiScannerLeaseKey();
            const peer = new RedisHandlesStore();
            let scannerOwner = '';
            let fence: any;
            let oldIds = ['old0#0', 'old1#0'];
            const acquireAndCheck = async (repairTargets = targets) => {
                const lease = { acquire: (owner: string) => { scannerOwner = owner; return Internal.acquireScannerLease(owner); }, renew: Internal.renewScannerLease, release: () => {} };
                return repairPreflight(repairTargets, lease, name => repo.getHandle(name), id => repo.getUTxO(id) ?? null, async () => [{ id: canonical.id, address: canonical.address, handles: canonical.handles }]);
            };
            const startFence = () => {
                fence = { key: snapshotKey, owner: randomUUID(), scannerKey, scannerOwner, ownsScannerLease: false };
                const raw = store.redisClientCall('hgetall', getApiMetricsKey());
                const originalMetrics = Object.fromEntries(raw.map(({ field, value }: any) => [String(field), String(value)]));
                expect(store.redisClientCall('snapshotClaim', { fence, scannerOriginal: scannerOwner, metricsKey: getApiMetricsKey(), progressKey,
                    originalMetrics, originalProgress: {}, requireEmpty: false, pattern: '', dataRoots: [] })).toBe(true);
                (store as any).snapshotFence = fence;
            };
            const endFence = () => {
                (store as any).snapshotFence = undefined;
                if (fence) store.redisClientCall('snapshotRelease', fence);
                fence = undefined;
            };
            try {
                await acquireAndCheck();
                startFence();
                store.redisClientCall('set', journalKey, JSON.stringify({ old: oldIds, targets, canonical: canonical.id }));
                store.redisClientCall('set', pendingKey, '1');
                repo.addUTxOsWithMintDataAndUpdateIndexes([canonical]);
                if (mode === 'lease-lost') {
                    peer.redisClientCall('set', scannerKey, 'successor');
                    expect(() => repo.removeUTxOs(['old0#0', 'old1#0'])).toThrow(/fence lost|fence changed/);
                    endFence();
                    expect(peer.redisClientCall('get', scannerKey)).toBe('successor');
                    Internal.releaseScannerLease('successor');
                } else if (mode === 'crash') {
                    // Simulate a dead process: do not release either lock; let their real Valkey TTLs expire.
                    (store as any).snapshotFence = undefined;
                    fence = undefined;
                    peer.redisClientCall('customCommand', ['PEXPIRE', scannerKey, '1']);
                    peer.redisClientCall('customCommand', ['PEXPIRE', snapshotKey, '1']);
                    await new Promise(resolve => setTimeout(resolve, 20));
                    expect(peer.redisClientCall('get', scannerKey) ?? null).toBeNull();
                    expect(peer.redisClientCall('get', snapshotKey) ?? null).toBeNull();
                }
                if (mode !== 'success') {
                    const saved = JSON.parse(peer.redisClientCall('get', journalKey));
                    expect(saved).toEqual({ old: ['old0#0', 'old1#0'], targets, canonical: canonical.id });
                    oldIds = saved.old;
                    expect(peer.redisClientCall('get', pendingKey)).toBe('1');
                    expect(repo.getUTxO('old0#0')).toEqual(expect.objectContaining({ id: 'old0#0' }));
                    expect(repo.getUTxO('old1#0')).toEqual(expect.objectContaining({ id: 'old1#0' }));
                    expect(names.map(name => repo.getHandle(name)?.utxo)).toEqual([canonical.id, canonical.id]);
                    await acquireAndCheck(saved.targets);
                    startFence();
                    repo.addUTxOsWithMintDataAndUpdateIndexes([canonical]);
                }
                repo.removeUTxOs(oldIds);
                expect(await buildAndStoreMptRootHash(store)).toBe(beforeRoot);
                store.redisClientCall('del', [pendingKey, journalKey]);
                endFence();
                for (const name of names) {
                    expect(repo.getHandle(name)).toEqual(expect.objectContaining({ utxo: canonical.id, resolved_addresses: expect.objectContaining({ ada: ownerAddress }) }));
                    expect(store.getValuesFromIndexedSet(IndexNames.ADDRESS, ownerAddress)?.has(name)).toBe(true);
                    expect(store.getValuesFromIndexedSet(IndexNames.ADDRESS, oldAddress)?.has(name) ?? false).toBe(false);
                    expect(store.getValuesFromIndexedSet(IndexNames.HOLDER, oldHolder)?.has(name) ?? false).toBe(false);
                    expect(store.getValuesFromIndexedSet(IndexNames.PAYMENT_KEY_HASH, getPaymentKeyHash(ownerAddress)!)?.has(name)).toBe(true);
                }
                expect(repo.getUTxO(canonical.id)).toEqual(expect.objectContaining({ handles: canonical.handles }));
                expect(repo.getUTxO('old0#0') ?? null).toBeNull(); expect(repo.getUTxO('old1#0') ?? null).toBeNull();
                expect(store.getMptRootHash()).toBe(beforeRoot);
                expect(repo.getMetrics()).toEqual(expect.objectContaining({ currentSlot: beforeMetrics.currentSlot, currentBlockHash: beforeMetrics.currentBlockHash }));
                expect(store.redisClientCall('get', journalKey) ?? null).toBeNull();
                expect(store.redisClientCall('get', pendingKey) ?? null).toBeNull();
            } finally {
                endFence();
                if (scannerOwner) Internal.releaseScannerLease(scannerOwner);
                Internal.releaseScannerLease('successor');
                store.redisClientCall('del', [journalKey, pendingKey]);
            }
        });

        it('reapplies a verified shared output without moving the scanner cursor', () => {
            // Invariant: targeted recovery updates both holders and UTxOs without replaying the historical block.
            // Updating only the handle hash leaves the old holder index or UTxO behind.
            const names = ['xn--8o8hx2f', 'xn--kong-tz14c'];
            const assets = names.map((name) => Buffer.from(name).toString('hex'));
            for (let i = 0; i < names.length; i++) {
                repo.addUTxOsWithMintDataAndUpdateIndexes([{ ...utxo(`old${i}#0`, names[i], 90, true), handles: [[policy, [assets[i]]]], mint: [[policy, [assets[i]]]] }]);
            }
            const oldHolder = repo.getHandle(names[0])!.holder;
            const oldAddress = repo.getHandle(names[0])!.resolved_addresses.ada;
            const owner = 'addr_test1qz8zyhdetz270qzfvkym38wx4wsqzx0m49urfu3wjkqsuchs8t4235v9t0x5grxm2hel388ypz0q3fng8k6am5hqzacq0fc746';
            const before = repo.getMetrics();
            const canonical = { ...utxo('cancel#0', names[0], 150, false), address: owner, handles: [[policy, assets]] as [string, string[]][] };
            repo.addUTxOsWithMintDataAndUpdateIndexes([canonical]);
            repo.removeUTxOs(['old0#0', 'old1#0']);
            const newHolder = repo.getHandle(names[0])!.holder;
            expect(newHolder).not.toBe(oldHolder);
            for (const name of names) {
                expect(repo.getHandle(name)).toEqual(expect.objectContaining({ utxo: 'cancel#0', holder: newHolder, resolved_addresses: expect.objectContaining({ ada: owner }) }));
                expect(store.getValuesFromIndexedSet(IndexNames.HOLDER, newHolder)?.has(name)).toBe(true);
                expect(store.getValuesFromIndexedSet(IndexNames.HOLDER, oldHolder)?.has(name) ?? false).toBe(false);
                expect(store.getValuesFromIndexedSet(IndexNames.ADDRESS, owner)?.has(name)).toBe(true);
                expect(store.getValuesFromIndexedSet(IndexNames.ADDRESS, oldAddress)?.has(name) ?? false).toBe(false);
                expect(store.getValuesFromIndexedSet(IndexNames.PAYMENT_KEY_HASH, getPaymentKeyHash(owner)!)?.has(name)).toBe(true);
                expect(store.getValuesFromIndexedSet(IndexNames.PAYMENT_KEY_HASH, getPaymentKeyHash(oldAddress)!)?.has(name) ?? false).toBe(false);
            }
            expect(store.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, 150)).toContain('cancel#0');
            expect(store.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, 90) ?? []).not.toContain('old0#0');
            expect(store.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, 90) ?? []).not.toContain('old1#0');
            expect(repo.getUTxO('cancel#0')).toEqual(expect.objectContaining({ address: owner }));
            expect(repo.getUTxO('old0#0') ?? null).toBeNull();
            expect(repo.getUTxO('old1#0') ?? null).toBeNull();
            expect(repo.getMetrics()).toEqual(expect.objectContaining({ currentSlot: before.currentSlot, currentBlockHash: before.currentBlockHash }));
        });

        it('does not resurrect a handle moved and then burned in the same block', () => {
            const name = `intra-burn-${Date.now()}`;
            repo.addUTxOsWithMintDataAndUpdateIndexes([utxo('mint_tx#0', name, 90, true)]);
            expect(repo.getHandle(name)?.utxo).toBe('mint_tx#0');

            mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([utxo('move_tx#1', name, 150, false)]);
            Internal.processScannerBlock(block, [tx('move_tx', ['mint_tx#0']), tx('burn_tx', ['move_tx#1'], [name])] as never, tip);

            expect(repo.getHandle(name)).toBeNull();
            expect(repo.getUTxO('move_tx#1') ?? null).toBeNull();
        });

        it('lands a handle moved twice in one block on the output that survives the block', () => {
            const name = `intra-move-${Date.now()}`;
            repo.addUTxOsWithMintDataAndUpdateIndexes([utxo('mint_tx#0', name, 90, true)]);

            mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([utxo('hop_b#0', name, 150, false), utxo('hop_c#0', name, 150, false)]);
            Internal.processScannerBlock(block, [tx('hop_b', ['mint_tx#0']), tx('hop_c', ['hop_b#0'])] as never, tip);

            expect(repo.getHandle(name)?.utxo).toBe('hop_c#0');
            expect(repo.getUTxO('hop_b#0') ?? null).toBeNull();
        });

        it('keeps the mint data of a handle minted and moved in the same block', () => {
            const name = `intra-mint-${Date.now()}`;
            mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([utxo('new_mint#0', name, 150, true), utxo('new_move#0', name, 150, false)]);
            Internal.processScannerBlock(block, [tx('new_mint', []), tx('new_move', ['new_mint#0'])] as never, tip);

            const stored = repo.getHandle(name);
            expect(stored?.utxo).toBe('new_move#0');
            expect(stored?.created_slot_number).toBe(150);
        });
    });
});
