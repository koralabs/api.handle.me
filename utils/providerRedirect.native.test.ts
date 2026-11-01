import { createServer, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type * as Helpers from './helpers';
import type { KoiosAdmission } from './koiosRateLimit';
import { RequestDeadlineError } from './requestDeadline';

const nativeFetch = global.fetch;
let helpers: typeof Helpers;
let server: Server;
let origin: string;
let status: number;
let headerWait: string | undefined;
let firstBody: unknown;
let wire: { path: string; method: string; body: string; auth: string | undefined; project: string | undefined; at: number }[];

beforeEach(async () => {
    // Never load or send provider credentials. The HTTP boundary also scrubs
    // both actual producers' credential headers before any native dispatch.
    jest.replaceProperty(process, 'env', { NETWORK: 'preview', BLOCKFROST_API_KEY: 'fixture-key', KOIOS_API_BEARER_TOKEN: 'fixture-token' });
    jest.isolateModules(() => { helpers = require('./helpers'); });
    status = 302;
    headerWait = '3600';
    firstBody = { marker: 'first', retry_after: 3600 };
    wire = [];
    server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on('data', chunk => chunks.push(Buffer.from(chunk)));
        request.on('end', () => {
            wire.push({ path: request.url!, method: request.method!, body: Buffer.concat(chunks).toString(),
                auth: request.headers.authorization, project: request.headers.project_id as string | undefined, at: Date.now() });
            const first = request.url!.endsWith('/first');
            response.statusCode = first ? status : 200;
            response.setHeader('Content-Type', 'application/json');
            if (first) {
                if (headerWait !== undefined) response.setHeader('Retry-After', headerWait);
                response.setHeader('Location', `${origin}/target`);
            }
            response.end(JSON.stringify(first ? firstBody : []));
        });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    global.fetch = (input, init) => {
        const url = new URL(String(input));
        if (!(url.hostname.endsWith('.koios.rest') || url.hostname.endsWith('.blockfrost.io'))) {
            throw new Error('Unexpected provider destination in native loopback test');
        }
        const headers = new Headers(init?.headers);
        if (headers.has('Authorization')) headers.set('Authorization', 'Bearer fixture-token');
        if (headers.has('project_id')) headers.set('project_id', 'fixture-key');
        // Forward real redirect/method/body/signal options UNCHANGED. Native
        // fetch, not this adapter, decides whether Location is followed.
        return nativeFetch(`${origin}${url.pathname}${url.search}`, { ...init, headers });
    };
});

afterEach(async () => {
    global.fetch = nativeFetch;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    jest.restoreAllMocks();
});

const call = (provider: string, path: string, admission?: KoiosAdmission) => provider === 'koios'
    ? helpers.fetchKoios(path, 'POST', JSON.stringify({ fixture: true }), admission)
    : helpers.blockfrostApiCall(path, admission);
const prefix = (provider: string) => provider === 'koios' ? '/api/v1' : '/api/v0';

// Invariant: every first HTTP response reaches the limiter before ANY follow-up.
// Failure: native redirect-follow hides the 3xx wait and dispatches Location early.
// Negative control: old producers (no manual option) request /target immediately;
// direct429 still passes, distinguishing transport behavior from a broken limiter.
describe.each(['koios', 'blockfrost'])('%s native HTTP admission', provider => {
    it.each([
        ['302 header only', 302, '3600', { marker: 'first' }],
        ['302 body only', 302, undefined, { marker: 'first', retry_after: 3600 }],
        ['302 maximum header/body', 302, '3600', { marker: 'first', retry_after: 1 }],
        ['307 preserves POST/body without replay', 307, '3600', { marker: 'first', retry_after: 3600 }],
        ['direct429 positive control', 429, '3600', { marker: 'first', retry_after: 3600 }]
    ])('%s retains the first status and hour floor', async (_name, code, wait, body) => {
        status = code as number;
        headerWait = wait as string | undefined;
        firstBody = body;
        const outcome = await call(provider, 'first').then(value => ({ value, error: undefined }), error => ({ value: undefined, error }));
        expect(wire.map(row => row.path)).toEqual([`${prefix(provider)}/first`]);
        expect(wire[0].method).toBe(provider === 'koios' ? 'POST' : 'GET');
        expect(wire[0].body).toBe(provider === 'koios' ? '{"fixture":true}' : '');
        if (provider === 'koios') {
            expect(wire[0].auth).toBe('Bearer fixture-token');
            expect(outcome.error).toMatchObject({ status, koiosResponse: firstBody, retryAfterMs: 3_600_000 });
            expect(outcome.value).toBeUndefined();
        } else {
            const response = outcome.value as Response;
            expect(outcome.error).toBeUndefined();
            expect(response.status).toBe(status);
            expect(response.headers.get('Location')).toBe(`${origin}/target`);
            expect(response.headers.get('Retry-After')).toBe(headerWait ?? null);
            expect(response.bodyUsed).toBe(false);
            expect(await response.json()).toEqual(firstBody);
            expect(wire[0].project).toBe('fixture-key');
        }
        const floors: number[] = [];
        const deadline = Date.now() + 240_000;
        const budget = { beforeStart: (earliest = Date.now()) => {
            floors.push(earliest);
            if (earliest >= deadline) throw new RequestDeadlineError('proposed provider start exceeds work budget');
        } };
        // Two refused callers prove rejection does not clear/shorten the floor.
        for (let i = 0; i < 2; i++) {
            await expect(call(provider, 'after', budget)).rejects.toMatchObject({ code: 'REQUEST_DEADLINE_EXCEEDED' });
        }
        expect(floors).toHaveLength(2);
        expect(floors[0]).toBeGreaterThanOrEqual(wire[0].at + 3_600_000);
        expect(floors[1]).toBe(floors[0]);
        expect(wire.map(row => row.path)).toEqual([`${prefix(provider)}/first`]);
    });

    // Invariant: ordinary successful JSON still works over the real transport.
    it('retains a successful nonredirect response and permits the next call', async () => {
        status = 200; headerWait = undefined; firstBody = [];
        const first = await call(provider, 'first');
        expect(provider === 'koios' ? first : await (first as Response).json()).toEqual([]);
        const next = await call(provider, 'after');
        expect(provider === 'koios' ? next : await (next as Response).json()).toEqual([]);
        expect(wire.map(row => row.path)).toEqual([`${prefix(provider)}/first`, `${prefix(provider)}/after`]);
    });

    // Invariant: even a redirect with no wait does not grant hidden HTTP authority.
    it('does not follow an unthrottled302 or invent a hold', async () => {
        headerWait = undefined; firstBody = { marker: 'first' };
        const first = await call(provider, 'first').catch(error => error);
        expect(first.status).toBe(302);
        const next = await call(provider, 'after', { beforeStart: (earliest = Date.now()) => {
            if (earliest >= Date.now() + 240_000) throw new RequestDeadlineError('unexpected invented hold');
        } });
        expect(provider === 'koios' ? next : await (next as Response).json()).toEqual([]);
        expect(wire.map(row => row.path)).toEqual([`${prefix(provider)}/first`, `${prefix(provider)}/after`]);
    });
});
