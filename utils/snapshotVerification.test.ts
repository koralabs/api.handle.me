import { LogCategory, Logger } from '@koralabs/kora-labs-common';
import { buildHandleSetMptRootHash, buildSnapshotVerification, getChainMintingDataRootHash, isChainVerifiedSnapshot } from './snapshotVerification';

describe('snapshotVerification', () => {
    const originalFetch = global.fetch;
    const originalBlockfrostApiKey = process.env.BLOCKFROST_API_KEY;
    const network = `${process.env.NETWORK ?? 'mainnet'}`.toLowerCase();
    const mintingDataAssetId = `f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a${Buffer.from('handle_root@handle_settings').toString('hex')}`;

    beforeEach(() => {
        process.env.BLOCKFROST_API_KEY = 'preview_test_key';
    });

    afterEach(() => {
        global.fetch = originalFetch;
        process.env.BLOCKFROST_API_KEY = originalBlockfrostApiKey;
        jest.restoreAllMocks();
    });

    it('loads the current minting-data root hash from the Blockfrost asset UTxO datum', async () => {
        const rootHash = await buildHandleSetMptRootHash(['alpha']);

        global.fetch = jest.fn()
            .mockResolvedValueOnce({
                status: 200,
                ok: true,
                statusText: 'OK',
                json: async () => [{ tx_hash: 'minting-data-tx' }]
            } as any)
            .mockResolvedValueOnce({
                status: 200,
                ok: true,
                statusText: 'OK',
                json: async () => ({
                    outputs: [
                        {
                            output_index: 0,
                            amount: [
                                { unit: 'lovelace', quantity: '1500000' },
                                { unit: mintingDataAssetId, quantity: '1' }
                            ],
                            inline_datum: `d8799f5820${rootHash}ff`
                        }
                    ]
                })
            }) as any;

        await expect(getChainMintingDataRootHash()).resolves.toBe(rootHash);
    });

    it('builds verification metadata when snapshot and chain roots match', async () => {
        const rootHash = await buildHandleSetMptRootHash(['alpha']);

        jest.spyOn(global, 'fetch')
            .mockResolvedValueOnce({
                status: 200,
                ok: true,
                statusText: 'OK',
                json: async () => [{ tx_hash: 'minting-data-tx' }]
            } as any)
            .mockResolvedValueOnce({
                status: 200,
                ok: true,
                statusText: 'OK',
                json: async () => ({
                    outputs: [
                        {
                            output_index: 0,
                            amount: [
                                { unit: 'lovelace', quantity: '1500000' },
                                { unit: mintingDataAssetId, quantity: '1' }
                            ],
                            inline_datum: `d8799f5820${rootHash}ff`
                        }
                    ]
                })
            } as any);

        const verification = await buildSnapshotVerification(['alpha']);

        expect(verification).toEqual(expect.objectContaining({
            verifiedAgainstChain: true,
            snapshotMptRootHash: rootHash,
            chainMptRootHash: rootHash,
            network
        }));
        expect(isChainVerifiedSnapshot({ slot: 1, hash: 'hash', utxos: [], mintingData: {}, verification })).toBe(true);
    });

    it('throws when snapshot and chain roots differ', async () => {
        const rootHash = await buildHandleSetMptRootHash(['alpha']);
        const loggerSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());

        jest.spyOn(global, 'fetch')
            .mockResolvedValueOnce({
                status: 200,
                ok: true,
                statusText: 'OK',
                json: async () => [{ tx_hash: 'minting-data-tx' }]
            } as any)
            .mockResolvedValueOnce({
                status: 200,
                ok: true,
                statusText: 'OK',
                json: async () => ({
                    outputs: [
                        {
                            output_index: 0,
                            amount: [
                                { unit: 'lovelace', quantity: '1500000' },
                                { unit: mintingDataAssetId, quantity: '1' }
                            ],
                            inline_datum: `d8799f5820${'00'.repeat(32)}ff`
                        }
                    ]
                })
            } as any);

        await expect(buildSnapshotVerification(['alpha'])).rejects.toThrow(`Snapshot MPT root mismatch: snapshot=${rootHash}, chain=${'00'.repeat(32)}`);
        expect(loggerSpy).toHaveBeenCalledWith(expect.objectContaining({
            category: LogCategory.WARN,
            event: 'snapshotVerification.mptRootMismatch'
        }));
    });
});
