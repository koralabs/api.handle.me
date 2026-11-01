import type { fetchKoios as FetchKoios } from './helpers';

const freshCaller = (): typeof FetchKoios => {
    let caller!: typeof FetchKoios;
    jest.isolateModules(() => { caller = require('./helpers').fetchKoios; });
    return caller;
};
const epoch = 1_000_000;
const originalFetch = global.fetch;
beforeEach(() => { jest.useFakeTimers({ now: epoch }); });
afterEach(() => { global.fetch = originalFetch; jest.useRealTimers(); jest.restoreAllMocks(); });

// Invariant: negative reset numbers remain invalid numbers, not invented future calendar dates.
// Failure caught: resetDelay delegates a rejected number to permissive date parsing.
// Negative control: restoring the original numeric/date fall-through withholds the second dispatch.
it.each([
    ['RateLimit-Reset', '-1'], ['RateLimit-Reset', '-2060'],
    ['X-RateLimit-Reset', '-1'], ['X-RateLimit-Reset', '-2060']
])('rejects invalid %s numeric value %s without fabricating a hold', async (name, value) => {
    const caller = freshCaller();
    const starts: number[] = [];
    global.fetch = jest.fn(async () => {
        starts.push(Date.now());
        return new Response('[{"present":true}]', { headers: { [name]: value, 'X-RateLimit-Remaining': '0' } });
    });
    expect(await caller('tip')).toEqual([{ present: true }]);
    const next = caller('asset_utxos');
    await jest.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([epoch, epoch]);
    expect(await next).toEqual([{ present: true }]);
});

// Invariant: invalid numeric signals cannot erase or extend a valid hold from another response.
// Failure caught: replacing the existing deadline with zero or parsing a negative as year 2060.
// Negative control: the original date fall-through prevents the third request at the real 5s boundary.
it('preserves a valid hold when an in-flight response contains a negative wait', async () => {
    const caller = freshCaller();
    const starts: number[] = [];
    let receive!: (response: Response) => void;
    const inFlightResponse = new Promise<Response>((resolve) => { receive = resolve; });
    global.fetch = jest.fn(() => {
        starts.push(Date.now());
        if (starts.length === 1) return inFlightResponse;
        return Promise.resolve(new Response('[{"present":true}]', { headers: starts.length === 2 ? { 'Retry-After': '5' } : {} }));
    });
    const inFlight = caller('asset_utxos');
    expect(await caller('tx_info')).toEqual([{ present: true }]);
    receive(new Response('[]', { headers: { 'Retry-After': '-2060', 'RateLimit-Reset': '-1' } }));
    await Promise.resolve();
    expect(await inFlight).toEqual([]);
    const queued = caller('tip');
    await jest.advanceTimersByTimeAsync(4999);
    expect(starts).toEqual([epoch, epoch]);
    await jest.advanceTimersByTimeAsync(1);
    expect(starts).toEqual([epoch, epoch, epoch + 5000]);
    expect(await queued).toEqual([{ present: true }]);
});
