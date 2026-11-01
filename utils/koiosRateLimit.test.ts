import type { fetchKoios as FetchKoios } from './helpers';

const freshCaller = (): typeof FetchKoios => {
    let caller: typeof FetchKoios;
    jest.isolateModules(() => { caller = require('./helpers').fetchKoios; });
    return caller!;
};

const epoch = 1_000_000;
const originalFetch = global.fetch;

beforeEach(() => { jest.useFakeTimers({ now: epoch }); });
afterEach(() => { global.fetch = originalFetch; jest.useRealTimers(); jest.restoreAllMocks(); });

// Invariant: every announced provider wait binds a different helper caller/endpoint.
// Failure caught: missing/partial response registration admits the tip before the advertised time.
// Negative control: removing the providerNotBefore assignment makes these actual-start assertions fail.
it.each([
    ['fractional Retry-After', { 'Retry-After': '1.25' }, 1250, 429],
    ['HTTP-date Retry-After', { 'Retry-After': new Date(epoch + 5000).toUTCString() }, 5000, 429],
    ['exhausted success', { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': `${(epoch + 5000) / 1000}` }, 5000, 200],
    ['reset-after', { 'X-RateLimit-Reset-After': '2.5' }, 2500, 429],
    ['standard reset', { 'RateLimit-Remaining': '0', 'RateLimit-Reset': '3' }, 3000, 200],
    ['maximum competing hints', { 'Retry-After': '1', 'X-RateLimit-Reset-After': '5' }, 5000, 429]
])('%s binds later callers', async (_name, headers, wait, status) => {
    const caller = freshCaller();
    const starts: number[] = [];
    global.fetch = jest.fn(async () => {
        starts.push(Date.now());
        return starts.length === 1 ? new Response('[]', { status, headers: headers as HeadersInit })
            : new Response('[{"provider":"tip"}]', { status: 200 });
    });
    const first = await caller('tx_info').catch((error: unknown) => error);
    if (status === 200) expect(first).toEqual([]);
    else expect(first).toMatchObject({ status: 429, retryAfterMs: wait });
    const pending = caller('tip');
    await jest.advanceTimersByTimeAsync(wait - 1);
    expect(starts).toEqual([epoch]);
    await jest.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual([{ provider: 'tip' }]);
    expect(starts).toEqual([epoch, epoch + wait]);
});

// Invariant: a known header hold protects other callers while the response body is still unread.
// Failure caught: moving header observation after await response.text admits the second call at epoch.
// Negative control: the same providerNotBefore removal permits that early dispatch.
it('registers headers before a slow body, and extends from a later body signal', async () => {
    const caller = freshCaller();
    let finishBody!: (body: string) => void;
    const body = new Promise<string>((resolve) => { finishBody = resolve; });
    const response = new Response('', { status: 429, headers: { 'Retry-After': '5' } });
    jest.spyOn(response, 'text').mockImplementation(() => body);
    const starts: number[] = [];
    global.fetch = jest.fn(async () => {
        starts.push(Date.now());
        return starts.length === 1 ? response : new Response('[{"provider":"tip"}]');
    });
    const first = caller('tx_info').catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(0);
    const second = caller('tip');
    await jest.advanceTimersByTimeAsync(2000);
    expect(starts).toEqual([epoch]);
    finishBody('{"retry_after":8}');
    await jest.advanceTimersByTimeAsync(0);
    expect(await first).toMatchObject({ status: 429, retryAfterMs: 8000 });
    await jest.advanceTimersByTimeAsync(7999);
    expect(starts).toEqual([epoch]);
    await jest.advanceTimersByTimeAsync(1);
    expect(await second).toEqual([{ provider: 'tip' }]);
    expect(starts).toEqual([epoch, epoch + 10_000]);
});

// Invariant: error-body waits survive the throwing caller, including structured RetryInfo.
// Failure caught: body parsing only exports metadata instead of changing shared admission state.
// Negative control: removing body registration admits the asset caller before its stated wait.
it.each([
    ['retry_after', { retry_after: 2.25 }, 2250],
    ['RetryInfo string', { error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3.5s' }] } }, 3500],
    ['RetryInfo duration', { error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: { seconds: '2', nanos: 500000000 } }] } }, 2500]
])('%s binds callers after an error', async (_name, payload, wait) => {
    const caller = freshCaller();
    const starts: number[] = [];
    global.fetch = jest.fn(async () => {
        starts.push(Date.now());
        return starts.length === 1 ? new Response(JSON.stringify(payload), { status: 429 })
            : new Response('[{"asset":"present"}]');
    });
    await expect(caller('tip')).rejects.toMatchObject({ status: 429, retryAfterMs: wait });
    const pending = caller('asset_utxos');
    await jest.advanceTimersByTimeAsync(wait - 1);
    expect(starts).toEqual([epoch]);
    await jest.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual([{ asset: 'present' }]);
    expect(starts).toEqual([epoch, epoch + wait]);
});

// Invariant: zero/past/invalid waits do not invent a future hold, and valid data is preserved.
// Failure caught: a past reset or malformed value becomes an arbitrary new retry interval.
// Negative control: assigning a nonzero fallback hold prevents the immediate second output.
it.each(['0', new Date(epoch - 1000).toUTCString(), 'not-a-wait'])('does not invent a hold for %s', async (header) => {
    const caller = freshCaller();
    const starts: number[] = [];
    global.fetch = jest.fn(async () => {
        starts.push(Date.now());
        return new Response('[{"present":true}]', { headers: { 'Retry-After': header } });
    });
    expect(await caller('tip')).toEqual([{ present: true }]);
    expect(await caller('asset_utxos')).toEqual([{ present: true }]);
    expect(starts).toEqual([epoch, epoch]);
});

// Invariant: deadline checks run again after every provider/pacing wake at the actual HTTP start.
// Failure caught: checking before sleep only dispatches an already-expired request.
// Negative control: removing beforeStart from requestKoios admits exact/beyond-deadline calls.
it.each([[719000, true], [720000, false], [720001, false]])('actual-start deadline after %dms', async (wait, permitted) => {
    const caller = freshCaller();
    const starts: number[] = [];
    global.fetch = jest.fn(async () => {
        starts.push(Date.now());
        return starts.length === 1 ? new Response('', { status: 429, headers: { 'Retry-After': `${wait / 1000}` } })
            : new Response('[{"provider":"tip"}]');
    });
    await expect(caller('tx_info')).rejects.toMatchObject({ status: 429 });
    const pending = caller('tip', 'GET', undefined, { beforeStart: () => {
        if (Date.now() >= epoch + 720000) throw new Error('actual-start deadline');
    } }).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(725000);
    const result = await pending;
    if (permitted) {
        expect(result).toEqual([{ provider: 'tip' }]);
        expect(starts).toEqual([epoch, epoch + wait]);
    } else {
        expect(result).toMatchObject({ message: 'actual-start deadline' });
        expect(starts).toEqual([epoch]);
    }
});

// Invariant: a response already in flight can extend the hold of a sleeping caller.
// Failure caught: one-time sleeps or replacing the maximum deadline start the queued call at 5s.
// Negative control: removing the wake recheck makes the exact start-time assertion fail.
it('rechecks a longer hold received from another in-flight response', async () => {
    const caller = freshCaller();
    const starts: number[] = [];
    const replies: ((response: Response) => void)[] = [];
    global.fetch = jest.fn(() => {
        starts.push(Date.now());
        if (starts.length <= 2) return new Promise<Response>((resolve) => { replies.push(resolve); });
        return Promise.resolve(new Response('[{"provider":"tip"}]'));
    });
    const first = caller('tx_info').catch((error: unknown) => error);
    const inFlight = caller('asset_utxos');
    replies[0](new Response('', { status: 429, headers: { 'Retry-After': '5' } }));
    await jest.advanceTimersByTimeAsync(0);
    expect(await first).toMatchObject({ status: 429, retryAfterMs: 5000 });
    const queued = caller('tip');
    await jest.advanceTimersByTimeAsync(2000);
    replies[1](new Response('[]', { headers: { 'X-RateLimit-Reset-After': '8' } }));
    await jest.advanceTimersByTimeAsync(0);
    expect(await inFlight).toEqual([]);
    await jest.advanceTimersByTimeAsync(7999);
    expect(starts).toEqual([epoch, epoch]);
    await jest.advanceTimersByTimeAsync(1);
    expect(await queued).toEqual([{ provider: 'tip' }]);
    expect(starts).toEqual([epoch, epoch, epoch + 10_000]);
});

// Invariant: the deadline still applies when pacing, rather than a provider hold, delays admission.
// Failure caught: checking only the pre-sleep clock admits at the exact expired boundary.
// Negative control: removing beforeStart admits the second fetch instead of the deadline error.
it('checks actual-start deadline after a pacing wake', async () => {
    const caller = freshCaller();
    const starts: number[] = [];
    global.fetch = jest.fn(async () => { starts.push(Date.now()); return new Response('[{"provider":"tip"}]'); });
    expect(await caller('tip', 'GET', undefined, { minIntervalMs: 1000 })).toEqual([{ provider: 'tip' }]);
    const pending = caller('tx_info', 'POST', '{}', { beforeStart: () => {
        if (Date.now() >= epoch + 1000) throw new Error('pacing actual-start deadline');
    } }).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(1000);
    expect(await pending).toMatchObject({ message: 'pacing actual-start deadline' });
    expect(starts).toEqual([epoch]);
});
