import type * as Helpers from './helpers';

const originalFetch = global.fetch;
let helpers: typeof Helpers;
const epoch = 1_000_000;
const deadlineError = () => Object.assign(new Error('scanner work deadline'), { code: 'REQUEST_DEADLINE_EXCEEDED' });
const admission = (deadline = epoch + 240_000) => ({ beforeStart: (earliest = Date.now()) => { if (earliest >= deadline) throw deadlineError(); } });
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });

beforeEach(() => {
    jest.replaceProperty(process, 'env', { ...process.env, BLOCKFROST_API_KEY: 'fixture-key', KOIOS_API_BEARER_TOKEN: 'fixture-token' });
    jest.useFakeTimers({ now: epoch });
    jest.isolateModules(() => { helpers = require('./helpers'); });
});
afterEach(() => { global.fetch = originalFetch; jest.clearAllTimers(); jest.useRealTimers(); jest.restoreAllMocks(); });

// Invariant: a known hold that cannot fit exits now, retaining its floor for another invocation.
// Failure: the current helper waits an hour and Fn kills the call before cleanup.
// Negative control: omit the proposed-start argument; immediate rejection below becomes absent.
it('rejects an unadmittable Koios hold now without shortening the provider floor', async () => {
    const starts: number[] = [];
    global.fetch = jest.fn(async () => { starts.push(Date.now()); return response(starts.length === 1 ? [] : ['tip'], 200, starts.length === 1 ? { 'Retry-After': '3600' } : {}); });
    expect(await helpers.fetchKoios('tip')).toEqual([]);
    const results: unknown[] = [];
    helpers.fetchKoios('tx_info', 'POST', '{}', admission()).catch(error => { results.push(error.code); });
    await jest.advanceTimersByTimeAsync(0);
    expect(results).toEqual(['REQUEST_DEADLINE_EXCEEDED']);
    expect(starts).toEqual([epoch]);
    const later = helpers.fetchKoios('tip');
    await jest.advanceTimersByTimeAsync(3_599_999);
    expect(starts).toEqual([epoch]);
    await jest.advanceTimersByTimeAsync(1);
    expect(await later).toEqual(['tip']);
    expect(starts).toEqual([epoch, epoch + 3_600_000]);
});

// Invariant: the identical deadline applies to actual Blockfrost starts and local pacing waits.
// Failure: helper fallbacks start fresh HTTP after the scanner work budget was exhausted.
// Negative control: dropping admission forwarding makes these resolve and record a request.
it.each(['pagination', 'hashes', 'transaction', 'datum', 'raw'] as const)('propagates expired admission through %s', async kind => {
    global.fetch = jest.fn(async () => response([]));
    const budget = admission(epoch);
    const pending = kind === 'pagination' ? helpers.fetchPaginatedResults('blocks/hash/txs', 100, budget)
        : kind === 'hashes' ? helpers.fetchBlockfrostTxHashes(['block'], budget)
        : kind === 'transaction' ? helpers.fetchBlockfrostTxInfo('tx', budget)
        : kind === 'datum' ? helpers.fetchBlockfrostDatumCbor('datum', budget)
        : helpers.blockfrostApiCall('tip', budget);
    const caught = pending.catch((error: { code: string }) => error.code);
    await jest.advanceTimersByTimeAsync(1000);
    expect(await caught).toBe('REQUEST_DEADLINE_EXCEEDED');
    expect(global.fetch).not.toHaveBeenCalled();
});

// Invariant: all Blockfrost callers share the maximum response header/body wait.
// Failure: fixed local 200ms retry ignores 429 Retry-After and another endpoint starts early.
// Negative control: original code dispatches the next caller and retry well before 8 seconds.
it('registers Blockfrost waits across raw and pagination callers while preserving Response', async () => {
    const starts: number[] = [];
    global.fetch = jest.fn(async () => { starts.push(Date.now()); return starts.length === 1 ? response({ retry_after: 8 }, 429, { 'Retry-After': '5' }) : response(['tx']); });
    const raw = await helpers.blockfrostApiCall('tip');
    expect(raw.status).toBe(429);
    expect(await raw.json()).toEqual({ retry_after: 8 });
    const pending = helpers.fetchPaginatedResults<string>('blocks/hash/txs');
    await jest.advanceTimersByTimeAsync(7999);
    expect(starts).toEqual([epoch]);
    await jest.advanceTimersByTimeAsync(101);
    expect(await pending).toEqual(['tx']);
    expect(starts).toEqual([epoch, epoch + 8000]);
});

// Invariant: a long retry hold is rejected immediately as a budget signal, not retried early.
// Failure: pagination sleeps its generic backoff then starts another request inside the hold.
it('bounds a pagination retry by proposed start and preserves the hold', async () => {
    const starts: number[] = [];
    global.fetch = jest.fn(async () => { starts.push(Date.now()); return response({ retry_after: 3600 }, 503); });
    const results: unknown[] = [];
    helpers.fetchPaginatedResults('blocks/hash/txs', 100, admission()).catch((error: { code: string }) => { results.push(error.code); });
    await jest.advanceTimersByTimeAsync(0);
    expect(results).toEqual(['REQUEST_DEADLINE_EXCEEDED']);
    expect(starts).toEqual([epoch]);
});

