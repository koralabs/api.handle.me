import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const epoch = 1_800_000_000_000;
const originalFetch = global.fetch;
const originalArgv = process.argv;
const originalNetwork = process.env.NETWORK;
const originalApi = process.env.API_BASE;
let dir: string;
let output: string;

beforeEach(() => {
    jest.useFakeTimers({ now: epoch });
    dir = mkdtempSync('/tmp/handle-audit-test-');
    output = join(dir, 'report.json');
    process.env.NETWORK = 'mainnet';
    process.env.API_BASE = 'https://audit.example';
    process.argv = ['node', 'audit', '--output', output];
    jest.resetModules();
});
afterEach(() => {
    global.fetch = originalFetch;
    process.argv = originalArgv;
    if (originalNetwork === undefined) delete process.env.NETWORK; else process.env.NETWORK = originalNetwork;
    if (originalApi === undefined) delete process.env.API_BASE; else process.env.API_BASE = originalApi;
    jest.clearAllTimers();
    jest.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
});

const handle = (n: number) => ({ name: `h${n}`, policy: 'policy', hex: n.toString(16).padStart(2, '0'), utxo: 'old#0' });
const rows = (start: number, end: number) => Array.from({ length: end - start }, (_, n) => ({
    tx_hash: n + start === 0 ? 'new' : 'old', tx_index: 0,
    asset_list: [{ policy_id: 'policy', asset_name: (n + start).toString(16).padStart(2, '0'), quantity: '1' }]
}));
const saved = (suffix: string) => JSON.parse(readFileSync(output + suffix, 'utf8'));

// A stopped audit preserves the first batch's actual discrepancy and never rechecks that batch on resume.
// Dropping the progress write or restarting from zero fails the saved state and requested asset assertions.
it('preserves findings and resumes only unfinished batches after a transport failure', async () => {
    const handles = Array.from({ length: 21 }, (_, i) => handle(i));
    const requests: string[][] = [];
    global.fetch = jest.fn(async (url, init) => {
        if (String(url).includes('/handles?')) return new Response(JSON.stringify(String(url).includes('page=1&') ? handles : []));
        const assets = JSON.parse(String(init?.body))._asset_list.map((item: string[]) => item[1]);
        requests.push(assets);
        if (requests.length === 1) return new Response(JSON.stringify(rows(0, 20)));
        throw new Error('offline');
    });
    const { run } = await import('./handle-audit-runner');
    const first = run().catch((error: Error) => error);
    await jest.advanceTimersByTimeAsync(2000);
    expect(await first).toMatchObject({ message: 'offline' });
    expect(saved('.progress')).toMatchObject({ checked: 20, findings: [{ name: 'h0', stored: 'old#0', canonical: ['new#0'], status: 'mismatch' }] });
    process.argv.push('--resume');
    global.fetch = jest.fn(async (_url, init) => {
        requests.push(JSON.parse(String(init?.body))._asset_list.map((item: string[]) => item[1]));
        return new Response(JSON.stringify(rows(20, 21)));
    });
    const resumed = run();
    await jest.advanceTimersByTimeAsync(2000);
    await resumed;
    expect(requests.at(-1)).toEqual(['14']);
    expect(saved('')).toMatchObject({ checked: 21, findings: [{ name: 'h0', status: 'mismatch' }] });
});

// Checkpoints and progress from different enumerations must never be combined.
// Omitting the checkpoint identity check can silently skip unverified handles.
it('rejects progress belonging to a different enumeration', async () => {
    writeFileSync(output + '.checkpoint', JSON.stringify({ checkpointId: 'new', network: 'mainnet', api: 'https://audit.example', ended: true, handles: [handle(0)] }));
    writeFileSync(output + '.progress', JSON.stringify({ checkpointId: 'old', checked: 1, findings: [] }));
    process.argv.push('--resume');
    global.fetch = jest.fn();
    const { run } = await import('./handle-audit-runner');
    await expect(run()).rejects.toThrow('Invalid or mismatched audit checkpoint');
    expect(global.fetch).not.toHaveBeenCalled();
});

// A header-directed deadline survives a restart; no request may start before it.
// Ignoring either the 429 header or the persisted deadline makes the pre-deadline assertion fail.
it('honors Retry-After across an interrupted process and resumes after the deadline', async () => {
    writeFileSync(output + '.checkpoint', JSON.stringify({ checkpointId: 'test', network: 'mainnet', api: 'https://audit.example', ended: true, handles: [handle(0)] }));
    writeFileSync(output + '.progress', JSON.stringify({ checkpointId: 'test', checked: 0, findings: [] }));
    process.argv.push('--resume');
    const starts: number[] = [];
    global.fetch = jest.fn(async () => { starts.push(Date.now()); return new Response('', { status: 429, headers: { 'Retry-After': '5' } }); });
    const { run } = await import('./handle-audit-runner');
    void run();
    await jest.advanceTimersByTimeAsync(0);
    expect(saved('.progress')).toMatchObject({ checked: 0, notBefore: epoch + 5000 });
    jest.clearAllTimers();
    jest.resetModules();
    global.fetch = jest.fn(async () => { starts.push(Date.now()); return new Response(JSON.stringify(rows(0, 1))); });
    const restarted = (await import('./handle-audit-runner')).run();
    await jest.advanceTimersByTimeAsync(4999);
    expect(starts).toEqual([epoch]);
    await jest.advanceTimersByTimeAsync(1);
    await restarted;
    expect(starts).toEqual([epoch, epoch + 5000]);
    expect(saved('')).toMatchObject({ checked: 1, findings: [{ name: 'h0', status: 'mismatch' }] });
});

