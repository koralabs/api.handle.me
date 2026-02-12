import { IndexNames } from '@koralabs/kora-labs-common';
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

const buildUtxo = ({ id, slot, blockHash, assetName }: { id: string; slot: number; blockHash: string; assetName: string }) =>
    ({
        id,
        tx_id: id.split('#')[0],
        index: 0,
        slot,
        blockHash,
        blockNum: 1,
        address: knownAddress,
        lovelace: 1,
        handles: [[policy, [assetName]]],
        mint: [],
        metadata: {}
    }) as any;

const loadRollbackModule = () => {
    let rollbackModule: any;
    jest.isolateModules(() => {
        rollbackModule = require('./rollback');
    });
    return rollbackModule;
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
        removeValueFromIndexedSet: jest.fn()
    };

    const handlesRepo = {
        addUTxOAndMintData: jest.fn(),
        getHandle: jest.fn(),
        getHandleMintingData: jest.fn(),
        getMetrics: jest.fn(),
        getUTxO: jest.fn(),
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
        rollbackModule: loadRollbackModule(),
        store
    };
};

describe('Rollback lambda unit tests', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('exports lambdaHandler', () => {
        const { rollbackModule } = setup();
        expect(typeof rollbackModule.lambdaHandler).toBe('function');
    });

    it('returns early when lambdas are locked', async () => {
        const { handlesRepo, rollbackModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ lockLambdas: true, currentSlot: 100 });

        await expect(rollbackModule.lambdaHandler({} as any, {} as any)).resolves.toBeUndefined();

        expect(handlesRepo.setMetrics).not.toHaveBeenCalled();
        expect(mockedHelpers.blockfrostApiCall).not.toHaveBeenCalled();
    });

    it('runs short rollback path and unlocks after success', async () => {
        const { handlesRepo, pipelineResponses, rollbackModule, store } = setup();
        handlesRepo.getMetrics.mockReturnValue({
            lockLambdas: false,
            currentSlot: 130,
            lastMaxRollbackCheck: Date.now()
        });
        store.getValuesFromOrderedSet.mockReturnValue(['utxo#0']);
        pipelineResponses.push([buildUtxo({ id: 'utxo#0', slot: 100, blockHash: 'provider_block', assetName: 'asset-a' })]);

        await rollbackModule.lambdaHandler({} as any, {} as any);

        expect(mockedHelpers.fetchPaginatedResults).toHaveBeenCalledWith('blocks/4980/next');
        expect(handlesRepo.setMetrics).toHaveBeenNthCalledWith(1, { lockLambdas: true });
        expect(handlesRepo.setMetrics).toHaveBeenLastCalledWith({ lockLambdas: false });
    });

    it('runs max rollback path and updates lastMaxRollbackCheck', async () => {
        const { handlesRepo, pipelineResponses, rollbackModule, store } = setup();
        handlesRepo.getMetrics.mockReturnValue({
            lockLambdas: false,
            currentSlot: 130,
            lastMaxRollbackCheck: 0
        });
        store.getValuesFromOrderedSet.mockReturnValue(['utxo#0']);
        pipelineResponses.push([buildUtxo({ id: 'utxo#0', slot: 100, blockHash: 'provider_block', assetName: 'asset-a' })]);

        await rollbackModule.lambdaHandler({} as any, {} as any);

        expect(mockedHelpers.fetchPaginatedResults).toHaveBeenCalledWith('blocks/2840/next');
        expect(handlesRepo.setMetrics).toHaveBeenNthCalledWith(1, { lockLambdas: true });
        expect(handlesRepo.setMetrics).toHaveBeenNthCalledWith(2, { lastMaxRollbackCheck: expect.any(Number) });
        expect(handlesRepo.setMetrics).toHaveBeenLastCalledWith({ lockLambdas: false });
    });

    it('replays rollback discrepancies and removes mint records in range', async () => {
        const { handlesRepo, pipelineResponses, rollbackModule, store } = setup();
        handlesRepo.getMetrics.mockReturnValue({
            lockLambdas: false,
            currentSlot: 300,
            lastMaxRollbackCheck: Date.now()
        });
        store.getValuesFromOrderedSet.mockReturnValue(['u1', 'u2']);
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([
            { hash: 'provider_a', slot: 200 },
            { hash: 'provider_b', slot: 220 }
        ] as never);

        mockedGetHandleNameFromAssetName.mockImplementation((assetName: string) => {
            if (assetName === 'asset-a') return { name: 'handle-a', ownerTokenHex: 'asset-a', isCip67: false, assetLabel: null };
            if (assetName === 'asset-b') return { name: 'handle-b', ownerTokenHex: 'asset-b', isCip67: false, assetLabel: null };
            if (assetName === 'hex-cip67') return { name: 'handle-a', ownerTokenHex: 'hex-cip67', isCip67: true, assetLabel: null };
            return { name: 'handle-b', ownerTokenHex: assetName, isCip67: false, assetLabel: null };
        });

        const mintToRemove = JSON.stringify({ created_slot: 205, metadata: {}, txHash: 'mint-a' });
        const mintToKeep = JSON.stringify({ created_slot: 150, metadata: {}, txHash: 'mint-b' });
        const retrievedA = JSON.stringify({ created_slot: 100, metadata: {}, txHash: 'stored-a' });
        const retrievedB = JSON.stringify({ created_slot: 110, metadata: {}, txHash: 'stored-b' });

        pipelineResponses.push(
            [
                buildUtxo({ id: 'u1', slot: 200, blockHash: 'api_a', assetName: 'asset-a' }),
                buildUtxo({ id: 'u2', slot: 220, blockHash: 'api_b', assetName: 'asset-b' })
            ],
            [new Set([mintToRemove]), new Set([mintToKeep])],
            [
                { name: 'handle-a', policy: 'policy-a', hex: 'hex-cip67', resolved_addresses: { ada: knownAddress } },
                { name: 'handle-b', policy: 'policy-b', hex: 'hex-plain', resolved_addresses: { ada: knownAddress } }
            ],
            [new Set(['handle-a']), new Set(['handle-b'])],
            [],
            [],
            [new Set([retrievedA]), new Set([retrievedB])]
        );

        mockedHelpers.fetchTxList.mockResolvedValue([{ source: 'block' }] as never);
        mockedHelpers.fetchKoios.mockResolvedValue([{ tx_hash: 'provider_tx_1' }] as never);
        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([
            buildUtxo({ id: 'replayed#0', slot: 221, blockHash: 'provider_b', assetName: 'asset-a' })
        ] as never);

        await rollbackModule.lambdaHandler({} as any, {} as any);

        expect(store.removeValueFromIndexedSet).toHaveBeenCalledWith(IndexNames.MINT, 'handle-a', mintToRemove);
        expect(store.removeValueFromIndexedSet).not.toHaveBeenCalledWith(IndexNames.MINT, 'handle-b', mintToKeep);
        expect(handlesRepo.updateHolder).toHaveBeenCalledTimes(2);
        expect(handlesRepo.removeUTxOs).toHaveBeenCalledWith(['u1']);
        expect(handlesRepo.removeUTxOs).toHaveBeenCalledWith(['u2']);
        expect(handlesRepo.addUTxOAndMintData).toHaveBeenCalledTimes(2);
    });
});
