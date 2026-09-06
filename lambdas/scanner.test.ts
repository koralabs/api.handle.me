import { AssetNameLabel, IndexNames, LockedLambdaReason, UTxOFunctionName } from '@koralabs/kora-labs-common';
import { HandlesRepository } from '../repositories/handlesRepository';
import { getHandleNameFromAssetName } from '../services/ogmios/utils';
import { getHandlesStore, RedisHandlesStore } from '../stores/redis';
import { getApiMptRebuildPendingKey, getApiScannerLeaseKey, getApiScannerRecoveryKey } from '../stores/redis/keys';
import * as helpers from '../utils/helpers';
import * as demeterService from '../services/demeter/utxorpc.service';
import type { KoiosTxInfo } from '../interfaces/provider.interface';

jest.mock('../utils/helpers');
jest.mock('../stores/redis');
jest.mock('../repositories/handlesRepository');
jest.mock('../services/ogmios/utils');
jest.mock('../services/demeter/utxorpc.service');
jest.mock('../services/maestro/policy-txs.service');

import * as maestroService from '../services/maestro/policy-txs.service';
const mockedMaestro = maestroService as jest.Mocked<typeof maestroService>;
const mockedDemeter = demeterService as jest.Mocked<typeof demeterService>;

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
        scannerModule = require('./scanner.app');
    });
    return scannerModule;
};

