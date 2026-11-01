import { IndexNames, LockedLambdaReason, UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import { HandlesRepository } from '../repositories/handlesRepository';
import { RedisHandlesStore } from '../stores/redis';
import { getApiScannerRecoveryKey } from '../stores/redis/keys';
import * as helpers from '../utils/helpers';

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
        store.redisClientCall('del', [getApiScannerRecoveryKey()]);
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

    it('scans block updates and persists handle + metrics', async () => {
        const handleName = `scanner-${Date.now()}`;

        mockedHelpers.blockfrostApiCall.mockResolvedValue({ ok: true, json: async () => ({ height: 5000 }) } as never);
        mockedHelpers.fetchPaginatedResults
            .mockResolvedValueOnce([{ hash: 'ignored_future', slot: 999 }] as never)
            .mockResolvedValueOnce([{ hash: 'next_hash', slot: 101, confirmations: 21 }] as never);
        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([buildMintedUTxO(handleName)]);
        mockedHelpers.fetchKoios.mockResolvedValue([] as never);

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
            .mockResolvedValueOnce([{ hash: 'next_hash', slot: 101, confirmations: 21 }] as never)
            .mockResolvedValueOnce([] as never);
        mockedHelpers.fetchKoios.mockImplementation(async (path: string) => {
            if (path === 'block_txs') return [{ tx_hash: 'scan_tx' }] as never;
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
