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
    const store = {
        getValuesFromIndexedSet: jest.fn(),
        getValuesFromOrderedSet: jest.fn(),
        pipeline: jest.fn((commands: CallableFunction) => {
            commands();
            return pipelineResponses.shift() ?? [];
        }),
        removeValueFromIndexedSet: jest.fn(),
        getIndexSchemaVersion: jest.fn().mockReturnValue(1),
        repopulateIndexesFromUTxOs: jest.fn()
    };

    const handlesRepo = {
        initialize: jest.fn().mockResolvedValue(undefined),
        addUTxO: jest.fn(),
        addUTxOsWithMintData: jest.fn(),
        addUTxOsWithMintDataAndUpdateIndexes: jest.fn(),
        getHandle: jest.fn(),
        getHandleMintingData: jest.fn(),
        getMetrics: jest.fn().mockReturnValue({ currentSlot: 130, lastMaxRollbackCheck: Date.now(), lockLambdas: LockedLambdaReason.UNLOCKED }),
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
    mockedHelpers.fetchTxList.mockResolvedValue([] as never);
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

        expect(mockedHelpers.fetchTxList).not.toHaveBeenCalled();
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

        await scannerModule.Internal.checkRollback({ currentSlot: 300, lastMaxRollbackCheck: Date.now() });

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

        expect(handlesRepo.setMetrics).toHaveBeenLastCalledWith({ indexSchemaVersion: 3, lockLambdas: LockedLambdaReason.UNLOCKED });
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

    it('scan processes burns, updates, spent inputs, and unlocks', async () => {
        const { handlesRepo, pipelineResponses, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });

        mockedHelpers.fetchPaginatedResults.mockResolvedValue([
            { hash: 'block_newer', slot: 101, confirmations: 5 },
            { hash: 'block_older', slot: 100, confirmations: 1 }
        ] as never);
        mockedHelpers.fetchTxList.mockImplementation(async (hash: string) => {
            if (hash === 'block_newer') return [{ marker: hash, inputs: [{ tx_hash: 'input_newer', tx_index: 0 }] }] as never;
            return [{ marker: hash, inputs: [{ tx_hash: 'input_older', tx_index: 1 }] }] as never;
        });
        mockedGetHandleNameFromAssetName.mockImplementation((assetName: string) => {
            if (assetName === 'burn-hex') return { name: 'burn-handle', ownerTokenHex: 'burn-hex', isCip67: false, assetLabel: null };
            return { name: assetName, ownerTokenHex: assetName, isCip67: false, assetLabel: null };
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockImplementation((txs: any[]) => {
            const marker = txs?.[0]?.marker;
            if (marker === 'block_newer') {
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

    it.each([
        { reason: LockedLambdaReason.SCANNING, ageMs: 6 * 60 * 1000 },
        { reason: LockedLambdaReason.ROLLBACK_20, ageMs: 6 * 60 * 1000 },
        { reason: LockedLambdaReason.REINDEX, ageMs: 11 * 60 * 1000 }
    ])('logs notify for stale lambda lock: $reason', async ({ reason, ageMs }) => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({
            lockLambdas: reason,
            lockLambdasTimestamp: Date.now() - ageMs,
            currentSlot: 100
        });

        await expect(scannerModule.lambdaHandler({} as any, {} as any)).resolves.toBeUndefined();
        expect(mockedHelpers.blockfrostApiCall).not.toHaveBeenCalled();
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
});
