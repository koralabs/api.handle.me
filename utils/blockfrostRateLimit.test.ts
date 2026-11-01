import type * as Helpers from './helpers';

let helpers: typeof Helpers;
const originalFetch = global.fetch;
const epoch = 1_000_000;
const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
beforeEach(() => {
    jest.replaceProperty(process, 'env', { ...process.env, BLOCKFROST_API_KEY: 'fixture-key', KOIOS_API_BEARER_TOKEN: 'fixture-token' });
    jest.useFakeTimers({ now: epoch });
    jest.isolateModules(() => { helpers = require('./helpers'); });
});
afterEach(() => { global.fetch = originalFetch; jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });

// Invariant: every announced header/body wait binds a different Blockfrost caller.
// Failure: raw calls/pagination/fallbacks had different state or ignored success/exhaustion signals.
// Negative control: removing registration admits the second actual fetch at the epoch.
it.each([
    ['fractional', 429, { 'Retry-After': '1.25' }, {}, 1250],
    ['HTTP date', 429, { 'Retry-After': new Date(epoch + 5000).toUTCString() }, {}, 5000],
    ['success exhausted', 200, { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': `${(epoch + 5000) / 1000}` }, [], 5000],
    ['reset-after', 503, { 'X-RateLimit-Reset-After': '2.5' }, {}, 2500],
    ['standard reset', 200, { 'RateLimit-Remaining': '0', 'RateLimit-Reset': '3' }, [], 3000],
    ['maximum competing', 429, { 'Retry-After': '1', 'X-RateLimit-Reset-After': '5' }, { retry_after: 8 }, 8000],
    ['RetryInfo duration', 429, {}, { error: { details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: { seconds: '2', nanos: 500000000 } }] } }, 2500]
])('%s holds another endpoint without consuming Response', async (_label, status, headers, body, wait) => {
    const starts: number[] = [];
    const first = reply(body, status as number, headers as Record<string, string>);
    global.fetch = jest.fn(async () => { starts.push(Date.now()); return starts.length === 1 ? first : reply({ cbor: 'd87980' }); });
    expect(await helpers.blockfrostApiCall('tip')).toBe(first);
    expect(first.bodyUsed).toBe(false);
    expect(await first.json()).toEqual(body);
    const pending = helpers.fetchBlockfrostDatumCbor('hash');
    await jest.advanceTimersByTimeAsync((wait as number) - 1);
    expect(starts).toEqual([epoch]);
    await jest.advanceTimersByTimeAsync(1);
    expect(await pending).toBe('d87980');
    expect(starts).toEqual([epoch, epoch + (wait as number)]);
});

// Invariant: direct transport-receipt registration protects the next microtask caller.
// Failure: waiting for the async wrapper/body before registering permits an early second start.
it('registers response headers before outer promise adoption', async () => {
    const starts: number[] = [];
    global.fetch = jest.fn(() => { starts.push(Date.now()); return Promise.resolve(reply([], starts.length === 1 ? 429 : 200, starts.length === 1 ? { 'Retry-After': '5' } : {})); });
    const first = helpers.blockfrostApiCall('tip');
    await Promise.resolve();
    const next = helpers.blockfrostApiCall('another');
    await jest.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([epoch]);
    expect((await first).status).toBe(429);
    await jest.advanceTimersByTimeAsync(5000);
    expect((await next).status).toBe(200);
    expect(starts).toEqual([epoch, epoch + 5000]);
});

// Invariant: a slow error body can extend an already registered header hold.
// Failure: later body retry_after is not registered or replaces a longer existing hold.
it('extends the hold when an in-flight response body arrives later', async () => {
    let finish!: () => void;
    const stream = new ReadableStream({ start(controller) { finish = () => { controller.enqueue(new TextEncoder().encode('{"retry_after":8}')); controller.close(); }; } });
    const firstResponse = new Response(stream, { status: 429, headers: { 'Retry-After': '5' } });
    const starts: number[] = [];
    global.fetch = jest.fn(async () => { starts.push(Date.now()); return starts.length === 1 ? firstResponse : reply(['tip']); });
    const first = helpers.blockfrostApiCall('tip');
    await jest.advanceTimersByTimeAsync(0);
    const next = helpers.blockfrostApiCall('another');
    await jest.advanceTimersByTimeAsync(2000);
    finish();
    await jest.advanceTimersByTimeAsync(0);
    expect(await (await first).json()).toEqual({ retry_after: 8 });
    await jest.advanceTimersByTimeAsync(7999);
    expect(starts).toEqual([epoch]);
    await jest.advanceTimersByTimeAsync(1);
    expect(await (await next).json()).toEqual(['tip']);
    expect(starts).toEqual([epoch, epoch + 10_000]);
});

// Invariant: the final response establishes a provider hold even when no local retry remains.
// Failure: recording the hold only inside the retry branch loses terminal-error waits.
it('retains a final pagination retry hold for the next unrelated caller', async () => {
    const starts: number[] = [];
    global.fetch = jest.fn(async () => {
        starts.push(Date.now());
        if (starts.length < 6) return reply({}, 503);
        if (starts.length === 6) return reply({ retry_after: 8 }, 429, { 'Retry-After': '5' });
        return reply(['tip']);
    });
    const failed = helpers.fetchPaginatedResults('blocks/hash/txs').catch(error => error);
    await jest.advanceTimersByTimeAsync(6000);
    expect(await failed).toMatchObject({ message: expect.stringContaining('after 5 retries') });
    expect(starts).toHaveLength(6);
    const floor = starts[5] + 8000;
    const next = helpers.blockfrostApiCall('tip');
    await jest.advanceTimersByTimeAsync(floor - Date.now() - 1);
    expect(starts).toHaveLength(6);
    await jest.advanceTimersByTimeAsync(1);
    expect(await (await next).json()).toEqual(['tip']);
    expect(starts[6]).toBe(floor);
});

// Invariant: separate provider accounts do not block each other, while retaining their own hold.
// Failure: copying a single global provider deadline into both transports wedges unrelated traffic.
it('keeps Koios and Blockfrost provider states separate', async () => {
    const starts: { provider: string; at: number }[] = [];
    global.fetch = jest.fn(async url => {
        const provider = String(url).includes('koios.rest') ? 'koios' : 'blockfrost';
        starts.push({ provider, at: Date.now() });
        return reply([provider], 200, starts.length === 1 ? { 'Retry-After': '5' } : {});
    });
    expect(await helpers.fetchKoios('tip')).toEqual(['koios']);
    expect(await (await helpers.blockfrostApiCall('tip')).json()).toEqual(['blockfrost']);
    const held = helpers.fetchKoios('tip');
    await jest.advanceTimersByTimeAsync(4999);
    expect(starts).toEqual([{ provider: 'koios', at: epoch }, { provider: 'blockfrost', at: epoch }]);
    await jest.advanceTimersByTimeAsync(1);
    expect(await held).toEqual(['koios']);
    expect(starts[2]).toEqual({ provider: 'koios', at: epoch + 5000 });
});
