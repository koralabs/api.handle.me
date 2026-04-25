import { discoverHandleTxsBySlotRange, isMaestroConfigured } from './policy-txs.service';
import { getHandlesStore } from '../../stores/redis';

jest.mock('../../stores/redis');

const POLICY_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const POLICY_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HANDLE_ASSET = '6a616d';

interface PageResp { data: { tx_hash: string; slot: number; assets: string[] }[]; next_cursor: string | null }

const buildResp = (rows: PageResp['data'], next_cursor: string | null = null, creditsRemaining?: number) => ({
    ok: true,
    status: 200,
    json: async () => ({ data: rows, next_cursor }),
    text: async () => '',
    headers: {
        get: (k: string) => {
            if (k.toLowerCase() === 'x-maestro-credits-remaining' && creditsRemaining !== undefined) {
                return String(creditsRemaining);
            }
            return null;
        }
    }
});

const buildErrorResp = (status: number, body = '', retryAfter?: string, creditsRemaining?: number) => ({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => body,
    headers: {
        get: (k: string) => {
            const key = k.toLowerCase();
            if (key === 'retry-after') return retryAfter ?? null;
            if (key === 'x-maestro-credits-remaining' && creditsRemaining !== undefined) return String(creditsRemaining);
            return null;
        }
    }
});

