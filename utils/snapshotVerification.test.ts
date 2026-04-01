const mockInitialize = jest.fn().mockResolvedValue(undefined);
const mockGetHashFromIndex = jest.fn();
const mockGetKeysFromIndex = jest.fn().mockReturnValue([]);
const mockGetMptRootHash = jest.fn().mockReturnValue(undefined);
const mockSetMptRootHash = jest.fn();

jest.mock('../stores/redis', () => ({
    RedisHandlesStore: jest.fn().mockImplementation(() => ({
        initialize: mockInitialize,
        getHashFromIndex: mockGetHashFromIndex,
        getKeysFromIndex: mockGetKeysFromIndex,
        getMptRootHash: mockGetMptRootHash,
        setMptRootHash: mockSetMptRootHash
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
        const { buildHandleSetMptRootHash, buildSnapshotVerification, GHOST_HANDLES } = await import('./snapshotVerification');
        const ghosts = GHOST_HANDLES[process.env.NETWORK?.toLowerCase() ?? ''] ?? [];
        const rootHash = await buildHandleSetMptRootHash(['alpha'], ghosts);

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

    it('returns verifiedAgainstChain=false when snapshot and indexed chain roots differ', async () => {
        const { buildHandleSetMptRootHash, buildSnapshotVerification, GHOST_HANDLES } = await import('./snapshotVerification');
        const ghosts = GHOST_HANDLES[process.env.NETWORK?.toLowerCase() ?? ''] ?? [];
        const rootHash = await buildHandleSetMptRootHash(['alpha'], ghosts);

        mockGetHashFromIndex.mockReturnValue({
            datum: `d8799f5820${'00'.repeat(32)}ff`
        });

        const verification = await buildSnapshotVerification(['alpha']);
        expect(verification).toEqual(expect.objectContaining({
            verifiedAgainstChain: false,
            snapshotMptRootHash: rootHash,
            chainMptRootHash: '00'.repeat(32)
        }));
    });

    it('includes ghost handles in the MPT root hash', async () => {
        const { buildHandleSetMptRootHash } = await import('./snapshotVerification');

        const hashWithout = await buildHandleSetMptRootHash(['alpha']);
        const hashWith = await buildHandleSetMptRootHash(['alpha'], ['ghost@sub']);

        expect(hashWithout).not.toBe(hashWith);
        expect(hashWith).toMatch(/^[0-9a-f]{64}$/);
    });

    it('buildAndStoreMptRootHash builds from store handle index and persists the hash', async () => {
        mockGetKeysFromIndex.mockReturnValue(['alpha', 'beta']);
        const { buildAndStoreMptRootHash, buildHandleSetMptRootHash, GHOST_HANDLES } = await import('./snapshotVerification');

        const ghosts = GHOST_HANDLES[process.env.NETWORK?.toLowerCase() ?? ''] ?? [];
        const expectedHash = await buildHandleSetMptRootHash(['alpha', 'beta'], ghosts);
        const result = await buildAndStoreMptRootHash({ getKeysFromIndex: mockGetKeysFromIndex, setMptRootHash: mockSetMptRootHash } as any);

        expect(result).toBe(expectedHash);
        expect(mockSetMptRootHash).toHaveBeenCalledWith(expectedHash);
    });

    it('buildSnapshotVerification uses stored hash when available', async () => {
        const { buildHandleSetMptRootHash, buildSnapshotVerification } = await import('./snapshotVerification');
        const storedHash = await buildHandleSetMptRootHash(['alpha']);

        mockGetMptRootHash.mockReturnValue(storedHash);
        mockGetHashFromIndex.mockReturnValue({
            datum: `d8799f5820${storedHash}ff`
        });

        const verification = await buildSnapshotVerification(['ignored']);
        expect(verification.snapshotMptRootHash).toBe(storedHash);
        expect(verification.verifiedAgainstChain).toBe(true);
    });

    it('throws when the indexed settings handle datum is missing', async () => {
        const { getChainMintingDataRootHash } = await import('./snapshotVerification');

        mockGetHashFromIndex.mockReturnValue(undefined);

        await expect(getChainMintingDataRootHash()).rejects.toThrow('Minting data datum not found for handle handle_root@handle_settings');
    });
});
