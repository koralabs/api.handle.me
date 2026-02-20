import { AssetNameLabel, IndexNames, LockedLambdaReason, UTxOFunctionName } from '@koralabs/kora-labs-common';
import { HandlesRepository } from '../repositories/handlesRepository';
import { getHandleNameFromAssetName } from '../services/ogmios/utils';
import { RedisHandlesStore } from '../stores/redis';
import * as helpers from '../utils/helpers';

jest.mock('../utils/helpers');
jest.mock('../stores/redis');
jest.mock('../repositories/handlesRepository');
jest.mock('../services/ogmios/utils');

const mockedHelpers = helpers as jest.Mocked<typeof helpers>;
const mockedGetHandleNameFromAssetName = getHandleNameFromAssetName as jest.Mock;
const MockedStoreClass = RedisHandlesStore as unknown as jest.Mock;
const MockedRepoClass = HandlesRepository as unknown as jest.Mock;

const policy = 'policy';
const knownAddress = 'addr_test1qzdzhdzf9ud8k2suzryvcdl78l3tfesnwp962vcuh99k8z834r3hjynmsy2cxpc04a6dkqxcsr29qfl7v9cmrd5mm89qfmc97q';

const buildUtxo = ({
    id,
    slot,
    blockHash,
    assetName
}: {
    id: string;
    slot: number;
    blockHash: string;
    assetName: string;
}) =>
    ({
        id,
        tx_id: id.split('#')[0],
        index: Number(id.split('#')[1] ?? 0),
        slot,
        blockHash,
        blockNum: 1,
        address: knownAddress,
        lovelace: 1,
        handles: [[policy, [assetName]]],
        mint: [[policy, [assetName]]],
        metadata: {
            '721': {
                [policy]: {
                    [assetName]: {
                        name: '$mock',
                        image: 'ipfs://mock',
                        mediaType: 'image/png',
                        og: 0,
                        og_number: 0,
                        rarity: 'basic',
                        length: 4,
                        characters: 'letters',
                        numeric_modifiers: '',
                        version: 1
                    }
                }
            }
        }
    }) as any;

const loadScannerModule = () => {
    let scannerModule: any;
    jest.isolateModules(() => {
        scannerModule = require('./scanner');
    });
    return scannerModule;
};

const setup = () => {
    const pipelineResponses: any[] = [];
    const kvStore = new Map<string, string>();
    const store = {
        initialize: jest.fn(),
        getValuesFromIndexedSet: jest.fn(),
        getValuesFromOrderedSet: jest.fn(),
        pipeline: jest.fn((commands: CallableFunction) => {
            commands();
            return pipelineResponses.shift() ?? [];
        }),
        redisClientCall: jest.fn((cmd: string, ...args: any[]) => {
            if (cmd === 'set') {
                const [key, value, options] = args;
                const existing = kvStore.get(key);
                if (options?.conditionalSet === 'onlyIfDoesNotExist') {
                    if (existing !== undefined) return null;
                    kvStore.set(key, value);
                    return 'OK';
                }
                if (options?.conditionalSet === 'onlyIfEqual') {
                    if (existing !== options.comparisonValue) return null;
                    kvStore.set(key, value);
                    return 'OK';
                }
                kvStore.set(key, value);
                return 'OK';
            }
            if (cmd === 'get') {
                const [key] = args;
                return kvStore.get(key);
            }
            if (cmd === 'pexpire') {
                const [key] = args;
                return kvStore.has(key) ? 1 : 0;
            }
            if (cmd === 'del') {
                const [keys] = args as [string[]];
                for (const key of keys) kvStore.delete(key);
                return keys.length;
            }
            return undefined;
        }),
        removeValueFromIndexedSet: jest.fn(),
        getIndexSchemaVersion: jest.fn().mockReturnValue(1),
        getUTxOSchemaVersion: jest.fn().mockReturnValue(1),
        repopulateIndexesFromUTxOs: jest.fn()
    };

    const handlesRepo = {
        initialize: jest.fn().mockResolvedValue(undefined),
        addUTxO: jest.fn(),
        addUTxOsWithMintData: jest.fn(),
        addUTxOsWithMintDataAndUpdateIndexes: jest.fn(),
        getHandle: jest.fn(),
        getHandleMintingData: jest.fn(),
        getMetrics: jest.fn().mockReturnValue({
            currentSlot: 130,
            currentBlockHash: 'start_hash',
            utxoSchemaVersion: 1,
            indexSchemaVersion: 1,
            lastMaxRollbackCheck: Date.now(),
            lockLambdas: LockedLambdaReason.UNLOCKED
        }),
        getStartingPoint: jest.fn().mockResolvedValue({ id: 'start_hash', slot: 130 }),
        getUTxO: jest.fn(),
        removeHandle: jest.fn(),
        removeUTxOs: jest.fn(),
        setMetrics: jest.fn(),
        updateHandleIndexes: jest.fn(),
        updateHolder: jest.fn()
    };

    MockedStoreClass.mockImplementation(() => store);
    MockedRepoClass.mockImplementation(() => handlesRepo);
    mockedHelpers.blockfrostApiCall.mockResolvedValue({ ok: true, json: async () => ({ height: 5000 }) } as any);
    mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'provider_block', slot: 100 }] as never);
    mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);
    mockedHelpers.fetchKoios.mockResolvedValue([] as never);
    mockedGetHandleNameFromAssetName.mockImplementation((assetName: string) => ({
        name: assetName,
        ownerTokenHex: assetName,
        isCip67: false,
        assetLabel: null
    }));

    return {
        handlesRepo,
        pipelineResponses,
        scannerModule: loadScannerModule(),
        store
    };
};

