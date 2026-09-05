import { IndexNames, NETWORK } from '@koralabs/kora-labs-common';
import MptRootController from './mptRoot.controller';
import { HandlesRepository } from '../repositories/handlesRepository';
import {
    buildHandleSetMptRootHash,
    buildLabelAssetProof,
    getChainMintingDataRootHash,
    probeProviderMptRootHash
} from '../utils/snapshotVerification';

jest.mock('../repositories/handlesRepository', () => ({
    HandlesRepository: jest.fn()
}));

jest.mock('../utils/snapshotVerification', () => ({
    GHOST_HANDLES: { preview: ['ghost-handle'] },
    buildHandleSetMptRootHash: jest.fn(),
    buildLabelAssetProof: jest.fn(),
    getChainMintingDataRootHash: jest.fn(),
    probeProviderMptRootHash: jest.fn()
}));

const mockBuildHandleSetMptRootHash = buildHandleSetMptRootHash as jest.MockedFunction<typeof buildHandleSetMptRootHash>;
const mockBuildLabelAssetProof = buildLabelAssetProof as jest.MockedFunction<typeof buildLabelAssetProof>;
const mockGetChainMintingDataRootHash = getChainMintingDataRootHash as jest.MockedFunction<typeof getChainMintingDataRootHash>;
const mockProbeProviderMptRootHash = probeProviderMptRootHash as jest.MockedFunction<typeof probeProviderMptRootHash>;
const MockHandlesRepository = HandlesRepository as jest.MockedClass<typeof HandlesRepository>;

const makeResponse = () => {
    const res = {
        status: jest.fn(),
        json: jest.fn()
    } as any;
    res.status.mockReturnValue(res);
    res.json.mockReturnValue(res);
    return res;
};

const makeRequest = (store: any, query: Record<string, unknown> = {}) => ({
    app: {
        get: jest.fn().mockReturnValue({
            handlesStore: jest.fn().mockImplementation(() => store)
        })
    },
    query
} as any);

describe('MptRootController tests', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        MockHandlesRepository.mockImplementation(() => ({
            getMetrics: jest.fn().mockReturnValue({ currentSlot: 40 })
        }) as any);
        mockGetChainMintingDataRootHash.mockResolvedValue('chain-root');
        mockProbeProviderMptRootHash.mockResolvedValue({ provider: 'koios', rootHash: 'chain-root', tipSlot: 42 });
        mockBuildHandleSetMptRootHash.mockResolvedValue('calculated-root');
        mockBuildLabelAssetProof.mockResolvedValue({ proof: 'ok' } as any);
    });

    it('uses the stored MPT root when present and verifies it against datum and provider state', async () => {
        const controller = new MptRootController();
        const store = {
            getMptRootHash: jest.fn().mockReturnValue('chain-root')
        };
        const req = makeRequest(store);
        const res = makeResponse();
        const next = jest.fn();

        await controller.index(req, res, next);

        expect(mockBuildHandleSetMptRootHash).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            calculated_mpt_root_hash: 'chain-root',
            datum_mpt_root_hash: 'chain-root',
            chain_mpt_root_hash: 'chain-root',
            verified: true,
            provider: 'koios',
            provider_tip_slot: 42,
            our_current_slot: 40
        }));
        expect(next).not.toHaveBeenCalled();
    });

    it('rebuilds the MPT root with handle names, ghosts, and registry labels when no root is stored', async () => {
        const controller = new MptRootController();
        const registryLabels = { alpha: '00001070' };
        const store = {
            getMptRootHash: jest.fn().mockReturnValue(undefined),
            getKeysFromIndex: jest.fn().mockReturnValue(['alpha']),
            getAllHandleRegistryLabels: jest.fn().mockReturnValue(registryLabels)
        };
        const req = makeRequest(store);
        const res = makeResponse();
        const next = jest.fn();

        await controller.index(req, res, next);

        expect(store.getKeysFromIndex).toHaveBeenCalledWith(IndexNames.HANDLE);
        expect(mockBuildHandleSetMptRootHash).toHaveBeenCalledWith(['alpha'], expect.any(Array), registryLabels);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            calculated_mpt_root_hash: 'calculated-root',
            verified: false
        }));
    });

    it('returns proof validation errors without building a proof', async () => {
        const controller = new MptRootController();
        const res = makeResponse();
        const next = jest.fn();

        await controller.proof(makeRequest({}, { handle: 'alice', label: '00001070', amount: '2' }), res, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: 'amount must be 1 (mint) or -1 (burn)' });
        expect(mockBuildLabelAssetProof).not.toHaveBeenCalled();
        expect(next).not.toHaveBeenCalled();
    });

    it('builds label proofs and maps proof failures to conflict responses', async () => {
        const controller = new MptRootController();
        const store = {};
        const req = makeRequest(store, { handle: 'alice', label: '00001070', amount: '1' });
        const res = makeResponse();
        const next = jest.fn();

        await controller.proof(req, res, next);

        expect(mockBuildLabelAssetProof).toHaveBeenCalledWith(store, 'alice', '00001070', 1n);
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({ proof: 'ok' });

        mockBuildLabelAssetProof.mockRejectedValueOnce(new Error('LABEL_ALREADY_PRESENT'));
        const conflictRes = makeResponse();
        await controller.proof(req, conflictRes, next);

        expect(conflictRes.status).toHaveBeenCalledWith(409);
        expect(conflictRes.json).toHaveBeenCalledWith({
            error: 'LABEL_ALREADY_PRESENT',
            handle: 'alice',
            label: '00001070',
            amount: '1'
        });
    });

    it('returns registry labels with the current stored root', async () => {
        const controller = new MptRootController();
        const labels = { alice: '00001070', bob: '000020e0' };
        const store = {
            getAllHandleRegistryLabels: jest.fn().mockReturnValue(labels),
            getMptRootHash: jest.fn().mockReturnValue('stored-root')
        };
        const res = makeResponse();

        await controller.registryLabels(makeRequest(store), res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({
            network: NETWORK.toLowerCase() || 'preview',
            current_root: 'stored-root',
            count: 2,
            labels
        });
    });
});
