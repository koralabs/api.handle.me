import type { fetchKoios as FetchKoios } from './helpers';

it.each(['-1', '-2060'])('independent review: invalid negative Retry-After %s cannot become a future date', async (header) => {
    // Invariant: an invalid negative duration must not create a fabricated future provider deadline.
    // Failure: Number rejects it as seconds but permissive Date.parse reads its digits as a positive year.
    // Negative control: retaining the date-parser fallback for finite-negative numbers withholds the second fetch.
    jest.useFakeTimers({ now: 1_000_000 });
    const originalFetch = global.fetch;
    let caller!: typeof FetchKoios;
    jest.isolateModules(() => { caller = require('./helpers').fetchKoios; });
    const starts: number[] = [];
    global.fetch = jest.fn(async () => {
        starts.push(Date.now());
        return new Response('[{"present":true}]', {headers: {'Retry-After':header}});
    });
    try {
        expect(await caller('tip')).toEqual([{present:true}]);
        const next = caller('asset_utxos');
        await jest.advanceTimersByTimeAsync(0);
        expect(starts).toEqual([1_000_000, 1_000_000]);
        expect(await next).toEqual([{present:true}]);
    } finally {
        global.fetch = originalFetch;
        jest.useRealTimers();
        jest.restoreAllMocks();
    }
});
