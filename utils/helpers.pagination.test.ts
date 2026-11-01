jest.mock('@koralabs/kora-labs-common', () => ({
    ...jest.requireActual('@koralabs/kora-labs-common'),
    delay: jest.fn().mockResolvedValue(undefined)
}));

import { Logger, NETWORK } from '@koralabs/kora-labs-common';
import { blockfrostApiCall, fetchPaginatedResults, fetchTxList } from './helpers';

const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

let fetchKoios: typeof import('./helpers').fetchKoios;
beforeEach(() => {
    // A fresh process-lifetime transport per test; never clear a live provider hold.
    jest.isolateModules(() => { fetchKoios = jest.requireActual('./helpers').fetchKoios; });
});

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
        const fetchMock = jest.fn().mockResolvedValue(jsonResponse({}));
        global.fetch = fetchMock as any;

        await blockfrostApiCall('blocks/latest');

        expect(fetchMock).toHaveBeenCalledWith(
            `https://cardano-${NETWORK.toLowerCase()}.blockfrost.io/api/v0/blocks/latest`,
            {
                headers: {
                    project_id: 'test-key',
                    'Content-Type': 'application/json'
                },
                redirect: 'manual',
                signal: expect.anything()
            }
        );
    });

    it('fetchPaginatedResults should return empty list on 404', async () => {
        const fetchMock = jest.fn().mockResolvedValue(jsonResponse([], 404));
        global.fetch = fetchMock as any;

        const results = await fetchPaginatedResults<string>('blocks/latest/next');

        expect(results).toEqual([]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('fetchPaginatedResults should retry then throw on persistent non-success status', async () => {
        const pageItems = new Array(100).fill(null).map((_, index) => `${index}`);
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce(jsonResponse(pageItems))
            .mockImplementation(async () => new Response('upstream unavailable', { status: 500 }));
        global.fetch = fetchMock as any;

        await expect(fetchPaginatedResults<string>('blocks/latest/next')).rejects.toThrow(
            'Blockfrost 500 for blocks/latest/next (page 2) after 5 retries: upstream unavailable'
        );

        expect(fetchMock).toHaveBeenCalledTimes(7);
    }, 10_000);

    it('fetchPaginatedResults should stop when maxResults is reached', async () => {
        const pageOne = new Array(100).fill(null).map((_, index) => `page1-${index}`);
        const pageTwo = new Array(100).fill(null).map((_, index) => `page2-${index}`);
        const fetchMock = jest
            .fn()
            .mockResolvedValueOnce(jsonResponse(pageOne))
            .mockResolvedValueOnce(jsonResponse(pageTwo));
        global.fetch = fetchMock as any;

        const results = await fetchPaginatedResults<string>('blocks/latest/next', 120);

        expect(results).toHaveLength(120);
        expect(results[0]).toBe('page1-0');
        expect(results[119]).toBe('page2-19');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('fetchPaginatedResults should log and rethrow on thrown error', async () => {
        const fetchMock = jest.fn().mockRejectedValue(new Error('network unavailable'));
        global.fetch = fetchMock as any;
        const logSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());

        await expect(fetchPaginatedResults<string>('blocks/latest/next')).rejects.toThrow('network unavailable');

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
            headers: new Headers(),
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

    it('fetchKoios should omit Authorization header when no token is configured', async () => {
        const koiosResponse = [{ tx_hash: 'abc' }];
        const fetchMock = jest.fn().mockResolvedValue({
            ok: true,
            headers: new Headers(),
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
            headers: new Headers(),
            text: async () => '<html><body><h1>429 Too Many Requests</h1></body></html>'
        });
        global.fetch = fetchMock as any;
        process.env.KOIOS_API_BEARER_TOKEN = 'koios-token';

        await expect(fetchKoios('tx_info', 'POST', '{"_tx_hashes":["abc"]}')).rejects.toMatchObject({
            status: 429,
            statusText: 'Too Many Requests'
        });
    });

    it('fetchKoios carries the Retry-After wait and binds the next caller', async () => {
        // Invariant: the diagnostic wait also protects a later caller. Removing registration admits it early.
        jest.useFakeTimers({ now: 1_000_000 });
        try {
            global.fetch = jest.fn().mockResolvedValue({
                ok: false, status: 429, statusText: 'Too Many Requests',
                headers: new Headers({ 'Retry-After': '7' }), text: async () => ''
            }) as any;
            await expect(fetchKoios('tx_info', 'POST', '{}')).rejects.toMatchObject({ status: 429, retryAfterMs: 7000 });
            const nextFetch = jest.fn().mockResolvedValue({
                ok: false, status: 503, statusText: 'Service Unavailable', headers: new Headers(), text: async () => ''
            });
            global.fetch = nextFetch as any;
            const next = fetchKoios('tx_info', 'POST', '{}').catch((error: unknown) => error);
            await jest.advanceTimersByTimeAsync(6999);
            expect(nextFetch).not.toHaveBeenCalled();
            await jest.advanceTimersByTimeAsync(1);
            expect(await next).not.toHaveProperty('retryAfterMs');
            expect(nextFetch).toHaveBeenCalledTimes(1);
        } finally {
            jest.useRealTimers();
        }
    });

    it.each([
        ['HTTP date', 'Wed, 01 Jan 2031 00:00:07 GMT', 7000],
        ['past HTTP date', 'Tue, 31 Dec 2030 23:59:59 GMT', 0],
        ['zero seconds', '0', 0]
    ])('fetchKoios carries Retry-After %s without retrying itself', async (_name, header, expected) => {
        // Invariant: numeric/date provider signals reach the shared request gate unchanged.
        // Removing HTTP-date parsing makes the future-date case fail; past dates must not become negative waits.
        const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2031-01-01T00:00:00Z'));
        const fetch = jest.fn().mockResolvedValue({
            ok: false, status: 429, statusText: 'Too Many Requests',
            headers: new Headers({ 'Retry-After': header }), text: async () => ''
        });
        global.fetch = fetch as any;
        try {
            await expect(fetchKoios('tx_info', 'POST', '{}')).rejects.toMatchObject({ status: 429, retryAfterMs: expected });
            expect(fetch).toHaveBeenCalledTimes(1);
        } finally {
            clock.mockRestore();
        }
    });

    it('fetchTxList should compose blockfrost pagination and koios request', async () => {
        const txHashes = ['tx-hash-1'];
        const txInfoResponse = [{ tx_hash: 'tx-hash-1', outputs: [], assets_minted: [] }];
        const fetchMock = jest.fn().mockImplementation(async (url: string) => {
            if (url.includes('blockfrost.io')) {
                return jsonResponse(txHashes);
            }

            return {
                ok: true,
                headers: new Headers(),
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