// A successful response can exhaust quota too; its hold must survive a crash before the next batch.
// Without persisting successful-response headers, the restarted audit dispatches the second batch early.
it('persists quota exhaustion from a successful response across restart', async () => {
    writeFileSync(output + '.checkpoint', JSON.stringify({ checkpointId: 'test', network: 'mainnet', api: 'https://audit.example', ended: true, handles: Array.from({ length: 21 }, (_, i) => handle(i)) }));
    writeFileSync(output + '.progress', JSON.stringify({ checkpointId: 'test', checked: 0, findings: [] }));
    process.argv.push('--resume');
    const starts: number[] = [];
    global.fetch = jest.fn(async () => {
        starts.push(Date.now());
        return new Response(JSON.stringify(rows(0, 20)), { headers: { 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': `${(epoch + 5000) / 1000}` } });
    });
    const { run } = await import('./handle-audit-runner');
    void run();
    await jest.advanceTimersByTimeAsync(0);
    expect(saved('.progress')).toMatchObject({ checked: 20 });
    expect(saved('.limits').limits.koios.notBefore).toBe(epoch + 5000);
    jest.clearAllTimers();
    jest.resetModules();
    global.fetch = jest.fn(async () => { starts.push(Date.now()); return new Response(JSON.stringify(rows(20, 21))); });
    const restarted = (await import('./handle-audit-runner')).run();
    await jest.advanceTimersByTimeAsync(4999);
    expect(starts).toEqual([epoch]);
    await jest.advanceTimersByTimeAsync(1);
    await restarted;
    expect(starts).toEqual([epoch, epoch + 5000]);
    expect(saved('')).toMatchObject({ checked: 21, findings: [{ name: 'h0', status: 'mismatch' }] });
});

// API enumeration must respect the API's own 429 instead of advancing or retrying early.
// Omitting header admission makes the second enumeration request appear before its deadline.
it('waits for the API response deadline before retrying enumeration', async () => {
    const starts: number[] = [];
    global.fetch = jest.fn(async () => {
        starts.push(Date.now());
        return starts.length === 1 ? new Response('', { status: 429, headers: { 'Retry-After': '4' } }) : new Response('[]');
    });
    const { run } = await import('./handle-audit-runner');
    const pending = run();
    await jest.advanceTimersByTimeAsync(3999);
    expect(starts).toEqual([epoch]);
    await jest.advanceTimersByTimeAsync(1);
    await pending;
    expect(starts).toEqual([epoch, epoch + 4000]);
    expect(saved('')).toMatchObject({ checked: 0, enumerationEnded: true, findings: [] });
});

// A response-body timeout retries the unfinished batch without violating its already received header.
// Dropping the persisted provider hold dispatches the retry at the shorter five-second backoff.
it('recovers from a timeout while honoring previously received headers', async () => {
    writeFileSync(output + '.checkpoint', JSON.stringify({ checkpointId: 'test', network: 'mainnet', api: 'https://audit.example', ended: true, handles: [handle(0)] }));
    writeFileSync(output + '.progress', JSON.stringify({ checkpointId: 'test', checked: 0, findings: [] }));
    process.argv.push('--resume');
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const starts: number[] = [];
    global.fetch = jest.fn(async () => {
        starts.push(Date.now());
        if (starts.length > 1) return new Response(JSON.stringify(rows(0, 1)));
        const response = new Response('', { headers: { 'Retry-After': '10' } });
        jest.spyOn(response, 'text').mockRejectedValue(new DOMException('timeout', 'TimeoutError'));
        return response;
    });
    const { run } = await import('./handle-audit-runner');
    const pending = run();
    await jest.advanceTimersByTimeAsync(9999);
    expect(starts).toEqual([epoch]);
    await jest.advanceTimersByTimeAsync(1);
    await pending;
    expect(starts).toEqual([epoch, epoch + 10000]);
    expect(saved('')).toMatchObject({ checked: 1, findings: [{ name: 'h0', status: 'mismatch' }] });
    jest.restoreAllMocks();
});

// Headerless 429s back off progressively and preserve the next start across a process restart.
// Removing the wait or resetting the attempt count dispatches the next request too early.
it('backs off on headerless 429s and resumes the pending wait after restart', async () => {
    writeFileSync(output + '.checkpoint', JSON.stringify({ checkpointId: 'test', network: 'mainnet', api: 'https://audit.example', ended: true, handles: [handle(0)] }));
    writeFileSync(output + '.progress', JSON.stringify({ checkpointId: 'test', checked: 0, findings: [] }));
    process.argv.push('--resume');
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const starts: number[] = [];
    global.fetch = jest.fn(async () => { starts.push(Date.now()); return new Response('too many requests', { status: 429 }); });
    const { run } = await import('./handle-audit-runner');
    void run();
    await jest.advanceTimersByTimeAsync(5000);
    expect(starts).toEqual([epoch, epoch + 5000]);
    expect(saved('.limits').limits.koios).toMatchObject({ notBefore: epoch + 15000, noResetAttempts: 2 });
    expect(saved('.progress')).toMatchObject({ checked: 0, findings: [] });
    jest.clearAllTimers();
    jest.resetModules();
    global.fetch = jest.fn(async () => { starts.push(Date.now()); return new Response(JSON.stringify(rows(0, 1))); });
    const restarted = (await import('./handle-audit-runner')).run();
    await jest.advanceTimersByTimeAsync(9999);
    expect(starts).toEqual([epoch, epoch + 5000]);
    await jest.advanceTimersByTimeAsync(1);
    await jest.advanceTimersByTimeAsync(300000);
    expect(starts).toEqual([epoch, epoch + 5000, epoch + 15000]);
    await restarted;
    expect(saved('')).toMatchObject({ checked: 1, findings: [{ name: 'h0', status: 'mismatch' }] });
    jest.restoreAllMocks();
});