describe('discoverHandleTxsBySlotRange', () => {
    const originalFetch = global.fetch;
    const cooldownState: { [k: string]: '1' | undefined } = {};
    const redisCalls: { command: string; args: any[] }[] = [];

    beforeEach(() => {
        // Reset cool-down + call log
        for (const k of Object.keys(cooldownState)) delete cooldownState[k];
        redisCalls.length = 0;
        const fakeStore = {
            redisClientCall: (command: string, key: string, ...rest: any[]) => {
                redisCalls.push({ command, args: [key, ...rest] });
                if (command === 'exists') return cooldownState[key] ? 1 : 0;
                if (command === 'set') {
                    cooldownState[key] = '1';
                    return 'OK';
                }
                return null;
            }
        };
        (getHandlesStore as jest.Mock).mockImplementation(() => fakeStore as any);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        if (originalFetch) global.fetch = originalFetch;
        else delete (global as any).fetch;
    });

    test('reports configured when MAESTRO_API_KEY is set', () => {
        // jest.config sets MAESTRO_API_KEY=test for the test env
        expect(isMaestroConfigured()).toBe(true);
    });

    test('returns deduped tx hashes ordered by slot, filtering nameless royalty rows', async () => {
        // Validates: each policy's transactions endpoint is called once, nameless-only
        // rows (royalty token) are dropped, results across policies are merged & deduped,
        // ordering is slot ascending.
        // Failure caught: leaving nameless rows in would cause downstream tx_info fetches
        // for unrelated CIP-27 royalty txs; missing dedupe would double-process txs that
        // touch both policies; wrong ordering breaks intra-block dependency resolution.
        const fetchMock = jest.fn(async (url: string) => {
            if (url.includes(POLICY_A)) {
                return buildResp([
                    { tx_hash: 'tx2', slot: 200, assets: [HANDLE_ASSET] },
                    { tx_hash: 'tx-nameless', slot: 250, assets: [''] }, // royalty — drop
                    { tx_hash: 'tx-shared', slot: 300, assets: [HANDLE_ASSET] }
                ]);
            }
            if (url.includes(POLICY_B)) {
                return buildResp([
                    { tx_hash: 'tx1', slot: 150, assets: [HANDLE_ASSET] },
                    { tx_hash: 'tx-shared', slot: 300, assets: [HANDLE_ASSET] } // dedupe target
                ]);
            }
            throw new Error(`unexpected url: ${url}`);
        });
        (global as any).fetch = fetchMock;

        const result = await discoverHandleTxsBySlotRange('mainnet' as any, [POLICY_A, POLICY_B], 100, 400);
        expect(result).not.toBeNull();
        expect(result!.txHashes).toEqual(['tx1', 'tx2', 'tx-shared']); // slot 150, 200, 300
        expect(result!.slotByTx.get('tx1')).toBe(150);
        expect(result!.slotByTx.get('tx-shared')).toBe(300);
        expect(fetchMock).toHaveBeenCalledTimes(2); // one call per policy, single page each
    });

    test('paginates via next_cursor and stops when row.slot exceeds toSlot', async () => {
        // Validates: cursor is propagated into subsequent requests; pagination halts as
        // soon as a returned row's slot is > toSlot, even if more cursor pages exist.
        // Failure caught: ignoring next_cursor would silently drop later rows; ignoring
        // toSlot would over-collect into the next scan window's range, double-processing.
        const fetchMock = jest.fn(async (url: string) => {
            if (!url.includes('cursor=')) {
                return buildResp(
                    [
                        { tx_hash: 'tx1', slot: 110, assets: [HANDLE_ASSET] },
                        { tx_hash: 'tx2', slot: 120, assets: [HANDLE_ASSET] }
                    ],
                    'CURSOR_TOKEN'
                );
            }
            // Page 2: contains a row past toSlot — collection should stop on it.
            return buildResp([
                { tx_hash: 'tx3', slot: 199, assets: [HANDLE_ASSET] },
                { tx_hash: 'tx-out-of-window', slot: 999, assets: [HANDLE_ASSET] }
            ], 'NEXT_TOKEN');
        });
        (global as any).fetch = fetchMock;

        const result = await discoverHandleTxsBySlotRange('mainnet' as any, [POLICY_A], 100, 200);
        expect(result!.txHashes).toEqual(['tx1', 'tx2', 'tx3']);
        expect(result!.slotByTx.has('tx-out-of-window')).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[1][0]).toContain('cursor=CURSOR_TOKEN');
    });

    test('returns null and sets Redis cool-down on 429', async () => {
        // Validates: a 429 response sets a Redis cool-down key with TTL from Retry-After,
        // discovery returns null so the caller falls back, and the next call short-circuits
        // without making any HTTP requests while the cool-down is active.
        // Failure caught: missing cool-down would mean every tick re-hits Maestro and gets
        // 429 again, wasting both quota and scanner deadline budget.
        const fetchMock = jest.fn(async () => buildErrorResp(429, 'rate limited', '30'));
        (global as any).fetch = fetchMock;

        const result = await discoverHandleTxsBySlotRange('mainnet' as any, [POLICY_A], 100, 200);
        expect(result).toBeNull();
        // Verify a SET with EX expiry was issued for the cool-down key.
        const setCall = redisCalls.find((c) => c.command === 'set' && c.args[0] === 'maestro:cooldown');
        expect(setCall).toBeDefined();
        expect(setCall!.args[2]).toEqual(expect.objectContaining({ expiry: { type: 'EX', count: 30 } }));

        // Subsequent call: cool-down is active → returns null without any HTTP traffic.
        fetchMock.mockClear();
        const second = await discoverHandleTxsBySlotRange('mainnet' as any, [POLICY_A], 100, 200);
        expect(second).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    }, 15_000); // real retry backoffs sum to ~6s; 15s gives comfortable margin

    test('returns null when fromSlot > toSlot guard fires before any HTTP', async () => {
        // Validates: empty / inverted windows produce an empty result without quota burn.
        const fetchMock = jest.fn();
        (global as any).fetch = fetchMock;
        const result = await discoverHandleTxsBySlotRange('mainnet' as any, [POLICY_A], 200, 100);
        expect(result).toEqual({ txHashes: [], slotByTx: new Map() });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('non-retriable error (500) fails fast with one attempt and no cool-down', async () => {
        // Validates: 500 is treated as a hard failure (not a transient capacity signal),
        // so we don't burn retries — single attempt, return null, no cool-down set.
        // Failure caught: classifying 500 as retriable would waste up to ~6s of the
        // scanner's 12-min budget on a hopeless loop; setting cool-down would gate
        // future ticks needlessly when 500 is just a deploy/upstream blip.
        const fetchMock = jest.fn(async () => buildErrorResp(500, 'oops'));
        (global as any).fetch = fetchMock;
        const result = await discoverHandleTxsBySlotRange('mainnet' as any, [POLICY_A], 100, 200);
        expect(result).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const setCall = redisCalls.find((c) => c.command === 'set' && c.args[0] === 'maestro:cooldown');
        expect(setCall).toBeUndefined();
    });

    test('retriable 503 exhausts retries then falls back without cool-down', async () => {
        // Validates: 503 is retriable; we attempt up to 4 times (initial + 3 retries),
        // and on persistent failure return null without setting cool-down (503 ≠ rate limit).
        // Failure caught: not retrying 503 would cause spurious fall-backs on transient
        // upstream blips; setting cool-down on 503 would gate future ticks needlessly.
        const fetchMock = jest.fn(async () => buildErrorResp(503, 'unavailable'));
        (global as any).fetch = fetchMock;
        const result = await discoverHandleTxsBySlotRange('mainnet' as any, [POLICY_A], 100, 200);
        expect(result).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(4);
        const setCall = redisCalls.find((c) => c.command === 'set' && c.args[0] === 'maestro:cooldown');
        expect(setCall).toBeUndefined();
    }, 15_000);

    test('engages long cool-down proactively when X-Maestro-Credits-Remaining drops to threshold', async () => {
        // Validates: a successful response carrying a low credits header sets a long
        // Redis cool-down before we get 429'd, so we stop spending credits we don't have
        // and let the daily quota reset before retrying.
        // Failure mode caught: ignoring the header would mean we burn the last of the
        // day's quota on near-empty calls and start getting 429s; or, after switching to
        // a paid tier with per-credit billing, we'd silently rack up costs.
        // The default threshold is 200; this test uses 50 (well below) to confirm the
        // gate fires.
        const fetchMock = jest.fn(async () => buildResp(
            [{ tx_hash: 'tx1', slot: 150, assets: [HANDLE_ASSET] }],
            null,
            50 // credits remaining — well below the 200 threshold
        ));
        (global as any).fetch = fetchMock;

        // First call: succeeds, but the low-credits header triggers the cool-down.
        const first = await discoverHandleTxsBySlotRange('mainnet' as any, [POLICY_A], 100, 200);
        expect(first).not.toBeNull();
        expect(first!.txHashes).toEqual(['tx1']); // we still consume this response — work done is work done
        const setCall = redisCalls.find((c) => c.command === 'set' && c.args[0] === 'maestro:cooldown');
        expect(setCall).toBeDefined();
        // Default low-credits cool-down is 3600s (1hr).
        expect(setCall!.args[2]).toEqual(expect.objectContaining({ expiry: { type: 'EX', count: 3600 } }));

        // Second call: cool-down is active → returns null without HTTP.
        fetchMock.mockClear();
        const second = await discoverHandleTxsBySlotRange('mainnet' as any, [POLICY_A], 100, 200);
        expect(second).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('healthy credits remaining does not engage cool-down', async () => {
        // Validates: when X-Maestro-Credits-Remaining is well above the threshold, we
        // process the response normally and do NOT set a cool-down. Negative control
        // for the previous test — confirms the gate is actually keyed on the header
        // value rather than firing on every response.
        const fetchMock = jest.fn(async () => buildResp(
            [{ tx_hash: 'tx1', slot: 150, assets: [HANDLE_ASSET] }],
            null,
            32_000 // credits remaining — well above any reasonable threshold
        ));
        (global as any).fetch = fetchMock;

        const result = await discoverHandleTxsBySlotRange('mainnet' as any, [POLICY_A], 100, 200);
        expect(result).not.toBeNull();
        const setCall = redisCalls.find((c) => c.command === 'set' && c.args[0] === 'maestro:cooldown');
        expect(setCall).toBeUndefined();
    });
});