const txFixture = (url: string, scriptStatus = 200, metadataStatus = 200) => {
    if (url.includes('/utxos')) return response({ inputs: [], outputs: [{ output_index: 0, address: 'addr-fixture', amount: [{ unit: 'lovelace', quantity: '1' }], reference_script_hash: 'script' }] });
    if (url.includes('/txs/') && url.includes('/metadata')) return response([], metadataStatus);
    if (url.includes('/txs/')) return response({ block: 'block', slot: 10, block_height: 1, asset_mint_or_burn_count: 1 });
    if (url.endsWith('/cbor')) return response({ cbor: 'abcd' });
    return response(scriptStatus === 200 ? { type: 'plutusV3' } : { error: 'metadata unavailable' }, scriptStatus);
};

// Invariant: language metadata is required; V3 must never become an invented V2 on failed reads.
// Failure: scriptMeta.catch({}) followed by type??plutusV2 silently misidentifies the validator.
// Negative control: restoring that catch resolves instead of rejecting the 503 case.
it('preserves actual V3 language and rejects unavailable script metadata', async () => {
    global.fetch = jest.fn(async input => txFixture(String(input)));
    const pending = helpers.fetchBlockfrostTxInfo('tx');
    await jest.advanceTimersByTimeAsync(10_000);
    expect((await pending).outputs[0].reference_script).toEqual({ bytes: 'abcd', type: 'plutusV3' });
    global.fetch = jest.fn(async input => txFixture(String(input), 503));
    const failed = helpers.fetchBlockfrostTxInfo('tx').catch(error => error);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(await failed).toMatchObject({ status: 503 });
});

// Invariant: reaching the budget during metadata collection cannot turn into partial success.
// Failure: the broad tx metadata catch logs and returns a stripped transaction on budget errors.
it('does not swallow the deadline raised before transaction metadata HTTP', async () => {
    let metadataRequested = false;
    global.fetch = jest.fn(async input => {
        const url = String(input);
        if (url.endsWith('/scripts/script')) jest.setSystemTime(epoch + 240_000);
        if (url.includes('/metadata')) metadataRequested = true;
        return txFixture(url);
    });
    const caught = helpers.fetchBlockfrostTxInfo('tx', admission()).catch((error: unknown) => error);
    await jest.advanceTimersByTimeAsync(1000);
    expect(await caught).toMatchObject({ code: 'REQUEST_DEADLINE_EXCEEDED' });
    expect(metadataRequested).toBe(false);
});

// Invariant: a proposed pacing slot beyond the work budget never waits or starts a script read.
// Failure: checking Date.now alone lets the next 110ms fallback slot cross the deadline.
it('rejects a future script-metadata pacing slot and preserves the budget signal', async () => {
    const paths: string[] = [];
    global.fetch = jest.fn(async input => { paths.push(new URL(String(input)).pathname); return txFixture(String(input)); });
    const caught = helpers.fetchBlockfrostTxInfo('tx', admission(epoch + 250)).catch(error => error);
    await jest.advanceTimersByTimeAsync(1000);
    expect(await caught).toMatchObject({ code: 'REQUEST_DEADLINE_EXCEEDED' });
    expect(paths).toEqual(['/api/v0/txs/tx', '/api/v0/txs/tx/utxos', '/api/v0/scripts/script/cbor']);
});

// Invariant: mint metadata read failures halt instead of persisting empty successful data.
// Failure: a non-404 metadata failure is swallowed by the broad transaction catch.
it('propagates non-404 transaction metadata errors', async () => {
    global.fetch = jest.fn(async input => txFixture(String(input), 200, 503));
    const caught = helpers.fetchBlockfrostTxInfo('tx').catch(error => error);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(await caught).toMatchObject({ status: 503 });
});

// Invariant: known script bytes require actual language, even on malformed success or metadata 404.
// Failure: returning invented V2 or null script on a failed language lookup corrupts script identity.
it.each(['missing', '404'])('refuses %s language metadata when CBOR exists', async mode => {
    global.fetch = jest.fn(async input => String(input).endsWith('/scripts/script') ? response({}, mode === '404' ? 404 : 200) : txFixture(String(input)));
    const caught = helpers.fetchBlockfrostTxInfo('tx').catch(error => error);
    await jest.advanceTimersByTimeAsync(1000);
    if (mode === '404') expect(await caught).toMatchObject({ status: 404 });
    else expect(await caught).toMatchObject({ message: expect.stringContaining('missing language metadata') });
});

// Invariant: an actual absent CBOR remains distinct from unreadable language for known bytes.
// Failure: treating all 404s as fatal changes the legitimate no-script result.
it('keeps a real CBOR 404 as absent without requesting or inventing language', async () => {
    const paths: string[] = [];
    global.fetch = jest.fn(async input => {
        const url = String(input); paths.push(new URL(url).pathname);
        return url.endsWith('/scripts/script/cbor') ? response({}, 404) : txFixture(url);
    });
    const pending = helpers.fetchBlockfrostTxInfo('tx');
    await jest.advanceTimersByTimeAsync(1000);
    expect((await pending).outputs[0].reference_script).toBeNull();
    expect(paths.includes('/api/v0/scripts/script')).toBe(false);
});

// Invariant: cross-bundle budget signals are never confused with legitimate HTTP absence.
// Failure: a status-only 404 catch returns null for a typed deadline raised by admission.
it('preserves a foreign deadline object even when it also carries status 404', async () => {
    const { RequestDeadlineError } = require('./requestDeadline') as typeof import('./requestDeadline');
    const error = Object.assign(new RequestDeadlineError('actual budget boundary'), { status: 404 });
    global.fetch = jest.fn(async () => response({ cbor: 'not-requested' }));
    await expect(helpers.fetchBlockfrostDatumCbor('hash', { beforeStart: () => { throw error; } })).rejects.toBe(error);
    expect(global.fetch).not.toHaveBeenCalled();
});
