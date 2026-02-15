import { IndexNames, LockedLambdaReason, UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import { HandlesRepository } from '../repositories/handlesRepository';
import { RedisHandlesStore } from '../stores/redis';
import * as helpers from '../utils/helpers';

jest.mock('../utils/helpers');

const scanner = require('./scanner');
const { lambdaHandler } = scanner;
const mockedHelpers = helpers as jest.Mocked<typeof helpers>;

const policy = 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a';
const handleHex = '000de140726f6c6c6261636b';
const knownAddress = 'addr_test1qzdzhdzf9ud8k2suzryvcdl78l3tfesnwp962vcuh99k8z834r3hjynmsy2cxpc04a6dkqxcsr29qfl7v9cmrd5mm89qfmc97q';

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
        repo.rollBackToGenesis();
        repo.addUTxOsWithMintData([buildTrackedUtxo()]);
        repo.setMetrics({
            currentSlot: 140,
            lastSlot: 200,
            currentBlockHash: 'provider_block',
            tipBlockHash: 'provider_block',
            lastMaxRollbackCheck: Date.now(),
            indexSchemaVersion: Number(store.getIndexSchemaVersion()),
            lockLambdas: LockedLambdaReason.UNLOCKED
        });
        jest.clearAllMocks();
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

    it('returns early without making changes when lambdas are locked', async () => {
        repo.setMetrics({ lockLambdas: LockedLambdaReason.REINDEX });
        const initialMetrics = repo.getMetrics();

        await lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context);

        const finalMetrics = repo.getMetrics();
        expect(finalMetrics.lockLambdas).toBe(LockedLambdaReason.REINDEX);
        expect(finalMetrics.indexSchemaVersion).toEqual(initialMetrics.indexSchemaVersion);
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
        store.redisClientCall('set', 'scanner:recovery', 'rollback');
        repo.setMetrics({
            lockLambdas: LockedLambdaReason.UNLOCKED,
            indexSchemaVersion: Number(store.getIndexSchemaVersion()),
            currentBlockHash: 'provider_block',
            currentSlot: 140
        });

        const result = await lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context);

        expect(result).toBeUndefined();
        expect(store.redisClientCall('get', 'scanner:recovery')).toBeFalsy();
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

    it('keeps lock healthy and skips rollback replay when hashes match', async () => {
        mockedHelpers.blockfrostApiCall.mockResolvedValue({ ok: true, json: async () => ({ height: 5000 }) } as never);
        mockedHelpers.fetchPaginatedResults
            .mockResolvedValueOnce([] as never)
            .mockResolvedValueOnce([{ hash: 'provider_block', slot: 100 }] as never);
        mockedHelpers.fetchKoios.mockImplementation(async (path: string) => {
            if (path === 'block_txs') return [{ tx_hash: 'rollback_tx' }] as never;
            if (path === 'asset_utxos') return [{ tx_hash: 'rollback_tx' }] as never;
            if (path === 'tx_info') return [{ source: 'tx_info' }] as never;
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockImplementation((txs: any[]) => {
            if (txs?.[0]?.source === 'tx_info') {
                return [buildTrackedUtxo({ id: 'rollback_tx#0', tx_id: 'rollback_tx', slot: 100, blockHash: 'provider_block' })] as never;
            }
            return [] as never;
        });

        await lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context);

        expect(repo.getMetrics().lockLambdas).toBe(LockedLambdaReason.UNLOCKED);
        expect(mockedHelpers.fetchPaginatedResults).toHaveBeenCalledWith('blocks/4980/next');
        expect(mockedHelpers.fetchKoios).toHaveBeenCalledWith('block_txs', 'POST', expect.any(String));
        expect(repo.getUTxO('rollback_tx#0')).toEqual(expect.objectContaining({ tx_id: 'rollback_tx' }));
    });

    it('replays divergent rollback blocks and updates handle ownership state', async () => {
        repo.rollBackToGenesis();
        repo.addUTxOsWithMintDataAndUpdateIndexes([buildTrackedUtxo({ id: 'stale_tx#0', tx_id: 'stale_tx', blockHash: 'api_block' })]);
        repo.setMetrics({
            currentSlot: 140,
            currentBlockHash: 'api_block',
            lastMaxRollbackCheck: Date.now(),
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

    it('clears lock even when rollback provider call fails', async () => {
        mockedHelpers.blockfrostApiCall.mockResolvedValue({ ok: false } as never);
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([] as never);

        await expect(lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context)).rejects.toThrow('Not good!');

        expect(repo.getMetrics().lockLambdas).toBe(LockedLambdaReason.UNLOCKED);
    });
});
