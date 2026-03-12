const mockInitialize = jest.fn().mockResolvedValue(undefined);
const mockGetHashFromIndex = jest.fn();

jest.mock('../stores/redis', () => ({
    RedisHandlesStore: jest.fn().mockImplementation(() => ({
        initialize: mockInitialize,
        getHashFromIndex: mockGetHashFromIndex
    }))
}));

describe('snapshotVerification', () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
    });

    it('loads the current minting-data root hash from the indexed settings handle datum', async () => {
        const { buildHandleSetMptRootHash, getChainMintingDataRootHash } = await import('./snapshotVerification');
        const rootHash = await buildHandleSetMptRootHash(['alpha']);

        mockGetHashFromIndex.mockReturnValue({
            datum: `d8799f5820${rootHash}ff`
        });

        await expect(getChainMintingDataRootHash()).resolves.toBe(rootHash);
        expect(mockInitialize).toHaveBeenCalled();
    });

    it('builds verification metadata when snapshot and indexed chain roots match', async () => {
        const { buildHandleSetMptRootHash, buildSnapshotVerification } = await import('./snapshotVerification');
        const rootHash = await buildHandleSetMptRootHash(['alpha']);

        mockGetHashFromIndex.mockReturnValue({
            datum: `d8799f5820${rootHash}ff`
        });

        const verification = await buildSnapshotVerification(['alpha']);

        expect(verification).toEqual(expect.objectContaining({
            verifiedAgainstChain: true,
            snapshotMptRootHash: rootHash,
            chainMptRootHash: rootHash
        }));
    });

    it('throws when snapshot and indexed chain roots differ', async () => {
        const { buildHandleSetMptRootHash, buildSnapshotVerification } = await import('./snapshotVerification');
        const rootHash = await buildHandleSetMptRootHash(['alpha']);

        mockGetHashFromIndex.mockReturnValue({
            datum: `d8799f5820${'00'.repeat(32)}ff`
        });

        await expect(buildSnapshotVerification(['alpha'])).rejects.toThrow(`Snapshot MPT root mismatch: snapshot=${rootHash}, chain=${'00'.repeat(32)}`);
    });

    it('throws when the indexed settings handle datum is missing', async () => {
        const { getChainMintingDataRootHash } = await import('./snapshotVerification');

        mockGetHashFromIndex.mockReturnValue(undefined);

        await expect(getChainMintingDataRootHash()).rejects.toThrow('Minting data datum not found for handle handle_root@handle_settings');
    });
});