const setup = ({ whitelistedApiKeys = 'allowed-key' }: { whitelistedApiKeys?: string } = {}) => {
    process.env.WHITELISTED_API_KEYS = whitelistedApiKeys;
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
            if (cmd === 'customCommand') {
                // Fake-evaluate the EVAL script forms the scanner uses for
                // atomic lease renew/release. Only handles the scripts actually
                // shipped in scanner.app.ts; unknown scripts return undefined.
                const [cmdArgs] = args as [string[]];
                if (cmdArgs?.[0] === 'EVAL' && cmdArgs[2] === '1') {
                    const script = `${cmdArgs[1] ?? ''}`;
                    const key = cmdArgs[3];
                    const owner = cmdArgs[4];
                    const ttl = cmdArgs[5];
                    if (script.includes('PEXPIRE')) {
                        return kvStore.get(key) === owner && ttl ? 1 : 0;
                    }
                    if (script.includes('DEL')) {
                        if (kvStore.get(key) === owner) {
                            kvStore.delete(key);
                            return 1;
                        }
                        return 0;
                    }
                }
                return undefined;
            }
            return undefined;
        }),
        removeValueFromIndexedSet: jest.fn(),
        getIndexSchemaVersion: jest.fn().mockReturnValue(1),
        getUTxOSchemaVersion: jest.fn().mockReturnValue(1),
        repopulateIndexesFromUTxOs: jest.fn(),
        getKeysFromIndex: jest.fn().mockReturnValue([]),
        getMptRootHash: jest.fn().mockReturnValue(undefined),
        setMptRootHash: jest.fn(),
        recordScannedBlock: jest.fn(),
        addScannedBlocks: jest.fn(),
        getScannedBlockHashesInRange: jest.fn().mockReturnValue(new Set<string>()),
        listAllScannedBlocks: jest.fn().mockReturnValue([]),
        trimScannedBlocksToRecent: jest.fn()
    };

    const handlesRepo = {
        initialize: jest.fn().mockResolvedValue(undefined),
        addMintDataFromUTxOs: jest.fn().mockImplementation((utxos: any[]) => utxos),
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
        updateHolder: jest.fn(),
        isCaughtUp: jest.fn().mockReturnValue(false)
    };

    MockedStoreClass.mockImplementation(() => store);
    (getHandlesStore as jest.Mock).mockImplementation(() => store);
    MockedRepoClass.mockImplementation(() => handlesRepo);
    mockedHelpers.blockfrostApiCall.mockResolvedValue({ ok: true, json: async () => ({ height: 5000 }) } as any);
    mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'provider_block', slot: 100 }] as never);
    mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);
    mockedHelpers.fetchKoios.mockResolvedValue([] as never);
    mockedHelpers.fetchBlockfrostTxHashes.mockResolvedValue([] as never);
    mockedHelpers.fetchBlockfrostTxInfo.mockResolvedValue({ tx_hash: '', block_hash: '', block_height: 0, absolute_slot: 0, inputs: [], outputs: [], assets_minted: [], metadata: {}, reference_inputs: [] } as never);
    mockedHelpers.fetchBlockfrostDatumCbor.mockResolvedValue(null as never);
    mockedDemeter.isDemeterScannerEnabled.mockReturnValue(false);
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
    it('does not construct scanner dependencies while importing scanner app', () => {
        jest.isolateModules(() => {
            require('./scanner.app');
        });

        expect(getHandlesStore).not.toHaveBeenCalled();
        expect(MockedRepoClass).not.toHaveBeenCalled();
    });

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
        handlesRepo.getMetrics.mockReturnValue({ lockLambdas: LockedLambdaReason.ROLLBACK, currentSlot: 100 });

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
            expect.objectContaining({ lockLambdas: LockedLambdaReason.ROLLBACK, lockLambdasTimestamp: expect.any(Number) })
        );
        expect(handlesRepo.setMetrics).toHaveBeenLastCalledWith({ lockLambdas: LockedLambdaReason.UNLOCKED });
    });

    it('ignores future provider blocks when comparing hashes', async () => {
        const { handlesRepo, pipelineResponses, scannerModule, store } = setup();
        // Anchor must be canonical for the missed-handles probe to run; an off-canonical anchor
        // triggers the anchor-orphaned short-circuit added to processRollback and skips block_txs.
        handlesRepo.getMetrics.mockReturnValue({ currentSlot: 130, currentBlockHash: 'provider_block', lockLambdas: LockedLambdaReason.UNLOCKED });
        store.getValuesFromOrderedSet.mockReturnValue(['utxo#0']);
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([
            { hash: 'provider_block', slot: 100 },
            { hash: 'future_block', slot: 200 }
        ] as never);
        pipelineResponses.push([buildUtxo({ id: 'utxo#0', slot: 100, blockHash: 'provider_block', assetName: 'asset-a' })]);

        await scannerModule.Internal.checkRollback({ currentSlot: 130, lastMaxRollbackCheck: Date.now() });

        expect(mockedHelpers.fetchKoios).toHaveBeenCalledWith('block_txs', 'POST', expect.any(String));
    });

    it('releases lock and keeps a lower-bound tip when rollback latest lookup fails', async () => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({
            currentSlot: 130,
            lastSlot: 125,
            lockLambdas: LockedLambdaReason.UNLOCKED
        });
        mockedHelpers.blockfrostApiCall.mockResolvedValue({ ok: false } as any);

        await expect(scannerModule.Internal.checkRollback({ currentSlot: 130, lastMaxRollbackCheck: Date.now() })).resolves.toBeUndefined();

        expect(handlesRepo.setMetrics).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({ lockLambdas: LockedLambdaReason.ROLLBACK, lockLambdasTimestamp: expect.any(Number) })
        );
        expect(handlesRepo.setMetrics).toHaveBeenCalledWith({
            lastSlot: 130,
            tipBlockHash: ''
        });
        expect(handlesRepo.setMetrics).toHaveBeenLastCalledWith({ lockLambdas: LockedLambdaReason.UNLOCKED });
    });

    it('uses Koios tip height when Blockfrost latest is unavailable during rollback', async () => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({
            currentSlot: 130,
            lastSlot: 125,
            lockLambdas: LockedLambdaReason.UNLOCKED
        });
        mockedHelpers.blockfrostApiCall.mockResolvedValue({ ok: false } as any);
        mockedHelpers.fetchKoios.mockImplementation(async (path: string) => {
            if (path === 'tip') return [{ hash: 'koios_tip_hash', abs_slot: 130, block_height: 5000 }] as never;
            return [] as never;
        });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([] as never);

        await expect(scannerModule.Internal.checkRollback({ currentSlot: 130, lastMaxRollbackCheck: Date.now() })).resolves.toBeUndefined();

        expect(mockedHelpers.fetchPaginatedResults).toHaveBeenCalledWith('blocks/4980/next');
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

        mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
            if (path === 'block_txs') return [{ tx_hash: 'provider_tx_1' }] as never;
            if (path === 'asset_utxos') return [{ tx_hash: 'tx_info_1' }] as never;
            if (path === 'tx_info' && body?.includes('provider_tx_1')) return [{ source: 'provider-tx-info' }] as never;
            if (path === 'tx_info' && body?.includes('tx_info_1')) return [{ source: 'from-tx-info' }] as never;
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockImplementation((txs: any[]) => {
            if (txs?.[0]?.source === 'provider-tx-info') {
                return [buildUtxo({ id: 'replay_block#0', slot: 201, blockHash: 'provider_a', assetName: 'asset-a' })] as never;
            }
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
            // Stored UTxO points at 'api_a', but canonical is 'provider_a' → u1 is orphaned.
            // Orphaning is the trigger for drift-candidate enumeration; without it, the new
            // delta-based processRollback would short-circuit before reaching Phase 4 batching.
            [buildUtxo({ id: 'u1', slot: 200, blockHash: 'api_a', assetName: 'asset-a' })],
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

        expect(handlesRepo.addMintDataFromUTxOs).toHaveBeenCalledWith([expect.objectContaining({ id: 'replay_latest#0' })]);
        expect(handlesRepo.updateHandleIndexes).toHaveBeenCalledTimes(1);
        const [, mintValueIndex] = handlesRepo.updateHandleIndexes.mock.calls[0];
        expect(mintValueIndex.get('handle-a')).toEqual([
            { created_slot: 140, metadata: { nft: 'value' }, txHash: 'mint-parsed' }
        ]);
    });

    it('scan logs when there are no new blocks to process', async () => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({
            currentBlockHash: 'start_hash',
            currentSlot: 130,
            lockLambdas: LockedLambdaReason.UNLOCKED
        });
        mockedHelpers.blockfrostApiCall.mockResolvedValue({
            ok: true,
            json: async () => ({ hash: 'tip_hash', slot: 130, height: 5000 })
        } as never);
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([] as never);

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        try {
            await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();
            expect(logSpy.mock.calls.some(([entry]) => `${entry}`.includes('No new blocks to process from start_hash'))).toBe(true);
        } finally {
            logSpy.mockRestore();
        }

        expect(handlesRepo.setMetrics).toHaveBeenCalledWith({
            lastSlot: 130,
            tipBlockHash: 'tip_hash'
        });
        const txInfoCalls = mockedHelpers.fetchKoios.mock.calls.filter((call) => call[0] === 'tx_info');
        expect(txInfoCalls).toHaveLength(0);
    });

    it('scan keeps advancing a lower-bound tip when blocks/latest is unavailable and there are no forward blocks', async () => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({
            currentBlockHash: 'start_hash',
            currentSlot: 130,
            lastSlot: 125,
            lockLambdas: LockedLambdaReason.UNLOCKED
        });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([] as never);
        mockedHelpers.blockfrostApiCall.mockResolvedValue({ ok: false } as never);

        await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();

        expect(handlesRepo.setMetrics).toHaveBeenCalledWith({
            lastSlot: 130,
            tipBlockHash: ''
        });
    });

    it('scan falls back to Koios tip when Blockfrost latest is unavailable and there are no forward blocks', async () => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({
            currentBlockHash: 'start_hash',
            currentSlot: 130,
            lastSlot: 125,
            lockLambdas: LockedLambdaReason.UNLOCKED
        });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([] as never);
        mockedHelpers.blockfrostApiCall.mockResolvedValue({ ok: false } as never);
        mockedHelpers.fetchKoios.mockImplementation(async (path: string) => {
            if (path === 'tip') return [{ hash: 'koios_tip_hash', abs_slot: 130, block_height: 5000 }] as never;
            return [] as never;
        });

        await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();

        expect(handlesRepo.setMetrics).toHaveBeenCalledWith({
            lastSlot: 130,
            tipBlockHash: 'koios_tip_hash'
        });
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

    it('skips missed-handles probe and snaps head when currentBlockHash is off-canonical', async () => {
        // Regression: the rollback recovery used to fan out to a block_txs probe over every
        // unseen canonical block in the window when stored UTxOs all had canonical blockHashes
        // — even when our anchor itself was off-canonical (Phase 2 orphan check on stored UTxOs
        // can't see this case because a handle-free orphaned anchor block leaves no stored
        // refs). On a deep gap that probe burned the Lambda deadline and west mainnet looped on
        // recovery for hours without persisting progress. Forward-scan from the snapped
        // canonical predecessor is sufficient — skip the probe.
        const { handlesRepo, pipelineResponses, scannerModule, store } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'orphaned_anchor', currentSlot: 100, lockLambdas: LockedLambdaReason.UNLOCKED });
        store.getValuesFromOrderedSet.mockReturnValue(['u1']);
        // 1279 in-window canonical blocks already scanned, 1 unseen → would trigger the
        // expensive missed-handles probe in the pre-fix path.
        store.getScannedBlockHashesInRange.mockReturnValue(new Set(['canonical_at_100']));

        mockedHelpers.fetchPaginatedResults
            .mockResolvedValueOnce([] as never)
            .mockResolvedValueOnce([
                { hash: 'unseen_canonical', slot: 90 },
                { hash: 'canonical_at_100', slot: 100 }
            ] as never);
        mockedHelpers.blockfrostApiCall.mockResolvedValue({ ok: true, json: async () => ({ slot: 103, height: 5000, hash: 'tip_hash' }) } as never);

        // Stored UTxOs all carry canonical blockHashes → orphanedUtxos is empty, so the only
        // path that would have triggered the probe pre-fix was the unseen-canonical-blocks
        // branch. Post-fix that branch is gated on !anchorOrphaned and stays cold.
        pipelineResponses.push([buildUtxo({ id: 'u1', slot: 100, blockHash: 'canonical_at_100', assetName: 'asset-a' })]);

        await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();

        // Externally visible outcome 1: head snapped to the latest canonical predecessor in-window.
        expect(handlesRepo.setMetrics).toHaveBeenCalledWith(
            expect.objectContaining({
                currentBlockHash: 'canonical_at_100',
                currentSlot: 100
            })
        );
        // Externally visible outcome 2: missed-handles probe (block_txs) was NOT issued.
        // Negative control: removing the !anchorOrphaned guard in processRollback would route
        // through getBatchedTxHashesWithFallback, calling fetchKoios('block_txs', ...).
        const blockTxsCalls = mockedHelpers.fetchKoios.mock.calls.filter((call) => call[0] === 'block_txs');
        expect(blockTxsCalls).toHaveLength(0);
    });

    it('flags MPT rebuild pending when buildAndStoreMptRootHash throws in scan finally', async () => {
        // Regression: previously the catch block only logged and the stale stored hash stayed
        // pinned until a future slot-advancing scan happened to succeed. /mpt-root would report
        // calc≠datum drift in the meantime with no operator-actionable signal beyond the log.
        const { handlesRepo, scannerModule, store } = setup();
        // Slot advances within this scan: getMetrics returns 100 at scan_start (line 1153) and
        // 105 in the finally block — that asymmetry is what triggers buildAndStoreMptRootHash
        // pre-fix as well.
        handlesRepo.getMetrics
            .mockReturnValueOnce({ currentSlot: 100, currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED })
            .mockReturnValue({ currentSlot: 105, currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.SCANNING });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([] as never);
        mockedHelpers.blockfrostApiCall.mockResolvedValue({ ok: true, json: async () => ({ slot: 105, height: 5000, hash: 'tip_hash' }) } as never);
        store.setMptRootHash.mockImplementation(() => {
            throw new Error('valkey blip');
        });

        await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();

        // Externally visible outcome: pending flag set in Valkey for next invocation.
        // Negative control: without `setMptRebuildPending()` in the catch block, the kvStore
        // would not contain MPT_REBUILD_PENDING_KEY and a stale hash could pin indefinitely.
        const pendingKey = getApiMptRebuildPendingKey();
        const pendingFlag = store.redisClientCall('get', pendingKey);
        expect(pendingFlag).toBe('1');
    });

    it('retries MPT rebuild on next invocation when pending flag is set, even with no slot advance', async () => {
        // Regression: the rebuild used to gate strictly on (endingCurrentSlot !== startingCurrentSlot).
        // A failure that flagged for retry would only get retried on the next slot-advancing scan.
        // On a quiet network this could leave the stale hash pinned for minutes-to-hours. The
        // retry path must fire on any invocation while the flag is set.
        const { handlesRepo, scannerModule, store } = setup();
        // Pre-set the pending flag — simulating a previous invocation's failure.
        const pendingKey = getApiMptRebuildPendingKey();
        store.redisClientCall('set', pendingKey, '1');
        // Slot does NOT advance: same currentSlot at scan_start and at finally.
        handlesRepo.getMetrics.mockReturnValue({ currentSlot: 100, currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([] as never);
        mockedHelpers.blockfrostApiCall.mockResolvedValue({ ok: true, json: async () => ({ slot: 100, height: 5000, hash: 'tip_hash' }) } as never);

        await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();

        // Externally visible outcome 1: the rebuild ran (store.setMptRootHash was called).
        // Negative control: without the `|| rebuildPending` clause in the finally guard, no slot
        // change means no rebuild attempt and setMptRootHash stays uncalled.
        expect(store.setMptRootHash).toHaveBeenCalledTimes(1);
        // Externally visible outcome 2: flag cleared after successful rebuild.
        expect(store.redisClientCall('get', pendingKey)).toBeUndefined();
    });

    it('scan runs rollback when stale head is far behind tip', async () => {
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

        expect(mockedHelpers.fetchPaginatedResults).toHaveBeenNthCalledWith(1, 'blocks/stale_hash/next', 721);
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
        const txInfoCall = mockedHelpers.fetchKoios.mock.calls.find((call) => call[0] === 'tx_info');
        expect(txInfoCall).toBeDefined();
        expect(JSON.parse(txInfoCall![2] as string)).toEqual(expect.objectContaining({ _scripts: true }));
    });

    it('scan writes tip metrics from latest blockfrost tip (not chunk tail)', async () => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'block_chunk_tail', slot: 101, confirmations: 5 }] as never);
        mockedHelpers.blockfrostApiCall.mockImplementation(async (endpoint: string) => {
            if (endpoint === 'blocks/latest') return { ok: true, json: async () => ({ hash: 'real_tip_hash', slot: 999 }) } as never;
            return { ok: true, json: async () => ({}) } as never;
        });
        mockedHelpers.fetchKoios.mockImplementation(async (path: string) => {
            if (path === 'block_txs') return [{ tx_hash: 'tx_1' }] as never;
            if (path === 'tx_info') return [{ tx_hash: 'tx_1', block_hash: 'block_chunk_tail', inputs: [] }] as never;
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);

        await scannerModule.Internal.scan();

        expect(handlesRepo.setMetrics).toHaveBeenCalledWith(
            expect.objectContaining({
                currentBlockHash: 'block_chunk_tail',
                currentSlot: 101,
                tipBlockHash: 'real_tip_hash',
                lastSlot: 999
            })
        );
    });

    it('scan advances the observed tip lower bound without trusting chunk tail as authoritative tip hash when blocks/latest fails', async () => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({
            currentBlockHash: 'start_hash',
            lastSlot: 100,
            lockLambdas: LockedLambdaReason.UNLOCKED
        });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'block_chunk_tail', slot: 101, confirmations: 5 }] as never);
        mockedHelpers.blockfrostApiCall.mockResolvedValue({ ok: false } as never);
        mockedHelpers.fetchKoios.mockImplementation(async (path: string) => {
            if (path === 'block_txs') return [{ tx_hash: 'tx_1' }] as never;
            if (path === 'tx_info') return [{ tx_hash: 'tx_1', block_hash: 'block_chunk_tail', inputs: [] }] as never;
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);

        await scannerModule.Internal.scan();

        expect(handlesRepo.setMetrics).toHaveBeenCalledWith(
            expect.objectContaining({
                currentBlockHash: 'block_chunk_tail',
                currentSlot: 101,
                tipBlockHash: '',
                lastSlot: 101
            })
        );
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

    // Invariant: after every scan invocation, the persisted mpt_root_hash must
    // reflect the handle set currently in IndexNames.HANDLE. currentSlot and
    // the handle index are mutated per-block inside the scan loop, so an
    // invocation that exits via a retriable provider failure (or hits the
    // scanner deadline) must still rebuild the root before unlocking —
    // otherwise /mpt-root reports a hash from an earlier handle-set state.
    // Invariant: lease renewal and release must be compare-and-set atomic.
    // A non-atomic GET + PEXPIRE would let a stale owner extend a lease that
    // has expired and been re-acquired by another invocation (double-writer).
    // Failure mode: with non-atomic ops, heartbeat by a stale owner could
    // keep a lease alive for the new owner, letting both run concurrently.
    it('renewScannerLease refuses to extend a lease held by another owner', () => {
        const { scannerModule, store } = setup();
        scannerModule.Internal.acquireScannerLease('owner-a');
        expect(scannerModule.Internal.renewScannerLease('owner-b')).toBe(false);
        // Ensure no PEXPIRE / DEL side-effect was applied on behalf of owner-b
        const customCalls = (store.redisClientCall as jest.Mock).mock.calls.filter(([cmd]) => cmd === 'customCommand');
        expect(customCalls.length).toBeGreaterThan(0);
    });

    it('renewScannerLease succeeds only for the current owner', () => {
        const { scannerModule } = setup();
        expect(scannerModule.Internal.acquireScannerLease('owner-a')).toBe(true);
        expect(scannerModule.Internal.renewScannerLease('owner-a')).toBe(true);
    });

    it('releaseScannerLease does not delete a lease owned by someone else', () => {
        const { scannerModule } = setup();
        expect(scannerModule.Internal.acquireScannerLease('owner-a')).toBe(true);
        scannerModule.Internal.releaseScannerLease('owner-b');
        // owner-a should still be able to renew — their lease wasn't touched
        expect(scannerModule.Internal.renewScannerLease('owner-a')).toBe(true);
    });

    it('persists mpt_root_hash on retriable provider failure when currentSlot advanced', async () => {
        const { handlesRepo, scannerModule, store } = setup();
        // Simulate a scan that committed at least one block before hitting the
        // retriable error: getMetrics returns slot=100 on entry (starting) and
        // slot=105 in finally (ending). The invariant requires a rebuild.
        handlesRepo.getMetrics
            .mockReturnValueOnce({ currentBlockHash: 'start_hash', currentSlot: 100, lockLambdas: LockedLambdaReason.UNLOCKED })
            .mockReturnValue({ currentBlockHash: 'later_hash', currentSlot: 105, lockLambdas: LockedLambdaReason.SCANNING });
        store.getKeysFromIndex.mockReturnValue(['handle-a', 'handle-b']);
        const retriable: any = new Error('terminated');
        retriable.code = 'UND_ERR_SOCKET';
        mockedHelpers.fetchPaginatedResults.mockRejectedValue(retriable);

        await expect(scannerModule.Internal.scan()).resolves.toBe(false);

        expect(store.setMptRootHash).toHaveBeenCalledTimes(1);
        const persistedHash = store.setMptRootHash.mock.calls[0][0];
        expect(typeof persistedHash).toBe('string');
        expect(persistedHash).toMatch(/^[0-9a-f]{64}$/);
        expect(store.getKeysFromIndex).toHaveBeenCalledWith(IndexNames.HANDLE);
        expect(handlesRepo.setMetrics).toHaveBeenLastCalledWith({ lockLambdas: LockedLambdaReason.UNLOCKED });
    });

    it('persists mpt_root_hash on fatal rethrown error when currentSlot advanced', async () => {
        const { handlesRepo, scannerModule, store } = setup();
        handlesRepo.getMetrics
            .mockReturnValueOnce({ currentBlockHash: 'start_hash', currentSlot: 100, lockLambdas: LockedLambdaReason.UNLOCKED })
            .mockReturnValue({ currentBlockHash: 'later_hash', currentSlot: 110, lockLambdas: LockedLambdaReason.SCANNING });
        store.getKeysFromIndex.mockReturnValue(['only-handle']);
        mockedHelpers.fetchPaginatedResults.mockRejectedValue(new Error('non-retriable scan explosion'));

        await expect(scannerModule.Internal.scan()).rejects.toThrow('non-retriable scan explosion');

        expect(store.setMptRootHash).toHaveBeenCalledTimes(1);
        expect(store.setMptRootHash.mock.calls[0][0]).toMatch(/^[0-9a-f]{64}$/);
        expect(handlesRepo.setMetrics).toHaveBeenLastCalledWith({ lockLambdas: LockedLambdaReason.UNLOCKED });
    });

    it('skips mpt_root_hash rebuild when currentSlot did not advance', async () => {
        const { handlesRepo, scannerModule, store } = setup();
        // Scanner ran but processed no blocks (e.g. provider throw before any
        // block committed). currentSlot is unchanged between entry and finally.
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', currentSlot: 100, lockLambdas: LockedLambdaReason.UNLOCKED });
        store.getKeysFromIndex.mockReturnValue(['handle-a']);
        const retriable: any = new Error('terminated');
        retriable.code = 'UND_ERR_SOCKET';
        mockedHelpers.fetchPaginatedResults.mockRejectedValue(retriable);

        await expect(scannerModule.Internal.scan()).resolves.toBe(false);

        expect(store.setMptRootHash).not.toHaveBeenCalled();
        expect(handlesRepo.setMetrics).toHaveBeenLastCalledWith({ lockLambdas: LockedLambdaReason.UNLOCKED });
    });

    it('persists distinct mpt_root_hash values for distinct handle sets', async () => {
        const { handlesRepo, scannerModule, store } = setup();
        const advancingSlotMock = () => {
            handlesRepo.getMetrics
                .mockReturnValueOnce({ currentBlockHash: 'start_hash', currentSlot: 100, lockLambdas: LockedLambdaReason.UNLOCKED })
                .mockReturnValue({ currentBlockHash: 'later_hash', currentSlot: 101, lockLambdas: LockedLambdaReason.SCANNING });
        };
        mockedHelpers.fetchPaginatedResults.mockRejectedValue(new Error('boom'));

        advancingSlotMock();
        store.getKeysFromIndex.mockReturnValue(['alpha']);
        await expect(scannerModule.Internal.scan()).rejects.toThrow('boom');
        const firstHash = store.setMptRootHash.mock.calls[0][0];

        store.setMptRootHash.mockClear();
        handlesRepo.getMetrics.mockReset();
        advancingSlotMock();
        store.getKeysFromIndex.mockReturnValue(['alpha', 'beta']);
        await expect(scannerModule.Internal.scan()).rejects.toThrow('boom');
        const secondHash = store.setMptRootHash.mock.calls[0][0];

        expect(firstHash).toMatch(/^[0-9a-f]{64}$/);
        expect(secondHash).toMatch(/^[0-9a-f]{64}$/);
        expect(firstHash).not.toEqual(secondHash);
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
            hasBlockTxBackoffDelay = setTimeoutSpy.mock.calls.some((call) => Number(call[1]) >= 500);
        } finally {
            setTimeoutSpy.mockRestore();
        }

        const blockTxCalls = mockedHelpers.fetchKoios.mock.calls.filter((call) => call[0] === 'block_txs');
        expect(blockTxCalls).toHaveLength(2);
        expect(hasBlockTxBackoffDelay).toBe(true);
    });

    it('splits block_txs batches after retries are exhausted and continues scanning', async () => {
        const { handlesRepo, scannerModule } = setup();
        const blocks = Array.from({ length: 20 }, (_, index) => ({
            hash: `${'e'.repeat(56)}${index.toString().padStart(8, '0')}`,
            slot: 101 + index,
            confirmations: 5
        }));
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue(blocks as never);

        mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
            if (path === 'block_txs') {
                const parsedBody = JSON.parse(body ?? '{}');
                const blockHashes: string[] = parsedBody._block_hashes ?? [];
                if (blockHashes.length > 1) {
                    const error: any = new Error('Koios block_txs request failed: 429 Too Many Requests');
                    error.status = 429;
                    throw error;
                }
                return [{ tx_hash: `tx_${blockHashes[0]?.slice(-8) ?? '0'}` }] as never;
            }
            if (path === 'tx_info') {
                const parsedBody = JSON.parse(body ?? '{}');
                return (parsedBody._tx_hashes ?? []).map((txHash: string) => ({ tx_hash: txHash, block_hash: 'block_newer', inputs: [] })) as never;
            }
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((callback: TimerHandler) => {
            (callback as CallableFunction)();
            return 0 as any;
        }) as any);
        try {
            await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();
            const blockTxCalls = mockedHelpers.fetchKoios.mock.calls.filter((call) => call[0] === 'block_txs');
            expect(blockTxCalls.length).toBeGreaterThan(4);
            expect(logSpy.mock.calls.some(([entry]) => `${entry}`.includes('scannerLambda.koiosBlockTxs.splitBatch'))).toBe(true);
        } finally {
            setTimeoutSpy.mockRestore();
            logSpy.mockRestore();
        }
    });

    it('returns success and falls back to Blockfrost when scan block_txs remains throttled with 429', async () => {
        const { scannerModule, store } = setup();
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'block_newer', slot: 101, confirmations: 5 }] as never);
        store.getValuesFromOrderedSet.mockReturnValue([]);

        mockedHelpers.fetchKoios.mockImplementation(async (path: string) => {
            if (path === 'block_txs') {
                const error: any = new Error('Koios block_txs request failed: 429 Too Many Requests');
                error.status = 429;
                error.statusText = 'Too Many Requests';
                throw error;
            }
            return [] as never;
        });

        const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((callback: TimerHandler) => {
            (callback as CallableFunction)();
            return 0 as any;
        }) as any);
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        let logEntries: string[] = [];

        try {
            await expect(scannerModule.lambdaHandler({} as any, {} as any)).resolves.toEqual({
                isBase64Encoded: false,
                statusCode: 200,
                body: ''
            });
            logEntries = [...logSpy.mock.calls, ...warnSpy.mock.calls].map(([entry]) => `${entry}`);
        } finally {
            setTimeoutSpy.mockRestore();
            logSpy.mockRestore();
            warnSpy.mockRestore();
            errorSpy.mockRestore();
        }

        expect(mockedHelpers.fetchBlockfrostTxHashes).toHaveBeenCalledWith(['block_newer']);
        expect(logEntries.some((entry) => entry.includes('fallbackToBlockfrost'))).toBe(true);
    });

    it('returns success when scan block_txs repeatedly times out by falling back to Blockfrost', async () => {
        const { scannerModule, store } = setup();
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'block_newer', slot: 101, confirmations: 5 }] as never);
        store.getValuesFromOrderedSet.mockReturnValue([]);

        mockedHelpers.fetchKoios.mockImplementation(async (path: string) => {
            if (path === 'block_txs') {
                throw new Error('The operation was aborted due to timeout');
            }
            return [] as never;
        });

        const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((callback: TimerHandler) => {
            (callback as CallableFunction)();
            return 0 as any;
        }) as any);
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);

        try {
            await expect(scannerModule.lambdaHandler({} as any, {} as any)).resolves.toEqual({
                isBase64Encoded: false,
                statusCode: 200,
                body: ''
            });
        } finally {
            setTimeoutSpy.mockRestore();
            logSpy.mockRestore();
            warnSpy.mockRestore();
            errorSpy.mockRestore();
        }

        expect(mockedHelpers.fetchBlockfrostTxHashes).toHaveBeenCalledWith(['block_newer']);
    });

    it('checkRollback logs and suppresses retriable upstream errors', async () => {
        // Validates: a retriable upstream error (503) thrown during processRollback's
        // canonical-blocks fetch is caught by checkRollback, logged as
        // `scannerLambda.rollbackRetriable`, and the lock is released — the next
        // invocation will retry naturally instead of crashing the lambda.
        // Failure mode caught: a missing catch path would propagate the error,
        // leaving `lockLambdas: ROLLBACK` set and stalling the scanner indefinitely.
        const { handlesRepo, scannerModule, store } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentSlot: 130, lockLambdas: LockedLambdaReason.UNLOCKED });
        store.getValuesFromOrderedSet.mockReturnValue(['utxo#0']);

        // Let getLatestChainTip succeed so we reach the canonical-blocks fetch where
        // we inject the error.
        mockedHelpers.blockfrostApiCall.mockImplementation(async (endpoint: string) => {
            if (endpoint === 'blocks/latest') return { ok: true, json: async () => ({ slot: 130, height: 5000, hash: 'tip_hash' }) } as any;
            return { ok: true, json: async () => ({}) } as any;
        });
        mockedHelpers.fetchPaginatedResults.mockImplementation(async () => {
            const error: any = new Error('blocks/N/next request failed: 503 Service Unavailable');
            error.status = 503;
            error.statusText = 'Service Unavailable';
            throw error;
        });

        const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((callback: TimerHandler) => {
            (callback as CallableFunction)();
            return 0 as any;
        }) as any);
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        let logEntries: string[] = [];
        try {
            await expect(scannerModule.Internal.checkRollback()).resolves.toBeUndefined();
            logEntries = logSpy.mock.calls.map(([entry]) => `${entry}`);
        } finally {
            setTimeoutSpy.mockRestore();
            logSpy.mockRestore();
        }

        expect(handlesRepo.setMetrics).toHaveBeenLastCalledWith({ lockLambdas: LockedLambdaReason.UNLOCKED });
        expect(logEntries.some((entry) => entry.includes('scannerLambda.rollbackRetriable'))).toBe(true);
    });

    it('paces tx_info requests to stay under 6 requests per second and uses smaller soft body batching', async () => {
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
        expect(pacingCalls.some((delay) => delay >= 160)).toBe(true);
        const txInfoCalls = mockedHelpers.fetchKoios.mock.calls.filter((call) => call[0] === 'tx_info');
        expect(txInfoCalls.length).toBeGreaterThanOrEqual(4);
        expect(txInfoCalls.every(([, , body]) => {
            const parsedBody = JSON.parse(`${body ?? '{}'}`);
            return (parsedBody._tx_hashes ?? []).length <= 35
                && parsedBody._scripts === true
                && parsedBody._bytecode === true;
        })).toBe(true);
    });

    it('batches block_txs with the smaller soft body limit', async () => {
        const { handlesRepo, scannerModule } = setup();
        const blocks = Array.from({ length: 55 }, (_, index) => ({
            hash: `${'b'.repeat(56)}${index.toString().padStart(8, '0')}`,
            slot: 101 + index,
            confirmations: 5
        }));
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue(blocks as never);

        mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
            if (path === 'block_txs') {
                const parsedBody = JSON.parse(body ?? '{}');
                return (parsedBody._block_hashes ?? []).map((blockHash: string) => ({ tx_hash: `tx_${blockHash.slice(-8)}` })) as never;
            }
            if (path === 'tx_info') {
                const parsedBody = JSON.parse(body ?? '{}');
                return (parsedBody._tx_hashes ?? []).map((txHash: string) => ({ tx_hash: txHash, block_hash: 'none', inputs: [] })) as never;
            }
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);

        await scannerModule.Internal.scan();

        const blockTxCalls = mockedHelpers.fetchKoios.mock.calls.filter((call) => call[0] === 'block_txs');
        expect(blockTxCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('processes scanner backlog in bounded block chunks per invocation', async () => {
        const { handlesRepo, scannerModule } = setup();
        const blocks = Array.from({ length: 900 }, (_, index) => ({
            hash: `${'f'.repeat(56)}${index.toString().padStart(8, '0')}`,
            slot: 10_000 + index,
            confirmations: 1_000 - index
        }));
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue(blocks as never);

        const seenBlockHashes: string[] = [];
        mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
            if (path === 'block_txs') {
                const parsedBody = JSON.parse(body ?? '{}');
                seenBlockHashes.push(...(parsedBody._block_hashes ?? []));
                return [] as never;
            }
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);

        await scannerModule.Internal.scan();

        expect(seenBlockHashes.length).toBeGreaterThan(0);
        expect(new Set(seenBlockHashes).size).toBeLessThan(blocks.length);
        expect(seenBlockHashes).toContain(blocks[0].hash);
        expect(seenBlockHashes).not.toContain(blocks[blocks.length - 1].hash);
    });

    it('pauses scan when the hard deadline is reached and resumes next invocation', async () => {
        const { handlesRepo, scannerModule } = setup();
        const blocks = Array.from({ length: 90 }, (_, index) => ({
            hash: `${'d'.repeat(56)}${index.toString().padStart(8, '0')}`,
            slot: 20_000 + index,
            confirmations: 100 - index
        }));
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue(blocks as never);

        // Simulate deadline exceeded after first chunk processes
        let deadlineExceeded = false;
        const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => 1_000_000 + (deadlineExceeded ? 720_001 : 0));
        const seenBlockHashes: string[] = [];
        mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
            if (path === 'block_txs') {
                const parsedBody = JSON.parse(body ?? '{}');
                seenBlockHashes.push(...(parsedBody._block_hashes ?? []));
                deadlineExceeded = true;
                return [] as never;
            }
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            await scannerModule.Internal.scan();
        } finally {
            nowSpy.mockRestore();
            logSpy.mockRestore();
            warnSpy.mockRestore();
        }

        expect(seenBlockHashes.length).toBeGreaterThan(0);
        expect(new Set(seenBlockHashes).size).toBeLessThan(blocks.length);
    });

    it('falls back to Blockfrost immediately after a non-retriable block_txs failure', async () => {
        const { handlesRepo, scannerModule } = setup();
        const blocks = Array.from({ length: 80 }, (_, index) => ({
            hash: `${'c'.repeat(56)}${index.toString().padStart(8, '0')}`,
            slot: 101 + index,
            confirmations: 5
        }));
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue(blocks as never);

        let blockTxAttempts = 0;
        mockedHelpers.fetchKoios.mockImplementation(async (path: string) => {
            if (path === 'block_txs') {
                blockTxAttempts++;
                const error: any = new Error('Koios block_txs request failed: 400 Bad Request');
                error.status = 400;
                throw error;
            }
            return [] as never;
        });

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();
        } finally {
            logSpy.mockRestore();
            warnSpy.mockRestore();
        }

        // 80 blocks / 30 per chunk = 3 chunks, each making 1 Koios attempt before fallback
        expect(blockTxAttempts).toBe(3);
        expect(mockedHelpers.fetchBlockfrostTxHashes).toHaveBeenCalled();
    });

    it('falls back to Blockfrost immediately after a non-retriable tx_info failure', async () => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'block_newer', slot: 101, confirmations: 5 }] as never);

        mockedHelpers.fetchKoios.mockImplementation(async (path: string) => {
            if (path === 'block_txs') {
                return Array.from({ length: 100 }, (_, index) => ({ tx_hash: `${'d'.repeat(56)}${index.toString().padStart(8, '0')}` })) as never;
            }
            if (path === 'tx_info') {
                const error: any = new Error('Koios tx_info request failed: 400 Bad Request');
                error.status = 400;
                throw error;
            }
            return [] as never;
        });

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();
        } finally {
            logSpy.mockRestore();
            warnSpy.mockRestore();
        }

        const txInfoCalls = mockedHelpers.fetchKoios.mock.calls.filter((call) => call[0] === 'tx_info');
        expect(txInfoCalls).toHaveLength(1);
        expect(mockedHelpers.fetchBlockfrostTxInfo).toHaveBeenCalled();
    });

    it('retries asset_utxos on 429 response errors from Koios during rollback reconciliation', async () => {
        const { handlesRepo, pipelineResponses, scannerModule, store } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentSlot: 300, lockLambdas: LockedLambdaReason.UNLOCKED });
        store.getValuesFromOrderedSet.mockReturnValue(['u1']);
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'provider_a', slot: 200 }] as never);

        const providerUtxo = buildUtxo({ id: 'u1', slot: 200, blockHash: 'provider_a', assetName: 'asset-a' });
        pipelineResponses.push(
            // Orphan u1 (stored at 'api_a' but canonical is 'provider_a') so the asset_utxos
            // path is reached — otherwise the new delta-based rollback check short-circuits.
            [buildUtxo({ id: 'u1', slot: 200, blockHash: 'api_a', assetName: 'asset-a' })],
            [{ name: 'asset-a', policy: 'policy-a', hex: 'asset-a', resolved_addresses: { ada: knownAddress } }]
        );

        let assetUtxoAttempts = 0;
        mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
            if (path === 'block_txs') return [{ tx_hash: 'provider_tx_1' }] as never;
            if (path === 'asset_utxos') {
                assetUtxoAttempts++;
                if (assetUtxoAttempts === 1) {
                    const error: any = new Error('Koios asset_utxos request failed: 429 Too Many Requests');
                    error.status = 429;
                    error.statusText = 'Too Many Requests';
                    throw error;
                }
                return [{ tx_hash: 'latest_tx_1' }] as never;
            }
            if (path === 'tx_info' && body?.includes('provider_tx_1')) return [{ source: 'provider' }] as never;
            if (path === 'tx_info' && body?.includes('latest_tx_1')) return [{ source: 'latest' }] as never;
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockImplementation((txs: any[]) => {
            if (txs?.[0]?.source === 'provider') return [providerUtxo] as never;
            if (txs?.[0]?.source === 'latest') return [providerUtxo] as never;
            return [] as never;
        });

        const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
        let hasAssetUtxoBackoffDelay = false;
        try {
            await scannerModule.Internal.checkRollback();
            hasAssetUtxoBackoffDelay = setTimeoutSpy.mock.calls.some((call) => Number(call[1]) >= 500);
        } finally {
            setTimeoutSpy.mockRestore();
        }

        expect(assetUtxoAttempts).toBe(2);
        expect(hasAssetUtxoBackoffDelay).toBe(true);
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
    }, 30_000);

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
        { reason: LockedLambdaReason.SCANNING, ageMs: 11 * 60 * 1000 },
        { reason: LockedLambdaReason.ROLLBACK, ageMs: 11 * 60 * 1000 },
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

    it('does not recover snapshot lock before 10 minutes', async () => {
        // Feature: snapshot locks should only be treated as stale after the same 10-minute window named in the alert message.
        // Failure mode: a shorter timeout would unlock an in-progress snapshot and emit a misleading stale-lock notification.
        // Negative control: increasing the age below to 11 minutes would make the stale-lock recovery assertion valid instead.
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({
            lockLambdas: 'SNAPSHOT' as LockedLambdaReason,
            lockLambdasTimestamp: Date.now() - 9 * 60 * 1000,
            currentSlot: 100,
            currentBlockHash: 'start_hash',
            indexSchemaVersion: 1
        });

        await expect(scannerModule.lambdaHandler({} as any, {} as any)).resolves.toBeUndefined();

        expect(handlesRepo.setMetrics).not.toHaveBeenCalledWith({ lockLambdas: LockedLambdaReason.UNLOCKED });
        expect(mockedHelpers.fetchPaginatedResults).not.toHaveBeenCalled();
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

    it('lambdaHandler runs index reindex when reindex recovery flag is present', async () => {
        const { handlesRepo, scannerModule, store } = setup();
        store.redisClientCall('set', getApiScannerRecoveryKey(), 'reindex');
        handlesRepo.getMetrics.mockReturnValue({
            lockLambdas: LockedLambdaReason.UNLOCKED,
            indexSchemaVersion: 1,
            currentBlockHash: 'start_hash',
            currentSlot: 100
        });

        await expect(scannerModule.lambdaHandler({} as any, {} as any)).resolves.toBeUndefined();

        expect(store.repopulateIndexesFromUTxOs).toHaveBeenCalledTimes(1);
        expect(handlesRepo.getStartingPoint).not.toHaveBeenCalled();
        expect(store.redisClientCall('get', getApiScannerRecoveryKey())).toBeUndefined();
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
        expect(mockedHelpers.fetchPaginatedResults).toHaveBeenNthCalledWith(1, 'blocks/start_hash/next', 721);
        expect(mockedHelpers.fetchPaginatedResults).toHaveBeenNthCalledWith(2, 'blocks/4980/next');
    });

    it('lambdaHandler rejects function-url reindex shortcut requests without whitelisted api-key', async () => {
        const { scannerModule, store } = setup({ whitelistedApiKeys: 'allowed-a,allowed-b' });
        const functionUrlEvent = {
            requestContext: { http: { method: 'POST', path: '/' } },
            queryStringParameters: { reindex: 'true' },
            headers: { 'api-key': 'not-allowed' }
        } as any;

        const result = await scannerModule.lambdaHandler(functionUrlEvent, {} as any);

        expect(result).toEqual(
            expect.objectContaining({
                statusCode: 401,
                body: JSON.stringify({ message: 'Unauthorized' })
            })
        );
        expect(store.repopulateIndexesFromUTxOs).not.toHaveBeenCalled();
        expect(mockedHelpers.fetchPaginatedResults).not.toHaveBeenCalled();
    });

    it('lambdaHandler runs reindex from function-url shortcut with whitelisted api-key', async () => {
        const { handlesRepo, scannerModule, store } = setup({ whitelistedApiKeys: 'allowed-a,allowed-b' });
        handlesRepo.getMetrics.mockReturnValue({
            lockLambdas: LockedLambdaReason.UNLOCKED,
            indexSchemaVersion: 1,
            currentBlockHash: 'start_hash',
            currentSlot: 100
        });
        const functionUrlEvent = {
            requestContext: { http: { method: 'POST', path: '/reindex' } },
            headers: { 'api-key': 'allowed-b' }
        } as any;

        const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
        let result: any;

        try {
            result = await scannerModule.lambdaHandler(functionUrlEvent, {} as any);
        } finally {
            expect(
                errorSpy.mock.calls.some(([entry]) =>
                    `${entry}`.includes('"event": "scannerLambda.reindexShortcut"')
                    && `${entry}`.includes('NOTIFY')
                )
            ).toBe(true);
            errorSpy.mockRestore();
        }

        expect(result).toEqual(
            expect.objectContaining({
                statusCode: 200,
                body: JSON.stringify({ message: 'Reindex complete' })
            })
        );
        expect(store.repopulateIndexesFromUTxOs).toHaveBeenCalledTimes(1);
        expect(mockedHelpers.fetchPaginatedResults).not.toHaveBeenCalled();
    });

    // Invariant: the function-url reindex shortcut must NOT run concurrently with a
    // cron-triggered scan. The lease is the mutex; if a shortcut request can't acquire it,
    // the scanner is actively writing to Valkey and we refuse the shortcut with 409 rather
    // than racing the writer. Failure mode: before the fix, the shortcut bypassed the lease
    // and ran updateHandleIndexes concurrently with the active scan on the same keys.
    it('lambdaHandler refuses reindex shortcut with 409 when lease is held', async () => {
        const { handlesRepo, scannerModule, store } = setup({ whitelistedApiKeys: 'allowed-a' });
        handlesRepo.getMetrics.mockReturnValue({ lockLambdas: LockedLambdaReason.UNLOCKED });
        // Pre-seed the lease so acquireScannerLease returns false
        scannerModule.Internal.acquireScannerLease('existing-owner');
        const functionUrlEvent = {
            requestContext: { http: { method: 'POST', path: '/reindex' } },
            headers: { 'api-key': 'allowed-a' }
        } as any;

        const result = await scannerModule.lambdaHandler(functionUrlEvent, {} as any);

        expect(result).toEqual(expect.objectContaining({ statusCode: 409 }));
        expect(JSON.parse(result.body)).toEqual(expect.objectContaining({ shortcut: 'reindex' }));
        expect(store.repopulateIndexesFromUTxOs).not.toHaveBeenCalled();
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
            // Orphan u1 to reach the asset_utxos path under the new delta-based rollback check.
            [buildUtxo({ id: 'u1', slot: 200, blockHash: 'api_a', assetName: 'asset-a' })],
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

    it('scan halts without crashing when tx_info returns null for a requested hash', async () => {
        // Null tx_info response yields zero rows — the coverage check fires
        // and pauses the scan rather than crashing or silently advancing
        // past the missed tx. Pre-halt behaviour processed an empty txList
        // and called downstream handlers with []; the halt now skips them.
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

        await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();

        // Scan halted before any block was processed, so no
        // UTxO/handle-index mutation should have occurred.
        expect(handlesRepo.addUTxOsWithMintDataAndUpdateIndexes).not.toHaveBeenCalled();
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
            if (cmd === 'get' && args[0] === getApiScannerLeaseKey()) return 'another-owner';
            return originalRedisClientCall?.(cmd, ...args);
        });

        try {
            await scannerModule.lambdaHandler({} as any, {} as any);
        } finally {
            setIntervalSpy.mockRestore();
        }

        expect(store.redisClientCall).not.toHaveBeenCalledWith('pexpire', getApiScannerLeaseKey(), expect.any(Number));
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
            if (cmd === 'get' && args[0] === getApiScannerLeaseKey()) {
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

    it('scan falls back to Blockfrost when Koios block_txs fails with non-retriable error', async () => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });

        mockedHelpers.fetchPaginatedResults.mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('blocks/start_hash/next')) {
                return [{ hash: 'block_a', slot: 100, confirmations: 5 }] as never;
            }
            return [] as never;
        });

        mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
            if (path === 'block_txs') {
                throw new Error('Koios internal server error');
            }
            if (path === 'tx_info') {
                const parsedBody = JSON.parse(body ?? '{}');
                return (parsedBody._tx_hashes ?? []).map((txHash: string) => ({
                    tx_hash: txHash,
                    block_hash: 'block_a',
                    inputs: []
                })) as never;
            }
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);
        mockedHelpers.fetchBlockfrostTxHashes.mockResolvedValue([{ block_hash: 'block_a', tx_hash: 'tx_fallback' }] as never);

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();

            expect(mockedHelpers.fetchBlockfrostTxHashes).toHaveBeenCalledWith(['block_a']);
            const txInfoCalls = mockedHelpers.fetchKoios.mock.calls.filter((call) => call[0] === 'tx_info');
            expect(txInfoCalls.length).toBeGreaterThan(0);
            expect(JSON.parse(txInfoCalls[0][2] as string)._tx_hashes).toContain('tx_fallback');
        } finally {
            logSpy.mockRestore();
            warnSpy.mockRestore();
        }
    });

    it('scan falls back to Blockfrost when Koios tx_info fails with non-retriable error', async () => {
        const { handlesRepo, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });

        mockedHelpers.fetchPaginatedResults.mockResolvedValue([
            { hash: 'block_a', slot: 100, confirmations: 5 }
        ] as never);
        mockedHelpers.fetchKoios.mockImplementation(async (path: string) => {
            if (path === 'block_txs') return [{ tx_hash: 'tx_a' }] as never;
            if (path === 'tx_info') {
                throw new Error('Koios internal server error');
            }
            return [] as never;
        });
        const fallbackTxInfo = { tx_hash: 'tx_a', block_hash: 'block_a', block_height: 1, absolute_slot: 100, inputs: [], outputs: [], assets_minted: [], metadata: {}, reference_inputs: [] };
        mockedHelpers.fetchBlockfrostTxInfo.mockResolvedValue(fallbackTxInfo as never);
        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();

            expect(mockedHelpers.fetchBlockfrostTxInfo).toHaveBeenCalledWith('tx_a');
        } finally {
            logSpy.mockRestore();
            warnSpy.mockRestore();
        }
    });

    it('scan halts at the first block whose tx_info coverage is incomplete (block_txs path)', async () => {
        // Validates: when Koios's /tx_info returns HTTP 200 with fewer rows
        // than the request listed (empirically observed — see
        // project_known_integrity_gaps.md gap #3, dominant cause is Maestro
        // outpacing Koios's tx_info indexer), the scanner halts before
        // advancing past any block in the affected chunk. The next
        // invocation will retry from currentBlockHash, by which time Koios
        // will have caught up.
        // Failure mode caught: regression to advancing past a missed tx,
        // which left preview pz_settings pointing at a UTxO consumed 3+
        // days earlier (slot 111168833 / tx abbf7e561505d8).
        const { handlesRepo, store, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });

        mockedHelpers.fetchPaginatedResults.mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('blocks/start_hash/next')) {
                return [{ hash: 'block_a', slot: 100, confirmations: 5 }] as never;
            }
            return [] as never;
        });

        mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
            if (path === 'block_txs') {
                return [{ tx_hash: 'tx_present' }, { tx_hash: 'tx_dropped' }] as never;
            }
            if (path === 'tx_info') {
                const parsedBody = JSON.parse(body ?? '{}');
                const requested: string[] = parsedBody._tx_hashes ?? [];
                // Simulate Koios returning only one of the two requested rows.
                return requested
                    .filter((hash) => hash !== 'tx_dropped')
                    .map((tx_hash) => ({
                        tx_hash,
                        block_hash: 'block_a',
                        block_height: 1,
                        absolute_slot: 100,
                        inputs: [],
                        outputs: [],
                        assets_minted: [],
                        metadata: {},
                        reference_inputs: []
                    })) as never;
            }
            return [] as never;
        });

        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();

            // Negative control: the scanner must NOT advance currentSlot
            // past block_a, and must NOT record block_a as scanned. If the
            // halt regresses, both of these would be called.
            expect(handlesRepo.setMetrics).not.toHaveBeenCalledWith(
                expect.objectContaining({ currentBlockHash: 'block_a' })
            );
            expect(store.recordScannedBlock).not.toHaveBeenCalledWith(100, 'block_a');

            // Blockfrost must not be touched on the short-response path —
            // we deliberately avoid the slower second-indexer round-trip
            // and let the next Lambda tick refetch.
            expect(mockedHelpers.fetchBlockfrostTxInfo).not.toHaveBeenCalled();
        } finally {
            logSpy.mockRestore();
            warnSpy.mockRestore();
        }
    });

    it('scan halts when Koios block_txs returns fewer rows than Blockfrost tx_count for a block', async () => {
        // Validates: when Blockfrost lists a block as having N txs (via the
        // tx_count field on `blocks/{hash}/next`) but Koios's block_txs
        // returns fewer rows for that same block hash, the providers
        // disagree about this block's contents — typically because the
        // block is inside the k=2160 reorg window on Blockfrost's chain
        // but NOT on Koios's chain. The scanner halts at that block so it
        // doesn't silently accept Koios's empty answer as truth and
        // advance currentSlot through divergent territory.
        // Failure mode caught: regression to the 2026-05-06 23:11 PDT
        // preview behavior, where every block_txs response was empty for
        // 16+ hours yet currentSlot kept advancing.
        const { handlesRepo, store, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });

        mockedHelpers.fetchPaginatedResults.mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('blocks/start_hash/next')) {
                // Blockfrost says this block has 2 txs.
                return [{ hash: 'block_divergent', slot: 100, confirmations: 5, tx_count: 2 }] as never;
            }
            return [] as never;
        });

        mockedHelpers.fetchKoios.mockImplementation(async (path: string) => {
            if (path === 'block_txs') {
                // Koios returns nothing for this block hash — its chain
                // doesn't include block_divergent.
                return [] as never;
            }
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();

            // Negative control: scanner must NOT advance past block_divergent
            // when block_txs row count (0) is short of Blockfrost tx_count (2).
            expect(handlesRepo.setMetrics).not.toHaveBeenCalledWith(
                expect.objectContaining({ currentBlockHash: 'block_divergent' })
            );
            expect(store.recordScannedBlock).not.toHaveBeenCalledWith(100, 'block_divergent');
            expect(handlesRepo.addUTxOsWithMintDataAndUpdateIndexes).not.toHaveBeenCalled();
        } finally {
            logSpy.mockRestore();
            warnSpy.mockRestore();
        }
    });

    it('scan processes complete blocks and halts at the first incomplete block (Maestro path)', async () => {
        // Validates the per-block coverage check on the Maestro discovery
        // path: blocks whose Maestro-listed tx_hashes are all present in
        // tx_info advance normally; the first block missing any expected
        // tx_hash halts the scan so the next invocation retries from there.
        // Failure mode caught: a regression that either (a) advances past
        // an incomplete block, or (b) halts unnecessarily on a complete
        // block ahead of an incomplete one.
        const { handlesRepo, store, scannerModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });

        mockedHelpers.fetchPaginatedResults.mockImplementation(async (endpoint: string) => {
            if (endpoint.includes('blocks/start_hash/next')) {
                return [
                    { hash: 'block_complete', slot: 100, confirmations: 5 },
                    { hash: 'block_incomplete', slot: 110, confirmations: 5 },
                    { hash: 'block_after', slot: 120, confirmations: 5 }
                ] as never;
            }
            return [] as never;
        });

        mockedMaestro.isMaestroConfigured.mockReturnValue(true);
        mockedMaestro.discoverHandleTxsBySlotRange.mockResolvedValue({
            txHashes: ['tx_in_complete', 'tx_in_incomplete'],
            slotByTx: new Map<string, number>([
                ['tx_in_complete', 100],
                ['tx_in_incomplete', 110]
            ])
        } as never);

        mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
            if (path === 'tx_info') {
                const parsedBody = JSON.parse(body ?? '{}');
                const requested: string[] = parsedBody._tx_hashes ?? [];
                // Koios has tx_in_complete but not tx_in_incomplete yet
                // (the lag scenario). Return only the one it has.
                return requested
                    .filter((hash) => hash === 'tx_in_complete')
                    .map((tx_hash) => ({
                        tx_hash,
                        block_hash: 'block_complete',
                        block_height: 1,
                        absolute_slot: 100,
                        inputs: [],
                        outputs: [],
                        assets_minted: [],
                        metadata: {},
                        reference_inputs: []
                    })) as never;
            }
            return [] as never;
        });

        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
        try {
            await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();

            // block_complete must be processed (currentSlot advances to 100,
            // recordScannedBlock called).
            expect(handlesRepo.setMetrics).toHaveBeenCalledWith(
                expect.objectContaining({ currentBlockHash: 'block_complete', currentSlot: 100 })
            );
            expect(store.recordScannedBlock).toHaveBeenCalledWith(100, 'block_complete');

            // block_incomplete and block_after must NOT advance — coverage
            // check halted the scan at block_incomplete.
            expect(handlesRepo.setMetrics).not.toHaveBeenCalledWith(
                expect.objectContaining({ currentBlockHash: 'block_incomplete' })
            );
            expect(handlesRepo.setMetrics).not.toHaveBeenCalledWith(
                expect.objectContaining({ currentBlockHash: 'block_after' })
            );
            expect(store.recordScannedBlock).not.toHaveBeenCalledWith(110, 'block_incomplete');
            expect(store.recordScannedBlock).not.toHaveBeenCalledWith(120, 'block_after');

            expect(mockedHelpers.fetchBlockfrostTxInfo).not.toHaveBeenCalled();
        } finally {
            logSpy.mockRestore();
            warnSpy.mockRestore();
        }
    });

    // NOTE: datum_info Blockfrost fallback is tested via fetchBlockfrostDatumCbor in helpers.blockfrost-fallback.test.ts.
    // A scanner-level datum_info fallback test is impractical here because asyncForEach in kora-labs-common
    // creates a dangling rejected promise during its internal delay, which triggers Jest's unhandled rejection detection.

    // ===== Demeter UTxORPC integration =====
    describe('Demeter UTxORPC integration', () => {
        it('applies a complete block and detects a pure burn directly from transaction mint data', async () => {
            // Invariant: the selected Demeter path updates outputs, spent inputs, burns, metrics, and scanned-block history in one ordered block commit.
            // Failure caught: deriving burns only from tracked outputs would miss this pure burn because the burned asset has no output.
            const { handlesRepo, pipelineResponses, scannerModule, store } = setup();
            const trackedPolicy = 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a';
            const builtUtxo = buildUtxo({ id: 'new_tx#0', slot: 150, blockHash: 'demeter_block', assetName: 'new-handle' });
            const burnedHandle = { name: 'burned-handle', amount: 1 };
            pipelineResponses.push([burnedHandle]);
            mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([builtUtxo] as never);
            mockedDemeter.isDemeterScannerEnabled.mockReturnValue(true);
            mockedDemeter.scanDemeterBlocks.mockImplementationOnce(async (start, policies, _timeout, onBlock) => {
                expect(start).toEqual({ slot: 130, hash: 'start_hash' });
                expect(policies).toContain(trackedPolicy);
                const tip = { slot: 170, hash: 'demeter_tip' };
                await onBlock({
                    ref: { slot: 150, hash: 'demeter_block', height: 99 },
                    transactions: [{
                        block_hash: 'demeter_block', block_height: 99, absolute_slot: 150,
                        reference_inputs: [], outputs: [], inputs: [{ tx_hash: 'spent_tx', tx_index: 4 }],
                        tx_hash: 'new_tx',
                        assets_minted: [{ decimals: 0, quantity: '-1', policy_id: trackedPolicy, asset_name: '6275726e65642d68616e646c65', fingerprint: '' }],
                        metadata: {}
                    }]
                }, tip);
                return tip;
            });
            mockedGetHandleNameFromAssetName.mockReturnValue({
                name: 'burned-handle', ownerTokenHex: '', isCip67: false, assetLabel: null
            });

            await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();

            expect(mockedHelpers.fetchPaginatedResults).not.toHaveBeenCalled();
            expect(handlesRepo.removeHandle).toHaveBeenCalledWith(burnedHandle);
            expect(handlesRepo.addUTxOsWithMintDataAndUpdateIndexes).toHaveBeenCalledWith([builtUtxo]);
            expect(handlesRepo.removeUTxOs).toHaveBeenCalledWith(['spent_tx#4']);
            expect(handlesRepo.setMetrics).toHaveBeenCalledWith({
                currentSlot: 150,
                currentBlockHash: 'demeter_block',
                tipBlockHash: 'demeter_tip',
                lastSlot: 170
            });
            expect(store.recordScannedBlock).toHaveBeenCalledWith(150, 'demeter_block');
        });
    });

    // ===== Maestro discovery integration =====
    describe('Maestro discovery integration', () => {
        beforeEach(() => {
            mockedMaestro.isMaestroConfigured.mockReset();
            mockedMaestro.discoverHandleTxsBySlotRange.mockReset();
        });

        it('uses Maestro-discovered tx_hashes and skips block_txs when discovery succeeds', async () => {
            // Validates: when MAESTRO_API_KEY is set and the window's last block is past the
            // safety lag threshold, scan() consults Maestro for handle-touching tx_hashes
            // and feeds them straight to tx_info — bypassing the block_txs fan-out.
            // Failure mode caught: a missing wire-up would still call block_txs (wasted work)
            // or, worse, drop Maestro's hashes and process the block as empty (silent miss).
            const { handlesRepo, scannerModule } = setup();
            handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });
            mockedHelpers.fetchPaginatedResults.mockResolvedValue([
                { hash: 'block_a', slot: 500, confirmations: 100 }
            ] as never);
            mockedMaestro.isMaestroConfigured.mockReturnValue(true);
            mockedMaestro.discoverHandleTxsBySlotRange.mockResolvedValue({
                txHashes: ['handle_tx_1'],
                slotByTx: new Map([['handle_tx_1', 500]])
            });
            mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
                if (path === 'tx_info') {
                    const parsedBody = JSON.parse(body ?? '{}');
                    return (parsedBody._tx_hashes ?? []).map((txHash: string) => ({ tx_hash: txHash, block_hash: 'block_a', inputs: [] })) as never;
                }
                return [] as never;
            });
            mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);

            await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();

            expect(mockedMaestro.discoverHandleTxsBySlotRange).toHaveBeenCalledTimes(1);
            const blockTxsCalls = mockedHelpers.fetchKoios.mock.calls.filter((call) => call[0] === 'block_txs');
            expect(blockTxsCalls).toHaveLength(0);
            const txInfoCalls = mockedHelpers.fetchKoios.mock.calls.filter((call) => call[0] === 'tx_info');
            expect(txInfoCalls).toHaveLength(1);
            const parsedTxInfoBody = JSON.parse((txInfoCalls[0][2] ?? '{}') as string);
            expect(parsedTxInfoBody._tx_hashes).toEqual(['handle_tx_1']);
        });

        it('falls back to block_txs when Maestro discovery returns null', async () => {
            // Validates: Maestro returning null (configured but failing — e.g., 429 cool-down
            // or post-retry transient failure) is transparently handled by falling through
            // to the existing block_txs path, with no scan correctness loss.
            // Failure mode caught: a missing fallback branch would mean any Maestro outage
            // immediately breaks the scanner; we want it to be a transparent perf optimization.
            const { handlesRepo, scannerModule } = setup();
            handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });
            mockedHelpers.fetchPaginatedResults.mockResolvedValue([
                { hash: 'block_a', slot: 500, confirmations: 100 }
            ] as never);
            mockedMaestro.isMaestroConfigured.mockReturnValue(true);
            mockedMaestro.discoverHandleTxsBySlotRange.mockResolvedValue(null);
            mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
                if (path === 'block_txs') return [{ tx_hash: 'block_txs_tx_1' }] as never;
                if (path === 'tx_info') {
                    const parsedBody = JSON.parse(body ?? '{}');
                    return (parsedBody._tx_hashes ?? []).map((txHash: string) => ({ tx_hash: txHash, block_hash: 'block_a', inputs: [] })) as never;
                }
                return [] as never;
            });
            mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);

            await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();

            expect(mockedMaestro.discoverHandleTxsBySlotRange).toHaveBeenCalledTimes(1);
            const blockTxsCalls = mockedHelpers.fetchKoios.mock.calls.filter((call) => call[0] === 'block_txs');
            expect(blockTxsCalls).toHaveLength(1); // fallback engaged
            const txInfoCalls = mockedHelpers.fetchKoios.mock.calls.filter((call) => call[0] === 'tx_info');
            const parsedTxInfoBody = JSON.parse((txInfoCalls[0][2] ?? '{}') as string);
            expect(parsedTxInfoBody._tx_hashes).toEqual(['block_txs_tx_1']);
        });

        it('does not invoke Maestro when not configured', async () => {
            // Validates: when MAESTRO_API_KEY is unset (most common in dev/preview/preprod),
            // scan() never reaches discoverHandleTxsBySlotRange and uses block_txs unchanged.
            // Failure mode caught: invoking a Maestro service with no key would throw or
            // log noise on every scan tick in non-mainnet environments.
            const { handlesRepo, scannerModule } = setup();
            handlesRepo.getMetrics.mockReturnValue({ currentBlockHash: 'start_hash', lockLambdas: LockedLambdaReason.UNLOCKED });
            mockedHelpers.fetchPaginatedResults.mockResolvedValue([
                { hash: 'block_a', slot: 500, confirmations: 100 }
            ] as never);
            mockedMaestro.isMaestroConfigured.mockReturnValue(false);
            mockedHelpers.fetchKoios.mockImplementation(async (path: string, _method?: string, body?: string) => {
                if (path === 'block_txs') return [{ tx_hash: 'block_txs_tx' }] as never;
                if (path === 'tx_info') {
                    const parsedBody = JSON.parse(body ?? '{}');
                    return (parsedBody._tx_hashes ?? []).map((txHash: string) => ({ tx_hash: txHash, block_hash: 'block_a', inputs: [] })) as never;
                }
                return [] as never;
            });
            mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);

            await expect(scannerModule.Internal.scan()).resolves.toBeUndefined();

            expect(mockedMaestro.discoverHandleTxsBySlotRange).not.toHaveBeenCalled();
            const blockTxsCalls = mockedHelpers.fetchKoios.mock.calls.filter((call) => call[0] === 'block_txs');
            expect(blockTxsCalls).toHaveLength(1);
        });
    });
});
