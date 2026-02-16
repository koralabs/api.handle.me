import { Logger, NETWORK } from '@koralabs/kora-labs-common';
import { blockfrostApiCall, fetchKoios, fetchPaginatedResults, fetchTxList } from './helpers';

describe('helpers pagination tests', () => {
    const originalFetch = global.fetch;
    const originalBlockfrostApiKey = process.env.BLOCKFROST_API_KEY;
    const originalKoiosToken = process.env.KOIOS_API_BEARER_TOKEN;

    afterEach(() => {
        process.env.BLOCKFROST_API_KEY = originalBlockfrostApiKey;
        process.env.KOIOS_API_BEARER_TOKEN = originalKoiosToken;
        global.fetch = originalFetch;
        jest.restoreAllMocks();
    });

    it('blockfrostApiCall should call expected endpoint and headers', async () => {
        process.env.BLOCKFROST_API_KEY = 'test-key';
        const fetchMock = jest.fn().mockResolvedValue({ status: 200, json: async () => ({}) });
        global.fetch = fetchMock as any;

        await blockfrostApiCall('blocks/latest');

        expect(fetchMock).toHaveBeenCalledWith(
            `https://cardano-${NETWORK.toLowerCase()}.blockfrost.io/api/v0/blocks/latest`,
            {
                headers: {
                    project_id: 'test-key',
                    'Content-Type': 'application/json'
                }
            }
        );
    });

    it('fetchPaginatedResults should return empty list on 404', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            status: 404,
            json: async () => []
        });
        global.fetch = fetchMock as any;

        const results = await fetchPaginatedResults<string>('blocks/latest/next');

        expect(results).toEqual([]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('fetchPaginatedResults should paginate then stop on non-success status', async () => {
        const pageItems = new Array(100).fill(null).map((_, index) => `${index}`);
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce({
                status: 200,
                json: async () => pageItems
            })
            .mockResolvedValueOnce({
                status: 500,
                json: async () => []
            });
        global.fetch = fetchMock as any;

        const results = await fetchPaginatedResults<string>('blocks/latest/next');

        expect(results).toEqual(pageItems);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('fetchPaginatedResults should return empty list and log on thrown error', async () => {
        const fetchMock = jest.fn().mockRejectedValue(new Error('network unavailable'));
        global.fetch = fetchMock as any;
        const logSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());

        const results = await fetchPaginatedResults<string>('blocks/latest/next');

        expect(results).toEqual([]);
        expect(logSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining('Error fetching blocks/latest/next')
            })
        );
    });

    it('fetchKoios should call koios endpoint and parse json', async () => {
        const koiosResponse = [{ tx_hash: 'abc' }];
        const fetchMock = jest.fn().mockResolvedValue({
            json: async () => koiosResponse
        });
        global.fetch = fetchMock as any;
        process.env.KOIOS_API_BEARER_TOKEN = 'koios-token';

        const result = await fetchKoios('tx_info', 'POST', '{"_tx_hashes":["abc"]}');

        expect(result).toEqual(koiosResponse);
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringMatching(/koios\.rest\/api\/v1\/tx_info$/),
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    Authorization: 'Bearer koios-token'
                }),
                body: '{"_tx_hashes":["abc"]}'
            })
        );
    });

    it('fetchTxList should compose blockfrost pagination and koios request', async () => {
        const txHashes = ['tx-hash-1'];
        const txInfoResponse = [{ tx_hash: 'tx-hash-1', outputs: [], assets_minted: [] }];
        const fetchMock = jest.fn().mockImplementation(async (url: string) => {
            if (url.includes('blockfrost.io')) {
                return {
                    status: 200,
                    json: async () => txHashes
                };
            }

            return {
                json: async () => txInfoResponse
            };
        });
        global.fetch = fetchMock as any;

        const result = await fetchTxList('block-hash');

        expect(result).toEqual(txInfoResponse);
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringMatching(/blocks\/block-hash\/txs\?order=asc&count=100&page=1$/),
            expect.anything()
        );
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringMatching(/koios\.rest\/api\/v1\/tx_info$/),
            expect.objectContaining({
                method: 'POST',
                body: expect.stringContaining('"_tx_hashes":["tx-hash-1"]')
            })
        );
    });
});
