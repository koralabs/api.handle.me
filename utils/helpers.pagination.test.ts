import { Logger, NETWORK } from '@koralabs/kora-labs-common';
import * as kms from './kms';
import { blockfrostApiCall, fetchKoios, fetchPaginatedResults, fetchTxList } from './helpers';

jest.mock('./kms', () => ({
    hydrateKmsKeysIfNeeded: jest.fn()
}));

describe('helpers pagination tests', () => {
    const originalFetch = global.fetch;
    const originalBlockfrostApiKey = process.env.BLOCKFROST_API_KEY;
    const originalBlockfrostApiKeyEnc = process.env.BLOCKFROST_API_KEY_ENC;
    const originalKoiosToken = process.env.KOIOS_API_BEARER_TOKEN;
    const originalKoiosTokenEnc = process.env.KOIOS_API_BEARER_TOKEN_ENC;

    afterEach(() => {
        process.env.BLOCKFROST_API_KEY = originalBlockfrostApiKey;
        process.env.BLOCKFROST_API_KEY_ENC = originalBlockfrostApiKeyEnc;
        process.env.KOIOS_API_BEARER_TOKEN = originalKoiosToken;
        process.env.KOIOS_API_BEARER_TOKEN_ENC = originalKoiosTokenEnc;
        global.fetch = originalFetch;
        jest.restoreAllMocks();
        (kms.hydrateKmsKeysIfNeeded as jest.Mock).mockReset();
    });

    it('blockfrostApiCall hydrates the API key lazily when only ciphertext is configured', async () => {
        delete process.env.BLOCKFROST_API_KEY;
        process.env.BLOCKFROST_API_KEY_ENC = 'ciphertext';
        const hydrateSpy = kms.hydrateKmsKeysIfNeeded as jest.MockedFunction<typeof kms.hydrateKmsKeysIfNeeded>;
        hydrateSpy.mockImplementation(async () => {
            process.env.BLOCKFROST_API_KEY = 'lazy-key';
        });
        const fetchMock = jest.fn().mockResolvedValue({ status: 200, json: async () => ({}) });
        global.fetch = fetchMock as any;

        await blockfrostApiCall('blocks/latest');

        expect(hydrateSpy).toHaveBeenCalledWith(['BLOCKFROST_API_KEY']);
        expect(fetchMock).toHaveBeenCalledWith(
            `https://cardano-${NETWORK.toLowerCase()}.blockfrost.io/api/v0/blocks/latest`,
            {
                headers: {
                    project_id: 'lazy-key',
                    'Content-Type': 'application/json'
                }
            }
        );
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

    it('fetchPaginatedResults should stop when maxResults is reached', async () => {
        const pageOne = new Array(100).fill(null).map((_, index) => `page1-${index}`);
        const pageTwo = new Array(100).fill(null).map((_, index) => `page2-${index}`);
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce({
                status: 200,
                json: async () => pageOne
            })
            .mockResolvedValueOnce({
                status: 200,
                json: async () => pageTwo
            });
        global.fetch = fetchMock as any;

        const results = await fetchPaginatedResults<string>('blocks/latest/next', 120);

        expect(results).toHaveLength(120);
        expect(results[0]).toBe('page1-0');
        expect(results[119]).toBe('page2-19');
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
            ok: true,
            text: async () => JSON.stringify(koiosResponse)
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
                body: '{"_tx_hashes":["abc"]}',
                signal: expect.anything()
            })
        );
    });

    it('fetchKoios hydrates the bearer token lazily when only ciphertext is configured', async () => {
        delete process.env.KOIOS_API_BEARER_TOKEN;
        process.env.KOIOS_API_BEARER_TOKEN_ENC = 'ciphertext';
        const hydrateSpy = kms.hydrateKmsKeysIfNeeded as jest.MockedFunction<typeof kms.hydrateKmsKeysIfNeeded>;
        hydrateSpy.mockImplementation(async () => {
            process.env.KOIOS_API_BEARER_TOKEN = 'lazy-koios-token';
        });
        const koiosResponse = [{ tx_hash: 'abc' }];
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            text: async () => JSON.stringify(koiosResponse)
        });
        global.fetch = fetchMock as any;

        await fetchKoios('tx_info', 'POST', '{"_tx_hashes":["abc"]}');

        expect(hydrateSpy).toHaveBeenCalledWith(['KOIOS_API_BEARER_TOKEN']);
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringMatching(/koios\.rest\/api\/v1\/tx_info$/),
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer lazy-koios-token'
                })
            })
        );
    });

    it('fetchKoios should omit Authorization header when no token is configured', async () => {
        const koiosResponse = [{ tx_hash: 'abc' }];
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            text: async () => JSON.stringify(koiosResponse)
        });
        global.fetch = fetchMock as any;
        delete process.env.KOIOS_API_BEARER_TOKEN;

        const result = await fetchKoios('tx_info', 'POST', '{"_tx_hashes":["abc"]}');

        expect(result).toEqual(koiosResponse);
        expect(fetchMock).toHaveBeenCalledWith(
            expect.stringMatching(/koios\.rest\/api\/v1\/tx_info$/),
            expect.objectContaining({
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: '{"_tx_hashes":["abc"]}',
                signal: expect.anything()
            })
        );
    });

    it('fetchKoios should throw with status when Koios responds with non-JSON 429', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
            text: async () => '<html><body><h1>429 Too Many Requests</h1></body></html>'
        });
        global.fetch = fetchMock as any;
        process.env.KOIOS_API_BEARER_TOKEN = 'koios-token';

        await expect(fetchKoios('tx_info', 'POST', '{"_tx_hashes":["abc"]}')).rejects.toMatchObject({
            status: 429,
            statusText: 'Too Many Requests'
        });
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
                ok: true,
                text: async () => JSON.stringify(txInfoResponse)
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
