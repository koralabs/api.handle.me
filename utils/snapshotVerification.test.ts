import { AssetNameLabel } from '@koralabs/kora-labs-common';
import { buildSnapshotVerification, getChainOwnerHandleCount, isChainVerifiedSnapshot } from './snapshotVerification';

describe('snapshotVerification', () => {
    const originalFetch = global.fetch;
    const originalBlockfrostApiKey = process.env.BLOCKFROST_API_KEY;
    const network = `${process.env.NETWORK ?? 'mainnet'}`.toLowerCase();

    beforeEach(() => {
        process.env.BLOCKFROST_API_KEY = 'preview_test_key';
    });

    afterEach(() => {
        global.fetch = originalFetch;
        process.env.BLOCKFROST_API_KEY = originalBlockfrostApiKey;
        jest.restoreAllMocks();
    });

    it('counts only owner-bearing handle assets from Blockfrost policy pages', async () => {
        const ownerToken = `${AssetNameLabel.LBL_222}${Buffer.from('alpha').toString('hex')}`;
        const virtualSubhandle = `${AssetNameLabel.LBL_000}${Buffer.from('alpha@root').toString('hex')}`;
        const refToken = `${AssetNameLabel.LBL_100}${Buffer.from('alpha').toString('hex')}`;
        const userToken = `${AssetNameLabel.LBL_001}${Buffer.from('alpha').toString('hex')}`;

        global.fetch = jest.fn()
            .mockResolvedValueOnce({
                status: 200,
                ok: true,
                statusText: 'OK',
                json: async () => [
                    { asset: `f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a${ownerToken}`, quantity: '1' },
                    { asset: `f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a${virtualSubhandle}`, quantity: '1' },
                    { asset: `f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a${refToken}`, quantity: '1' },
                    { asset: `f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a${userToken}`, quantity: '1' },
                    { asset: 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a', quantity: '1' }
                ]
            })
            .mockResolvedValueOnce({
                status: 200,
                ok: true,
                statusText: 'OK',
                json: async () => []
            })
            .mockResolvedValueOnce({
                status: 200,
                ok: true,
                statusText: 'OK',
                json: async () => []
            })
            .mockResolvedValueOnce({
                status: 200,
                ok: true,
                statusText: 'OK',
                json: async () => []
            }) as any;

        await expect(getChainOwnerHandleCount()).resolves.toBe(2);
    });

    it('builds verification metadata when snapshot and chain counts match', async () => {
        jest.spyOn(global, 'fetch')
            .mockResolvedValueOnce({
                status: 200,
                ok: true,
                statusText: 'OK',
                json: async () => [{ asset: `f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a${AssetNameLabel.LBL_222}616c706861`, quantity: '1' }]
            } as any)
            .mockResolvedValueOnce({ status: 200, ok: true, statusText: 'OK', json: async () => [] } as any)
            .mockResolvedValueOnce({ status: 200, ok: true, statusText: 'OK', json: async () => [] } as any)
            .mockResolvedValueOnce({ status: 200, ok: true, statusText: 'OK', json: async () => [] } as any);

        const verification = await buildSnapshotVerification(1);

        expect(verification).toEqual(expect.objectContaining({
            verifiedAgainstChain: true,
            snapshotHandleCount: 1,
            chainHandleCount: 1,
            network
        }));
        expect(isChainVerifiedSnapshot({ slot: 1, hash: 'hash', utxos: [], mintingData: {}, verification })).toBe(true);
    });
});