describe('Scanner lambda unit tests', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('exports lambdaHandler and Internal helpers', () => {
        const { scannerModule } = setup();
        expect(typeof scannerModule.lambdaHandler).toBe('function');
        expect(scannerModule.Internal).toEqual(
            expect.objectContaining({
                checkRollback: expect.any(Function),
                processRollback: expect.any(Function),
                processReindex: expect.any(Function),
                scan: expect.any(Function)
            })
        );
    });

    it('returns early when lambdas are locked', async () => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ lockLambdas: LockedLambdaReason.ROLLBACK_20, currentSlot: 100 });

        await expect(scannerModule.lambdaHandler({} as any, {} as any)).resolves.toBeUndefined();

        expect(handlesRepo.getMetrics).toHaveBeenCalledTimes(1);
        expect(handlesRepo.setMetrics).not.toHaveBeenCalled();
        expect(mockedHelpers.blockfrostApiCall).not.toHaveBeenCalled();
    });

    it('runs short rollback path and unlocks after success', async () => {
        const { handlesRepo, pipelineResponses, scannerModule, store } = setup();
        store.getValuesFromOrderedSet.mockReturnValue(['utxo#0']);
        pipelineResponses.push([buildUtxo({ id: 'utxo#0', slot: 100, blockHash: 'provider_block', assetName: 'asset-a' })]);

        await scannerModule.Internal.checkRollback({ currentSlot: 130, lastMaxRollbackCheck: Date.now() });

        expect(mockedHelpers.fetchPaginatedResults).toHaveBeenCalledWith('blocks/4980/next');
        expect(handlesRepo.setMetrics).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ lockLambdas: LockedLambdaReason.ROLLBACK_20, lockLambdasTimestamp: expect.any(Number) })
        );
        expect(handlesRepo.setMetrics).toHaveBeenLastCalledWith({ lockLambdas: LockedLambdaReason.UNLOCKED });
    });

    it('does not run max rollback path while it is disabled', async () => {
        const { handlesRepo, pipelineResponses, scannerModule, store } = setup();
        store.getValuesFromOrderedSet.mockReturnValue(['utxo#0']);
        pipelineResponses.push([buildUtxo({ id: 'utxo#0', slot: 100, blockHash: 'provider_block', assetName: 'asset-a' })]);

        await scannerModule.Internal.checkRollback({ currentSlot: 130, lastMaxRollbackCheck: 0 });

        expect(mockedHelpers.fetchPaginatedResults).toHaveBeenCalledWith('blocks/4980/next');
        expect(handlesRepo.setMetrics).not.toHaveBeenCalledWith(
            expect.objectContaining({ lockLambdas: LockedLambdaReason.ROLLBACK_2160 })
        );
        expect(handlesRepo.setMetrics).not.toHaveBeenCalledWith(expect.objectContaining({ lastMaxRollbackCheck: expect.any(Number) }));
        expect(handlesRepo.setMetrics).toHaveBeenLastCalledWith({ lockLambdas: LockedLambdaReason.UNLOCKED });
    });

    it('ignores future provider blocks when comparing hashes', async () => {
        const { pipelineResponses, scannerModule, store } = setup();
        store.getValuesFromOrderedSet.mockReturnValue(['utxo#0']);
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([
            { hash: 'provider_block', slot: 100 },
            { hash: 'future_block', slot: 200 }
        ] as never);
        pipelineResponses.push([buildUtxo({ id: 'utxo#0', slot: 100, blockHash: 'provider_block', assetName: 'asset-a' })]);

        await scannerModule.Internal.checkRollback({ currentSlot: 130, lastMaxRollbackCheck: Date.now() });

        expect(mockedHelpers.fetchKoios).toHaveBeenCalledWith('block_txs', 'POST', expect.any(String));
    });

    it('releases lock when rollback processing throws', async () => {
        const { handlesRepo, scannerModule } = setup();
        mockedHelpers.blockfrostApiCall.mockResolvedValue({ ok: false } as any);

        await expect(scannerModule.Internal.checkRollback({ currentSlot: 130, lastMaxRollbackCheck: Date.now() })).rejects.toThrow('Not good!');

        expect(handlesRepo.setMetrics).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ lockLambdas: LockedLambdaReason.ROLLBACK_20, lockLambdasTimestamp: expect.any(Number) })
        );
        expect(handlesRepo.setMetrics).toHaveBeenLastCalledWith({ lockLambdas: LockedLambdaReason.UNLOCKED });
    });

    it('replays rollback discrepancies, removes in-range mint data, and refreshes indexes', async () => {
        const { handlesRepo, pipelineResponses, scannerModule, store } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentSlot: 300, lastMaxRollbackCheck: Date.now(), lockLambdas: LockedLambdaReason.UNLOCKED });
        store.getValuesFromOrderedSet.mockReturnValue(['u1']);
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'provider_a', slot: 200 }] as never);

        mockedGetHandleNameFromAssetName.mockImplementation((assetName: string) => {
            if (assetName === 'asset-a') {
                return { name: 'handle-a', ownerTokenHex: 'asset-a', isCip67: false, assetLabel: null };
            }
            return { name: assetName, ownerTokenHex: assetName, isCip67: false, assetLabel: null };
        });

        const mintToRemove = JSON.stringify({ created_slot: 205, metadata: {}, txHash: 'mint-a' });
        const mintToKeepForReplay = JSON.stringify({ created_slot: 150, metadata: {}, txHash: 'mint-b' });

        pipelineResponses.push(
            [buildUtxo({ id: 'u1', slot: 200, blockHash: 'api_a', assetName: 'asset-a' })],
            [{ name: 'handle-a', policy: 'policy-a', hex: 'asset-a', resolved_addresses: { ada: knownAddress } }],
            [new Set([mintToRemove])],
            [new Set(['handle-a'])],
            [],
            [new Set([mintToKeepForReplay])]
        );

        mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
            if (path === 'block_txs') return [{ tx_hash: 'provider_tx_1' }] as never;
            if (path === 'asset_utxos') return [{ tx_hash: 'tx_info_1' }] as never;
            if (path === 'tx_info' && body?.includes('provider_tx_1')) return [{ source: 'from-provider-tx-info' }] as never;
            if (path === 'tx_info' && body?.includes('tx_info_1')) return [{ source: 'from-latest-tx-info' }] as never;
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockImplementation((txs: any[]) => {
            if (txs?.[0]?.source === 'from-provider-tx-info') {
                return [buildUtxo({ id: 'replay_block#0', slot: 201, blockHash: 'provider_a', assetName: 'asset-a' })] as never;
            }
            if (txs?.[0]?.source === 'from-latest-tx-info') {
                return [buildUtxo({ id: 'replay_tx_info#0', slot: 202, blockHash: 'provider_a', assetName: 'asset-a' })] as never;
            }
            return [] as never;
        });

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
            await scannerModule.Internal.checkRollback({ currentSlot: 300, lastMaxRollbackCheck: Date.now() });
            expect(logSpy.mock.calls.some(([entry]) => `${entry}`.includes('Rollback detected from slot'))).toBe(true);
        } finally {
            logSpy.mockRestore();
        }

        expect(store.removeValueFromIndexedSet).toHaveBeenCalledWith(IndexNames.MINT, 'handle-a', mintToRemove);
        expect(handlesRepo.removeUTxOs).toHaveBeenCalledWith(['u1']);
        expect(handlesRepo.addUTxOsWithMintData).toHaveBeenCalledWith([expect.objectContaining({ id: 'replay_block#0' })]);
        expect(handlesRepo.updateHandleIndexes).toHaveBeenCalledWith(expect.objectContaining({ id: 'replay_tx_info#0' }), expect.any(Map), expect.any(Map));
    });

    it('filters unrelated handles from latest rollback UTxOs before index refresh', async () => {
        const { handlesRepo, pipelineResponses, scannerModule, store } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentSlot: 300, lastMaxRollbackCheck: Date.now(), lockLambdas: LockedLambdaReason.UNLOCKED });
        store.getValuesFromOrderedSet.mockReturnValue(['u1']);
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'provider_a', slot: 200 }] as never);

        mockedGetHandleNameFromAssetName.mockImplementation((assetName: string) => {
            if (assetName === 'asset-a') {
                return { name: 'handle-a', ownerTokenHex: 'asset-a', isCip67: false, assetLabel: null };
            }
            if (assetName === 'asset-z') {
                return { name: 'handle-z', ownerTokenHex: 'asset-z', isCip67: false, assetLabel: null };
            }
            return { name: assetName, ownerTokenHex: assetName, isCip67: false, assetLabel: null };
        });

        const mintToKeepForReplay = JSON.stringify({ created_slot: 150, metadata: {}, txHash: 'mint-b' });

        pipelineResponses.push(
            [buildUtxo({ id: 'u1', slot: 200, blockHash: 'api_a', assetName: 'asset-a' })],
            [{ name: 'handle-a', policy: 'policy-a', hex: 'asset-a', resolved_addresses: { ada: knownAddress } }],
            [new Set([mintToKeepForReplay])],
            [new Set(['handle-a'])],
            [],
            [new Set([mintToKeepForReplay])]
        );

        mockedHelpers.fetchKoios.mockImplementation(async (path: string) => {
            if (path === 'asset_utxos') return [{ tx_hash: 'tx_info_1' }] as never;
            if (path === 'tx_info') return [{ source: 'from-tx-info' }] as never;
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockImplementation((txs: any[]) => {
            if (txs?.[0]?.source === 'from-tx-info') {
                const replayUtxo = buildUtxo({ id: 'replay_tx_info#0', slot: 202, blockHash: 'provider_a', assetName: 'asset-a' });
                replayUtxo.handles = [[policy, ['asset-a', 'asset-z']]];
                replayUtxo.mint = [[policy, ['asset-a', 'asset-z']]];
                return [replayUtxo] as never;
            }
            return [] as never;
        });

        await scannerModule.Internal.checkRollback({ currentSlot: 300, lastMaxRollbackCheck: Date.now() });

        expect(handlesRepo.updateHandleIndexes).toHaveBeenCalledTimes(1);
        const [updatedUtxo] = handlesRepo.updateHandleIndexes.mock.calls[0];
        expect(updatedUtxo.handles).toEqual([[policy, ['asset-a']]]);
        expect(updatedUtxo.mint).toEqual([[policy, ['asset-a']]]);
    });

    it('uses the first divergent block as rollback cutoff for filtering and replay', async () => {
        const { handlesRepo, pipelineResponses, scannerModule, store } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentSlot: 300, lastMaxRollbackCheck: Date.now(), lockLambdas: LockedLambdaReason.UNLOCKED });
        store.getValuesFromOrderedSet.mockReturnValue(['u1', 'u2']);
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([
            { hash: 'provider_a', slot: 200, height: 4990 },
            { hash: 'provider_b', slot: 201, height: 4991 }
        ] as never);

        mockedGetHandleNameFromAssetName.mockImplementation((assetName: string) => {
            if (assetName === 'asset-a') {
                return { name: 'handle-a', ownerTokenHex: 'asset-a', isCip67: false, assetLabel: null };
            }
            return { name: assetName, ownerTokenHex: assetName, isCip67: false, assetLabel: null };
        });

        const mintToKeep = JSON.stringify({ created_slot: 200, metadata: {}, txHash: 'mint-keep' });
        const mintToRemove = JSON.stringify({ created_slot: 201, metadata: {}, txHash: 'mint-remove' });

        pipelineResponses.push(
            [
                buildUtxo({ id: 'u1', slot: 200, blockHash: 'provider_a', assetName: 'asset-a' }),
                buildUtxo({ id: 'u2', slot: 201, blockHash: 'api_wrong', assetName: 'asset-a' })
            ],
            [{ name: 'handle-a', policy: 'policy-a', hex: 'asset-a', resolved_addresses: { ada: knownAddress } }],
            [new Set([mintToKeep, mintToRemove])],
            [new Set(['handle-a'])],
            [],
            [new Set([mintToKeep])]
        );

        mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
            if (path === 'block_txs') return [{ tx_hash: 'provider_tx_1' }] as never;
            if (path === 'asset_utxos') return [{ tx_hash: 'provider_tx_1' }] as never;
            if (path === 'tx_info' && body?.includes('provider_tx_1')) return [{ source: 'provider-rollbacks' }] as never;
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockImplementation((txs: any[]) => {
            if (txs?.[0]?.source === 'provider-rollbacks') {
                return [
                    buildUtxo({ id: 'u1', slot: 200, blockHash: 'provider_a', assetName: 'asset-a' }),
                    buildUtxo({ id: 'replay_provider_b#0', slot: 201, blockHash: 'provider_b', assetName: 'asset-a' })
                ] as never;
            }
            return [] as never;
        });

        await scannerModule.Internal.checkRollback({ currentSlot: 300, lastMaxRollbackCheck: Date.now() });

        expect(store.removeValueFromIndexedSet).toHaveBeenCalledWith(IndexNames.MINT, 'handle-a', mintToRemove);
        expect(store.removeValueFromIndexedSet).not.toHaveBeenCalledWith(IndexNames.MINT, 'handle-a', mintToKeep);
        expect(handlesRepo.removeUTxOs).toHaveBeenCalledWith(['u2']);
        expect(handlesRepo.addUTxOsWithMintData).toHaveBeenCalledWith([expect.objectContaining({ id: 'replay_provider_b#0' })]);
    });

    it('batches tx_info requests when tx hash payload grows', async () => {
        const { handlesRepo, pipelineResponses, scannerModule, store } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentSlot: 300, lastMaxRollbackCheck: Date.now(), lockLambdas: LockedLambdaReason.UNLOCKED });
        store.getValuesFromOrderedSet.mockReturnValue(['u1']);
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'provider_a', slot: 200 }] as never);

        mockedGetHandleNameFromAssetName.mockImplementation((assetName: string) => {
            if (assetName === 'asset-a') {
                return { name: 'handle-a', ownerTokenHex: 'asset-a', isCip67: false, assetLabel: null };
            }
            return { name: assetName, ownerTokenHex: assetName, isCip67: false, assetLabel: null };
        });

        pipelineResponses.push(
            [buildUtxo({ id: 'u1', slot: 200, blockHash: 'api_a', assetName: 'asset-a' })],
            [{ name: 'handle-a', policy: 'policy-a', hex: 'asset-a', resolved_addresses: { ada: knownAddress } }],
            [new Set([JSON.stringify({ created_slot: 150, metadata: {}, txHash: 'mint-a' })])],
            [new Set(['handle-a'])],
            [],
            [new Set([JSON.stringify({ created_slot: 150, metadata: {}, txHash: 'mint-a' })])]
        );

        mockedHelpers.fetchKoios.mockImplementation(async (path: string) => {
            if (path === 'asset_utxos') {
                return Array.from({ length: 140 }, (_, index) => ({
                    tx_hash: `${'a'.repeat(56)}${index.toString().padStart(8, '0')}`
                })) as never;
            }
            if (path === 'tx_info') return [] as never;
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);

        await scannerModule.Internal.checkRollback({ currentSlot: 300, lastMaxRollbackCheck: Date.now() });

        const txInfoCalls = mockedHelpers.fetchKoios.mock.calls.filter((call) => call[0] === 'tx_info');
        expect(txInfoCalls.length).toBeGreaterThan(1);
    });

    it('includes CIP67 companion assets in asset_utxos lookup payload', async () => {
        const { handlesRepo, pipelineResponses, scannerModule, store } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentSlot: 300, lastMaxRollbackCheck: Date.now(), lockLambdas: LockedLambdaReason.UNLOCKED });
        store.getValuesFromOrderedSet.mockReturnValue(['u1']);
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'provider_a', slot: 200 }] as never);

        const cip67OwnerToken = `${AssetNameLabel.LBL_222}616263`;
        const companion100 = `${AssetNameLabel.LBL_100}616263`;
        const companion001 = `${AssetNameLabel.LBL_001}616263`;

        mockedGetHandleNameFromAssetName.mockImplementation((assetName: string) => {
            if (assetName === cip67OwnerToken) {
                return {
                    name: 'abc',
                    ownerTokenHex: cip67OwnerToken,
                    isCip67: true,
                    assetLabel: AssetNameLabel.LBL_222
                };
            }
            return { name: assetName, ownerTokenHex: assetName, isCip67: false, assetLabel: null };
        });

        pipelineResponses.push(
            [buildUtxo({ id: 'u1', slot: 200, blockHash: 'api_a', assetName: cip67OwnerToken })],
            [{ name: 'abc', policy: 'policy-a', hex: cip67OwnerToken, resolved_addresses: { ada: knownAddress } }],
            [new Set([JSON.stringify({ created_slot: 150, metadata: {}, txHash: 'mint-a' })])],
            [new Set(['abc'])],
            [],
            [new Set([JSON.stringify({ created_slot: 150, metadata: {}, txHash: 'mint-a' })])]
        );

        mockedHelpers.fetchKoios.mockResolvedValue([] as never);
        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);

        await scannerModule.Internal.checkRollback({ currentSlot: 300, lastMaxRollbackCheck: Date.now() });

        const assetUtxoCall = mockedHelpers.fetchKoios.mock.calls.find((call) => call[0] === 'asset_utxos');
        expect(assetUtxoCall).toBeDefined();
        const parsedBody = JSON.parse(assetUtxoCall![2] as string);
        expect(parsedBody._asset_list).toEqual(
            expect.arrayContaining([
                ['policy-a', cip67OwnerToken],
                ['policy-a', companion100],
                ['policy-a', companion001]
            ])
        );
    });

    it('processReindex calls repopulateIndexesFromUTxOs with bound handlers', async () => {
        const { handlesRepo, scannerModule, store } = setup();

        await scannerModule.Internal.processReindex();

        expect(store.repopulateIndexesFromUTxOs).toHaveBeenCalledWith(
            expect.objectContaining({
                [UTxOFunctionName.ADD_UTXO]: expect.any(Function),
                [UTxOFunctionName.UPDATE_HANDLE_INDEXES]: expect.any(Function)
            })
        );
        const callArgs = store.repopulateIndexesFromUTxOs.mock.calls[0][0];
        callArgs[UTxOFunctionName.ADD_UTXO]({});
        callArgs[UTxOFunctionName.UPDATE_HANDLE_INDEXES]({});
        expect(handlesRepo.addUTxO).toHaveBeenCalledWith({});
        expect(handlesRepo.updateHandleIndexes).toHaveBeenCalledWith({});
    });

    it('processReindex unlocks with new index schema version', async () => {
        const { handlesRepo, scannerModule, store } = setup();
        store.getIndexSchemaVersion.mockReturnValue(3);

        await scannerModule.Internal.processReindex();

        expect(handlesRepo.setMetrics).toHaveBeenCalledWith({ indexSchemaVersion: 3 });
        expect(handlesRepo.setMetrics).toHaveBeenLastCalledWith({ lockLambdas: LockedLambdaReason.UNLOCKED });
    });

    it('processReindex unlocks lambdas when repopulation fails', async () => {
        const { handlesRepo, scannerModule, store } = setup();
        store.repopulateIndexesFromUTxOs.mockImplementation(() => {
            throw new Error('Reindex failed');
        });

        await expect(scannerModule.Internal.processReindex()).rejects.toThrow('Reindex failed');

        expect(handlesRepo.setMetrics).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ lockLambdas: LockedLambdaReason.REINDEX, lockLambdasTimestamp: expect.any(Number) })
        );
        expect(handlesRepo.setMetrics).toHaveBeenNthCalledWith(2, { lockLambdas: LockedLambdaReason.UNLOCKED });
    });

    it('splits oversized rollback handle payloads into multiple asset_utxos requests', async () => {
        const { handlesRepo, pipelineResponses, scannerModule, store } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentSlot: 300, lastMaxRollbackCheck: Date.now(), lockLambdas: LockedLambdaReason.UNLOCKED });
        store.getValuesFromOrderedSet.mockReturnValue(['u1']);
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'provider_a', slot: 200 }] as never);

        mockedGetHandleNameFromAssetName.mockImplementation((assetName: string) => {
            if (assetName === 'asset-a') return { name: 'handle-a', ownerTokenHex: 'asset-a', isCip67: false, assetLabel: null };
            return { name: assetName, ownerTokenHex: assetName, isCip67: false, assetLabel: null };
        });

        const oversizedStoredHandles = Array.from({ length: 3 }, (_, index) => ({
            name: `handle-${index}`,
            policy: `policy-${index}${'p'.repeat(2400)}`,
            hex: `hex-${index}${'h'.repeat(2400)}`,
            resolved_addresses: { ada: knownAddress }
        }));

        pipelineResponses.push(
            [buildUtxo({ id: 'u1', slot: 200, blockHash: 'provider_a', assetName: 'asset-a' })],
            oversizedStoredHandles
        );

        mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
            if (path === 'block_txs') return [{ tx_hash: 'provider_tx_1' }] as never;
            if (path === 'asset_utxos') return [{ tx_hash: 'latest_tx_1' }] as never;
            if (path === 'tx_info' && body?.includes('provider_tx_1')) return [{ source: 'provider' }] as never;
            if (path === 'tx_info' && body?.includes('latest_tx_1')) return [{ source: 'latest' }] as never;
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockImplementation((txs: any[]) => {
            if (txs?.[0]?.source === 'provider' || txs?.[0]?.source === 'latest') {
                return [buildUtxo({ id: 'u1', slot: 200, blockHash: 'provider_a', assetName: 'asset-a' })] as never;
            }
            return [] as never;
        });

        await scannerModule.Internal.checkRollback({ currentSlot: 300, lastMaxRollbackCheck: Date.now() });

        const assetUtxoCalls = mockedHelpers.fetchKoios.mock.calls.filter((call) => call[0] === 'asset_utxos');
        expect(assetUtxoCalls.length).toBeGreaterThan(1);
    });

    it('parses retrieved minting data into mintValueIndex during rollback index refresh', async () => {
        const { handlesRepo, pipelineResponses, scannerModule, store } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentSlot: 300, lastMaxRollbackCheck: Date.now(), lockLambdas: LockedLambdaReason.UNLOCKED });
        store.getValuesFromOrderedSet.mockReturnValue(['u1']);
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'provider_a', slot: 200 }] as never);

        mockedGetHandleNameFromAssetName.mockImplementation((assetName: string) => {
            if (assetName === 'asset-a') return { name: 'handle-a', ownerTokenHex: 'asset-a', isCip67: false, assetLabel: null };
            return { name: assetName, ownerTokenHex: assetName, isCip67: false, assetLabel: null };
        });

        const retainedMintData = JSON.stringify({ created_slot: 150, metadata: { test: true }, txHash: 'mint-seed' });
        const parsedMintData = JSON.stringify({ created_slot: 140, metadata: { nft: 'value' }, txHash: 'mint-parsed' });

        pipelineResponses.push(
            [buildUtxo({ id: 'u1', slot: 200, blockHash: 'api_a', assetName: 'asset-a' })],
            [{ name: 'handle-a', policy: 'policy-a', hex: 'asset-a', resolved_addresses: { ada: knownAddress } }],
            [new Set([retainedMintData])],
            [new Set(['handle-a'])],
            [],
            [],
            [new Set([parsedMintData])]
        );

        mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
            if (path === 'block_txs') return [{ tx_hash: 'provider_tx_1' }] as never;
            if (path === 'asset_utxos') return [{ tx_hash: 'latest_tx_1' }] as never;
            if (path === 'tx_info' && body?.includes('provider_tx_1')) return [{ source: 'provider' }] as never;
            if (path === 'tx_info' && body?.includes('latest_tx_1')) return [{ source: 'latest' }] as never;
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockImplementation((txs: any[]) => {
            if (txs?.[0]?.source === 'provider') {
                return [buildUtxo({ id: 'replay_provider#0', slot: 201, blockHash: 'provider_a', assetName: 'asset-a' })] as never;
            }
            if (txs?.[0]?.source === 'latest') {
                return [buildUtxo({ id: 'replay_latest#0', slot: 202, blockHash: 'provider_a', assetName: 'asset-a' })] as never;
            }
            return [] as never;
        });

        await scannerModule.Internal.checkRollback({ currentSlot: 300, lastMaxRollbackCheck: Date.now() });

        expect(handlesRepo.updateHandleIndexes).toHaveBeenCalledTimes(1);
        const [, mintValueIndex] = handlesRepo.updateHandleIndexes.mock.calls[0];
        expect(mintValueIndex.get('handle-a')).toEqual([
            { created_slot: 140, metadata: { nft: 'value' }, txHash: 'mint-parsed' }
        ]);
    });

    it('scan logs when there are no new blocks to process', async () => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([] as never);

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
            await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();
            expect(logSpy.mock.calls.some(([entry]) => `${entry}`.includes('No new blocks to process from start_hash'))).toBe(true);
        } finally {
            logSpy.mockRestore();
        }

        const txInfoCalls = mockedHelpers.fetchKoios.mock.calls.filter((call) => call[0] === 'tx_info');
        expect(txInfoCalls).toHaveLength(0);
    });

    it('scan runs rollback_20 when stale head is near tip', async () => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'stale_hash', currentSlot: 100, lockLambdas: LockedLambdaReason.UNLOCKED });

        mockedHelpers.fetchPaginatedResults
            .mockResolvedValueOnce([] as never)
            .mockResolvedValueOnce([] as never);
        mockedHelpers.blockfrostApiCall.mockImplementation(async (endpoint: string) => {
            if (endpoint === 'blocks/latest') return { ok: true, json: async () => ({ slot: 103, height: 5000 }) } as any;
            return { ok: true, json: async () => ({}) } as any;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);

        await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();

        expect(mockedHelpers.fetchPaginatedResults).toHaveBeenNthCalledWith(1, 'blocks/stale_hash/next');
        expect(mockedHelpers.fetchPaginatedResults).toHaveBeenNthCalledWith(2, 'blocks/4980/next');
        const txInfoCalls = mockedHelpers.fetchKoios.mock.calls.filter((call) => call[0] === 'tx_info');
        expect(txInfoCalls).toHaveLength(0);
    });

    it('scan realigns stale head metrics when rollback state already matches provider', async () => {
        const { handlesRepo, pipelineResponses, scannerModule, store } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'stale_hash', currentSlot: 100, lockLambdas: LockedLambdaReason.UNLOCKED });
        store.getValuesFromOrderedSet.mockReturnValue(['u1']);

        mockedHelpers.fetchPaginatedResults
            .mockResolvedValueOnce([] as never)
            .mockResolvedValueOnce([{ hash: 'provider_block', slot: 100 }] as never);
        mockedHelpers.blockfrostApiCall.mockResolvedValue({ ok: true, json: async () => ({ slot: 103, height: 5000, hash: 'tip_hash' }) } as never);

        pipelineResponses.push(
            [buildUtxo({ id: 'u1', slot: 100, blockHash: 'provider_block', assetName: 'asset-a' })],
            [{ name: 'asset-a', policy: 'policy-a', hex: 'asset-a', resolved_addresses: { ada: knownAddress } }]
        );

        mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
            if (path === 'block_txs') return [{ tx_hash: 'provider_tx_1' }] as never;
            if (path === 'asset_utxos') return [{ tx_hash: 'provider_tx_1' }] as never;
            if (path === 'tx_info' && body?.includes('provider_tx_1')) return [{ source: 'provider' }] as never;
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockImplementation((txs: any[]) => {
            if (txs?.[0]?.source === 'provider') {
                return [buildUtxo({ id: 'u1', slot: 100, blockHash: 'provider_block', assetName: 'asset-a' })] as never;
            }
            return [] as never;
        });

        await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();

        expect(handlesRepo.setMetrics).toHaveBeenCalledWith(
            expect.objectContaining({
                currentBlockHash: 'provider_block',
                currentSlot: 100,
                tipBlockHash: 'tip_hash',
                lastSlot: 103
            })
        );
    });

    it('scan runs rollback_2160 when stale head is far behind tip', async () => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'stale_hash', currentSlot: 100, lockLambdas: LockedLambdaReason.UNLOCKED });

        mockedHelpers.fetchPaginatedResults
            .mockResolvedValueOnce([] as never)
            .mockResolvedValueOnce([] as never);
        mockedHelpers.blockfrostApiCall.mockImplementation(async (endpoint: string) => {
            if (endpoint === 'blocks/latest') return { ok: true, json: async () => ({ slot: 1000, height: 5000 }) } as any;
            return { ok: true, json: async () => ({}) } as any;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);

        await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();

        expect(mockedHelpers.fetchPaginatedResults).toHaveBeenNthCalledWith(1, 'blocks/stale_hash/next');
        expect(mockedHelpers.fetchPaginatedResults).toHaveBeenNthCalledWith(2, 'blocks/2840/next');
        const txInfoCalls = mockedHelpers.fetchKoios.mock.calls.filter((call) => call[0] === 'tx_info');
        expect(txInfoCalls).toHaveLength(0);
    });

    it('scan processes burns, updates, spent inputs, and unlocks', async () => {
        const { handlesRepo, pipelineResponses, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });

        mockedHelpers.fetchPaginatedResults.mockResolvedValue([
            { hash: 'block_newer', slot: 101, confirmations: 5 },
            { hash: 'block_older', slot: 100, confirmations: 1 }
        ] as never);
        mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
            if (path === 'block_txs') {
                const parsedBody = JSON.parse(body ?? '{}');
                return (parsedBody._block_hashes ?? []).flatMap((blockHash: string) => {
                    if (blockHash === 'block_newer') return [{ tx_hash: 'tx_newer' }];
                    if (blockHash === 'block_older') return [{ tx_hash: 'tx_older' }];
                    return [];
                }) as never;
            }
            if (path === 'tx_info') {
                const parsedBody = JSON.parse(body ?? '{}');
                return (parsedBody._tx_hashes ?? []).flatMap((txHash: string) => {
                    if (txHash === 'tx_newer') return [{ tx_hash: 'tx_newer', block_hash: 'block_newer', inputs: [{ tx_hash: 'input_newer', tx_index: 0 }] }];
                    if (txHash === 'tx_older') return [{ tx_hash: 'tx_older', block_hash: 'block_older', inputs: [{ tx_hash: 'input_older', tx_index: 1 }] }];
                    return [];
                }) as never;
            }
            return [] as never;
        });
        mockedGetHandleNameFromAssetName.mockImplementation((assetName: string) => {
            if (assetName === 'burn-hex') return { name: 'burn-handle', ownerTokenHex: 'burn-hex', isCip67: false, assetLabel: null };
            return { name: assetName, ownerTokenHex: assetName, isCip67: false, assetLabel: null };
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockImplementation((txs: any[]) => {
            const blockHash = txs?.[0]?.block_hash;
            if (blockHash === 'block_newer') {
                const utxo = buildUtxo({ id: 'scan_newer#0', slot: 101, blockHash: 'block_newer', assetName: 'asset-a' });
                utxo.burn = [[policy, ['burn-hex']]];
                return [utxo] as never;
            }
            const utxo = buildUtxo({ id: 'scan_older#0', slot: 100, blockHash: 'block_older', assetName: 'asset-b' });
            utxo.burn = [];
            return [utxo] as never;
        });

        pipelineResponses.push([{ name: 'burn-handle' }], [], [], []);

        await scannerModule.Internal.scan();

        expect(handlesRepo.removeHandle).toHaveBeenCalledWith({ name: 'burn-handle' });
        expect(handlesRepo.addUTxOsWithMintDataAndUpdateIndexes).toHaveBeenNthCalledWith(
            1,
            [expect.objectContaining({ id: 'scan_newer#0' })]
        );
        expect(handlesRepo.addUTxOsWithMintDataAndUpdateIndexes).toHaveBeenNthCalledWith(
            2,
            [expect.objectContaining({ id: 'scan_older#0' })]
        );
        const txInfoCalls = mockedHelpers.fetchKoios.mock.calls.filter((call) => call[0] === 'tx_info');
        expect(txInfoCalls).toHaveLength(1);
        expect(txInfoCalls[0][2]).toEqual(expect.stringContaining('tx_newer'));
        expect(txInfoCalls[0][2]).toEqual(expect.stringContaining('tx_older'));
        expect(handlesRepo.removeUTxOs).toHaveBeenNthCalledWith(1, ['input_newer#0']);
        expect(handlesRepo.removeUTxOs).toHaveBeenNthCalledWith(2, ['input_older#1']);
        expect(handlesRepo.setMetrics).toHaveBeenLastCalledWith({ lockLambdas: LockedLambdaReason.UNLOCKED });
    });

    it('scan logs and rethrows provider errors while unlocking lambdas', async () => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });
        mockedHelpers.fetchPaginatedResults.mockRejectedValue(new Error('scan exploded'));

        await expect(scannerModule.Internal.scan()).rejects.toThrow('scan exploded');

        expect(handlesRepo.setMetrics).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ lockLambdas: LockedLambdaReason.SCANNING, lockLambdasTimestamp: expect.any(Number) })
        );
        expect(handlesRepo.setMetrics).toHaveBeenLastCalledWith({ lockLambdas: LockedLambdaReason.UNLOCKED });
    });

    it('retries tx_info on UND_ERR_SOCKET terminated errors and logs troubleshooting curl context', async () => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'block_newer', slot: 101, confirmations: 5 }] as never);

        let txInfoAttempts = 0;
        mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
            if (path === 'block_txs') return [{ tx_hash: 'tx_a' }, { tx_hash: 'tx_b' }] as never;
            if (path === 'tx_info') {
                txInfoAttempts++;
                if (txInfoAttempts === 1) {
                    const error: any = new Error('terminated');
                    error.cause = { code: 'UND_ERR_SOCKET', message: 'other side closed' };
                    throw error;
                }
                const parsedBody = JSON.parse(body ?? '{}');
                return (parsedBody._tx_hashes ?? []).map((txHash: string) => ({ tx_hash: txHash, block_hash: 'block_newer', inputs: [] })) as never;
            }
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        try {
            await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();
            const txInfoCalls = mockedHelpers.fetchKoios.mock.calls.filter((call) => call[0] === 'tx_info');
            expect(txInfoCalls).toHaveLength(2);
            const logEntries = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls].map(([entry]) => `${entry}`);
            expect(
                logEntries.some((entry) => entry.includes('scannerLambda.koiosTxInfo.requestFailed'))
            ).toBe(true);
            expect(logEntries.some((entry) => entry.includes('UND_ERR_SOCKET'))).toBe(true);
            expect(logEntries.some((entry) => entry.includes('curl -v --http1.1'))).toBe(true);
        } finally {
            logSpy.mockRestore();
            warnSpy.mockRestore();
            errorSpy.mockRestore();
        }
    });

    it('retries tx_info on Koios PGRST003 pool timeout response objects', async () => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'block_newer', slot: 101, confirmations: 5 }] as never);

        let txInfoAttempts = 0;
        mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
            if (path === 'block_txs') return [{ tx_hash: 'tx_a' }] as never;
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
                const parsedBody = JSON.parse(body ?? '{}');
                return (parsedBody._tx_hashes ?? []).map((txHash: string) => ({ tx_hash: txHash, block_hash: 'block_newer', inputs: [] })) as never;
            }
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);

        await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();

        const txInfoCalls = mockedHelpers.fetchKoios.mock.calls.filter((call) => call[0] === 'tx_info');
        expect(txInfoCalls).toHaveLength(2);
    });

    it('retries tx_info on 429 response errors from Koios', async () => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'block_newer', slot: 101, confirmations: 5 }] as never);

        let txInfoAttempts = 0;
        mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
            if (path === 'block_txs') return [{ tx_hash: 'tx_a' }] as never;
            if (path === 'tx_info') {
                txInfoAttempts++;
                if (txInfoAttempts === 1) {
                    const error: any = new Error('Koios tx_info request failed: 429 Too Many Requests');
                    error.status = 429;
                    error.statusText = 'Too Many Requests';
                    error.responseText = '<html><body><h1>429 Too Many Requests</h1></body></html>';
                    throw error;
                }
                const parsedBody = JSON.parse(body ?? '{}');
                return (parsedBody._tx_hashes ?? []).map((txHash: string) => ({ tx_hash: txHash, block_hash: 'block_newer', inputs: [] })) as never;
            }
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);

        await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();

        const txInfoCalls = mockedHelpers.fetchKoios.mock.calls.filter((call) => call[0] === 'tx_info');
        expect(txInfoCalls).toHaveLength(2);
    });

    it('retries block_txs on 429 response errors from Koios with backoff delay', async () => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'block_newer', slot: 101, confirmations: 5 }] as never);

        let blockTxAttempts = 0;
        mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
            if (path === 'block_txs') {
                blockTxAttempts++;
                if (blockTxAttempts === 1) {
                    const error: any = new Error('Koios block_txs request failed: 429 Too Many Requests');
                    error.status = 429;
                    error.statusText = 'Too Many Requests';
                    error.responseText = '<html><body><h1>429 Too Many Requests</h1></body></html>';
                    throw error;
                }
                return [{ tx_hash: 'tx_a' }] as never;
            }
            if (path === 'tx_info') {
                const parsedBody = JSON.parse(body ?? '{}');
                return (parsedBody._tx_hashes ?? []).map((txHash: string) => ({ tx_hash: txHash, block_hash: 'block_newer', inputs: [] })) as never;
            }
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);

        const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
        let hasBlockTxBackoffDelay = false;
        try {
            await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();
            hasBlockTxBackoffDelay = setTimeoutSpy.mock.calls.some((call) => Number(call[1]) >= 1_000);
        } finally {
            setTimeoutSpy.mockRestore();
        }

        const blockTxCalls = mockedHelpers.fetchKoios.mock.calls.filter((call) => call[0] === 'block_txs');
        expect(blockTxCalls).toHaveLength(2);
        expect(hasBlockTxBackoffDelay).toBe(true);
    });

    it('paces tx_info requests to stay under 12 requests per second', async () => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'block_newer', slot: 101, confirmations: 5 }] as never);

        mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
            if (path === 'block_txs') {
                return Array.from({ length: 140 }, (_, index) => ({
                    tx_hash: `${'a'.repeat(56)}${index.toString().padStart(8, '0')}`
                })) as never;
            }
            if (path === 'tx_info') {
                const parsedBody = JSON.parse(body ?? '{}');
                return (parsedBody._tx_hashes ?? []).map((txHash: string) => ({ tx_hash: txHash, block_hash: 'block_newer', inputs: [] })) as never;
            }
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);

        const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
        await scannerModule.Internal.scan();
        const pacingCalls = setTimeoutSpy.mock.calls
            .map((call) => Number(call[1]))
            .filter((delay) => Number.isFinite(delay) && delay > 0 && delay < 1_000);
        setTimeoutSpy.mockRestore();
        expect(pacingCalls.some((delay) => delay >= 80)).toBe(true);
    });

    it('splits tx_info batches after retries are exhausted and continues scanning', async () => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'block_newer', slot: 101, confirmations: 5 }] as never);

        mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
            if (path === 'block_txs') return [{ tx_hash: 'tx_a' }, { tx_hash: 'tx_b' }, { tx_hash: 'tx_c' }, { tx_hash: 'tx_d' }] as never;
            if (path === 'tx_info') {
                const parsedBody = JSON.parse(body ?? '{}');
                const txHashes = parsedBody._tx_hashes ?? [];
                if (txHashes.length === 4) {
                    throw new Error('Payload too large, body length was 5305. Please ensure your request body size is below 5120 bytes');
                }
                return txHashes.map((txHash: string) => ({ tx_hash: txHash, block_hash: 'block_newer', inputs: [] })) as never;
            }
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();
            const txInfoCalls = mockedHelpers.fetchKoios.mock.calls.filter((call) => call[0] === 'tx_info');
            expect(txInfoCalls.length).toBeGreaterThanOrEqual(5);
            expect(
                [...logSpy.mock.calls, ...warnSpy.mock.calls].some(([entry]) => `${entry}`.includes('"event": "scannerLambda.koiosTxInfo.splitBatch"'))
            ).toBe(true);
        } finally {
            logSpy.mockRestore();
            warnSpy.mockRestore();
        }
    });

    it('scan ignores missing burn handles (idempotent burn replay)', async () => {
        const { handlesRepo, pipelineResponses, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });

        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'block_newer', slot: 101, confirmations: 5 }] as never);
        mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
            if (path === 'block_txs' && body?.includes('block_newer')) return [{ tx_hash: 'tx_newer' }] as never;
            if (path === 'tx_info' && body?.includes('tx_newer')) return [{ marker: 'block_newer', inputs: [] }] as never;
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockImplementation((txs: any[]) => {
            if (txs?.[0]?.marker === 'block_newer') {
                const utxo = buildUtxo({ id: 'scan_newer#0', slot: 101, blockHash: 'block_newer', assetName: 'asset-a' });
                utxo.burn = [[policy, ['burn-hex']]];
                return [utxo] as never;
            }
            return [] as never;
        });

        pipelineResponses.push([undefined], []);

        await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();
        expect(handlesRepo.removeHandle).not.toHaveBeenCalled();
    });

    it.each([
        { reason: LockedLambdaReason.SCANNING, ageMs: 6 * 60 * 1000 },
        { reason: LockedLambdaReason.ROLLBACK_20, ageMs: 6 * 60 * 1000 },
        { reason: LockedLambdaReason.REINDEX, ageMs: 11 * 60 * 1000 },
        { reason: 'SNAPSHOT' as LockedLambdaReason, ageMs: 11 * 60 * 1000 }
    ])('recovers stale lambda lock: $reason', async ({ reason, ageMs }) => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({
            lockLambdas: reason,
            lockLambdasTimestamp: Date.now() - ageMs,
            currentSlot: 100,
            currentBlockHash: 'start_hash',
            indexSchemaVersion: 1
        });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([] as never);

        await scannerModule.lambdaHandler({} as any, {} as any);
        expect(handlesRepo.setMetrics).toHaveBeenCalledWith({ lockLambdas: LockedLambdaReason.UNLOCKED });
    });

    it('refreshes UTxOs before scan when stored UTxO schema version is behind', async () => {
        const { handlesRepo, scannerModule, store } = setup();
        store.getUTxOSchemaVersion.mockReturnValue(2);
        handlesRepo.getMetrics.mockReturnValue({
            lockLambdas: LockedLambdaReason.UNLOCKED,
            indexSchemaVersion: 1,
            utxoSchemaVersion: 1,
            currentBlockHash: 'start_hash',
            currentSlot: 100,
            lastMaxRollbackCheck: Date.now()
        });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([] as never);

        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            await scannerModule.lambdaHandler({} as any, {} as any);
            expect(warnSpy.mock.calls.some(([entry]) => `${entry}`.includes('scannerLambda.repopulateUTxOs'))).toBe(true);
        } finally {
            warnSpy.mockRestore();
        }

        expect(handlesRepo.getStartingPoint).toHaveBeenCalledWith(
            expect.objectContaining({
                [UTxOFunctionName.ADD_UTXO]: expect.any(Function),
                [UTxOFunctionName.UPDATE_HANDLE_INDEXES]: expect.any(Function)
            })
        );
    });

    it('lambdaHandler runs reindex path and exits before scan when schema is behind', async () => {
        const { handlesRepo, scannerModule, store } = setup();
        store.getIndexSchemaVersion.mockReturnValue(3);
        handlesRepo.getMetrics.mockReturnValue({
            lockLambdas: LockedLambdaReason.UNLOCKED,
            indexSchemaVersion: 1,
            currentBlockHash: 'head',
            currentSlot: 10
        });

        await expect(scannerModule.lambdaHandler({} as any, {} as any)).resolves.toBeUndefined();

        expect(store.repopulateIndexesFromUTxOs).toHaveBeenCalledTimes(1);
        expect(mockedHelpers.fetchPaginatedResults).not.toHaveBeenCalled();
    });

    it('lambdaHandler skips execution when scanner lease is already held', async () => {
        const { handlesRepo, scannerModule, store } = setup();
        store.redisClientCall.mockImplementationOnce(() => null);

        await expect(scannerModule.lambdaHandler({} as any, {} as any)).resolves.toBeUndefined();

        expect(store.initialize).toHaveBeenCalledTimes(1);
        expect(handlesRepo.initialize).not.toHaveBeenCalled();
        expect(mockedHelpers.fetchPaginatedResults).not.toHaveBeenCalled();
    });

    it('lambdaHandler runs recovery reindex when a recovery flag is present', async () => {
        const { handlesRepo, scannerModule, store } = setup();
        store.redisClientCall('set', 'scanner:recovery', 'rollback');
        handlesRepo.getMetrics.mockReturnValue({
            lockLambdas: LockedLambdaReason.UNLOCKED,
            indexSchemaVersion: 1,
            currentBlockHash: 'start_hash',
            currentSlot: 100
        });

        await expect(scannerModule.lambdaHandler({} as any, {} as any)).resolves.toBeUndefined();

        expect(store.repopulateIndexesFromUTxOs).toHaveBeenCalledTimes(1);
        expect(handlesRepo.getStartingPoint).not.toHaveBeenCalled();
        expect(store.redisClientCall('get', 'scanner:recovery')).toBeUndefined();
        expect(mockedHelpers.fetchPaginatedResults).not.toHaveBeenCalled();
    });

    it('lambdaHandler runs scan+rollback and returns success payload when unlocked', async () => {
        const { handlesRepo, scannerModule, store } = setup();
        store.getIndexSchemaVersion.mockReturnValue(1);
        handlesRepo.getMetrics.mockReturnValue({
            lockLambdas: LockedLambdaReason.UNLOCKED,
            indexSchemaVersion: 1,
            currentBlockHash: 'start_hash',
            currentSlot: 100,
            lastMaxRollbackCheck: Date.now()
        });
        mockedHelpers.fetchPaginatedResults
            .mockResolvedValueOnce([] as never)
            .mockResolvedValueOnce([] as never);

        const result = await scannerModule.lambdaHandler({} as any, {} as any);

        expect(result).toEqual({ isBase64Encoded: false, statusCode: 200, body: '' });
        expect(mockedHelpers.fetchPaginatedResults).toHaveBeenNthCalledWith(1, 'blocks/start_hash/next');
        expect(mockedHelpers.fetchPaginatedResults).toHaveBeenNthCalledWith(2, 'blocks/4980/next');
    });

    it('reuses scanner initialization across warm invocations', async () => {
        const { handlesRepo, scannerModule, store } = setup();
        store.getIndexSchemaVersion.mockReturnValue(1);
        handlesRepo.getMetrics.mockReturnValue({
            lockLambdas: LockedLambdaReason.UNLOCKED,
            indexSchemaVersion: 1,
            currentBlockHash: 'start_hash',
            currentSlot: 100,
            lastMaxRollbackCheck: Date.now()
        });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([] as never);

        await scannerModule.lambdaHandler({} as any, {} as any);
        await scannerModule.lambdaHandler({} as any, {} as any);

        expect(handlesRepo.initialize).toHaveBeenCalledTimes(1);
    });

    it('uses the default rollback offset when processRollback omits rollbackOffset', async () => {
        const { scannerModule } = setup();
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([] as never);

        await scannerModule.Internal.processRollback({ currentSlot: 100 });

        expect(mockedHelpers.fetchPaginatedResults).toHaveBeenCalledWith('blocks/4980/next');
    });

    it('returns early when rollback provider blocks are all ahead of current slot', async () => {
        const { scannerModule, store } = setup();
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'future_block', slot: 200 }] as never);

        await scannerModule.Internal.processRollback({ currentSlot: 100, rollbackOffset: 20 });

        expect(store.getValuesFromOrderedSet).not.toHaveBeenCalled();
    });

    it('handles null asset_utxos response during rollback handle lookup', async () => {
        const { handlesRepo, pipelineResponses, scannerModule, store } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentSlot: 300, lockLambdas: LockedLambdaReason.UNLOCKED });
        store.getValuesFromOrderedSet.mockReturnValue(['u1']);
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'provider_a', slot: 200 }] as never);

        const providerUtxo = buildUtxo({ id: 'u1', slot: 200, blockHash: 'provider_a', assetName: 'asset-a' });
        pipelineResponses.push(
            [buildUtxo({ id: 'u1', slot: 200, blockHash: 'provider_a', assetName: 'asset-a' })],
            [{ name: 'asset-a', policy: 'policy-a', hex: 'asset-a', resolved_addresses: { ada: knownAddress } }]
        );

        mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
            if (path === 'block_txs') return [{ tx_hash: 'provider_tx_1' }] as never;
            if (path === 'asset_utxos') return null as never;
            if (path === 'tx_info' && body?.includes('provider_tx_1')) return [{ source: 'provider' }] as never;
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockImplementation((txs: any[]) => {
            if (txs?.[0]?.source === 'provider') return [providerUtxo] as never;
            return [] as never;
        });

        await scannerModule.Internal.checkRollback();

        expect(mockedHelpers.fetchKoios).toHaveBeenCalledWith('asset_utxos', 'POST', expect.any(String));
    });

    it('skips rollback index refresh entries with unrelated handles and defaults missing mint to empty', async () => {
        const { handlesRepo, pipelineResponses, scannerModule, store } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentSlot: 300, lockLambdas: LockedLambdaReason.UNLOCKED });
        store.getValuesFromOrderedSet.mockReturnValue(['api#0']);
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'provider_a', slot: 200 }] as never);

        mockedGetHandleNameFromAssetName.mockImplementation((assetName: string) => {
            if (assetName === 'asset-a') return { name: 'handle-a', ownerTokenHex: 'asset-a', isCip67: false, assetLabel: null };
            if (assetName === 'asset-z') return { name: 'handle-z', ownerTokenHex: 'asset-z', isCip67: false, assetLabel: null };
            return { name: assetName, ownerTokenHex: assetName, isCip67: false, assetLabel: null };
        });

        const apiUtxo = buildUtxo({ id: 'api#0', slot: 200, blockHash: 'api_block', assetName: 'asset-a' });
        apiUtxo.handles = undefined;
        const retainedMintData = JSON.stringify({ created_slot: 150, metadata: {}, txHash: 'mint-keep' });

        pipelineResponses.push(
            [apiUtxo],
            [{ name: 'handle-a', policy: 'policy-a', hex: 'asset-a', resolved_addresses: { ada: knownAddress } }],
            [new Set([retainedMintData])],
            [new Set(['handle-a'])],
            [],
            [new Set([retainedMintData])]
        );

        mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
            if (path === 'block_txs') return [{ tx_hash: 'provider_tx_1' }] as never;
            if (path === 'asset_utxos') return [{ tx_hash: 'latest_tx_1' }] as never;
            if (path === 'tx_info' && body?.includes('provider_tx_1')) return [{ source: 'provider' }] as never;
            if (path === 'tx_info' && body?.includes('latest_tx_1')) return [{ source: 'latest' }] as never;
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockImplementation((txs: any[]) => {
            if (txs?.[0]?.source === 'provider') {
                return [buildUtxo({ id: 'provider#0', slot: 201, blockHash: 'provider_a', assetName: 'asset-a' })] as never;
            }
            if (txs?.[0]?.source === 'latest') {
                const unrelated = buildUtxo({ id: 'latest_unrelated#0', slot: 202, blockHash: 'provider_a', assetName: 'asset-z' });
                const matching = buildUtxo({ id: 'provider#0', slot: 202, blockHash: 'provider_a', assetName: 'asset-a' });
                matching.mint = undefined;
                return [unrelated, matching] as never;
            }
            return [] as never;
        });

        await scannerModule.Internal.checkRollback();

        expect(handlesRepo.updateHandleIndexes).toHaveBeenCalledTimes(1);
        const [filteredUtxo] = handlesRepo.updateHandleIndexes.mock.calls[0];
        expect(filteredUtxo.mint).toEqual([]);
        expect(filteredUtxo.handles).toEqual([[policy, ['asset-a']]]);
    });

    it('uses currentSlot default in checkRollback when metrics omit it', async () => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ lockLambdas: LockedLambdaReason.UNLOCKED });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([] as never);

        await scannerModule.Internal.checkRollback();

        expect(mockedHelpers.fetchPaginatedResults).toHaveBeenCalledWith('blocks/4980/next');
    });

    it('scan tolerates null block_txs responses', async () => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'block_newer', slot: 101, confirmations: 5 }] as never);
        mockedHelpers.fetchKoios.mockImplementation(async (path: string) => {
            if (path === 'block_txs') return null as never;
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);

        await scannerModule.Internal.scan();

        expect(handlesRepo.addUTxOsWithMintDataAndUpdateIndexes).toHaveBeenCalledWith([]);
        expect(handlesRepo.removeUTxOs).not.toHaveBeenCalled();
    });

    it('scan tolerates null tx_info responses and missing handles on UTxOs', async () => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'block_newer', slot: 101, confirmations: 5 }] as never);
        mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
            if (path === 'block_txs' && body?.includes('block_newer')) return [{ tx_hash: 'tx_newer' }] as never;
            if (path === 'tx_info' && body?.includes('tx_newer')) return null as never;
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([
            { ...buildUtxo({ id: 'scan_newer#0', slot: 101, blockHash: 'block_newer', assetName: 'asset-a' }), handles: undefined }
        ] as never);

        await scannerModule.Internal.scan();

        expect(handlesRepo.addUTxOsWithMintDataAndUpdateIndexes).toHaveBeenCalledTimes(1);
        expect(handlesRepo.removeUTxOs).not.toHaveBeenCalled();
    });

    it('scan defaults handleNames to empty when UTxO collection flatMap returns undefined', async () => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'block_newer', slot: 101, confirmations: 5 }] as never);
        mockedHelpers.fetchKoios.mockResolvedValue([] as never);
        const builtUtxos: any[] = [];
        (builtUtxos as any).flatMap = () => undefined;
        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue(builtUtxos as never);

        await scannerModule.Internal.scan();

        expect(handlesRepo.addUTxOsWithMintDataAndUpdateIndexes).toHaveBeenCalledWith(expect.anything());
    });

    it('returns early for locked lambdas without stale timeout configuration', async () => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({
            lockLambdas: 'UNKNOWN_LOCK' as any,
            lockLambdasTimestamp: Date.now() - 20 * 60 * 1000
        });

        await scannerModule.lambdaHandler({} as any, {} as any);

        expect(handlesRepo.setMetrics).not.toHaveBeenCalledWith({ lockLambdas: LockedLambdaReason.UNLOCKED });
        expect(mockedHelpers.fetchPaginatedResults).not.toHaveBeenCalled();
    });

    it('does not renew lease when heartbeat sees a different owner', async () => {
        const { handlesRepo, scannerModule, store } = setup();
        handlesRepo.getMetrics.mockReturnValue({
            lockLambdas: LockedLambdaReason.UNLOCKED,
            indexSchemaVersion: 1,
            currentBlockHash: 'start_hash',
            currentSlot: 100,
            lastMaxRollbackCheck: Date.now()
        });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([] as never);

        const originalRedisClientCall = store.redisClientCall.getMockImplementation();
        const setIntervalSpy = jest.spyOn(global, 'setInterval').mockImplementation(((callback: TimerHandler) => {
            (callback as CallableFunction)();
            return { unref: jest.fn() } as any;
        }) as any);
        store.redisClientCall.mockImplementation((cmd: string, ...args: any[]) => {
            if (cmd === 'get' && args[0] === 'scanner:lease') return 'another-owner';
            return originalRedisClientCall?.(cmd, ...args);
        });

        try {
            await scannerModule.lambdaHandler({} as any, {} as any);
        } finally {
            setIntervalSpy.mockRestore();
        }

        expect(store.redisClientCall).not.toHaveBeenCalledWith('pexpire', 'scanner:lease', expect.any(Number));
    });

    it('handles lease release errors without failing the invocation', async () => {
        const { handlesRepo, scannerModule, store } = setup();
        handlesRepo.getMetrics.mockReturnValue({
            lockLambdas: LockedLambdaReason.UNLOCKED,
            indexSchemaVersion: 1,
            currentBlockHash: 'start_hash',
            currentSlot: 100,
            lastMaxRollbackCheck: Date.now()
        });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([] as never);

        const originalRedisClientCall = store.redisClientCall.getMockImplementation();
        const setIntervalSpy = jest.spyOn(global, 'setInterval').mockImplementation((() => ({ unref: jest.fn() }) as any) as any);
        store.redisClientCall.mockImplementation((cmd: string, ...args: any[]) => {
            if (cmd === 'get' && args[0] === 'scanner:lease') {
                throw new Error('release failed');
            }
            return originalRedisClientCall?.(cmd, ...args);
        });

        try {
            await expect(scannerModule.lambdaHandler({} as any, {} as any)).resolves.toEqual({
                isBase64Encoded: false,
                statusCode: 200,
                body: ''
            });
        } finally {
            setIntervalSpy.mockRestore();
        }
    });

    it('treats missing indexSchemaVersion metric as zero for schema upgrade checks', async () => {
        const { handlesRepo, scannerModule, store } = setup();
        store.getIndexSchemaVersion.mockReturnValue(1);
        handlesRepo.getMetrics.mockReturnValue({
            lockLambdas: LockedLambdaReason.UNLOCKED,
            currentBlockHash: 'head',
            currentSlot: 10
        });

        await scannerModule.lambdaHandler({} as any, {} as any);

        expect(store.repopulateIndexesFromUTxOs).toHaveBeenCalledTimes(1);
    });
});
