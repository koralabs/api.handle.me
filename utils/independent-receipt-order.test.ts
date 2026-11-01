import type { fetchKoios as FetchKoios } from './helpers';

it.each(['already settled', 'in-flight settled'])('independent review: %s HTTP response headers bind the next microtask caller', async (mode) => {
    // Invariant: a settled transport response must establish its known header hold before a later caller is admitted.
    // Failure: an async admission wrapper adds promise-adoption turns before the helper observes received headers.
    // Negative control: delaying header registration until after response body/outer adoption admits at the epoch.
    jest.useFakeTimers({ now: 1_000_000 });
    const originalFetch = global.fetch;
    let caller!: typeof FetchKoios;
    jest.isolateModules(() => { caller = require('./helpers').fetchKoios; });
    const starts: number[] = [];
    const limited = new Response('[]', { status: 429, headers: { 'Retry-After': '5' } });
    let receive!: (response: Response) => void;
    const inFlight = new Promise<Response>((resolve) => { receive = resolve; });
    global.fetch = jest.fn(() => {
        starts.push(Date.now());
        if (starts.length === 1) return mode === 'already settled' ? Promise.resolve(limited) : inFlight;
        return Promise.resolve(new Response('[{"provider":"tip"}]'));
    });
    try {
        const first = caller('tx_info').catch((error: unknown) => error);
        if (mode === 'in-flight settled') {
            await Promise.resolve(); // Install the admission wrapper's adoption of the live fetch promise.
            receive(limited); // The HTTP boundary receives the headers; no body read is needed.
        }
        await Promise.resolve();
        const next = caller('tip');
        await jest.advanceTimersByTimeAsync(0);
        expect(await first).toMatchObject({ status: 429, retryAfterMs: 5000 });
        expect(starts).toEqual([1_000_000]);
        await jest.advanceTimersByTimeAsync(4999);
        expect(starts).toEqual([1_000_000]);
        await jest.advanceTimersByTimeAsync(1);
        expect(await next).toEqual([{ provider: 'tip' }]);
        expect(starts).toEqual([1_000_000, 1_005_000]);
    } finally {
        global.fetch = originalFetch;
        jest.useRealTimers();
        jest.restoreAllMocks();
    }
});
