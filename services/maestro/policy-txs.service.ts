import { LogCategory, Logger, Network } from '@koralabs/kora-labs-common';
import { getHandlesStore } from '../../stores/redis';

const MAESTRO_API_KEY = (process.env.MAESTRO_API_KEY ?? '').trim();
const MAESTRO_HIGH_RPS = Math.max(1, Number(process.env.MAESTRO_HIGH_RPS ?? 8));
const MAESTRO_PAGE_INTERVAL_MS = Math.ceil(1000 / MAESTRO_HIGH_RPS);
const MAESTRO_RETRY_DELAYS_MS = [500, 1500, 4000];
const MAESTRO_DEFAULT_COOLDOWN_SEC = Math.max(1, Number(process.env.MAESTRO_DEFAULT_COOLDOWN_SECONDS ?? 60));
// Proactive daily-credit guard: when Maestro reports credits remaining below this
// threshold we set a long cool-down so we stop hitting the API entirely instead of
// waiting for 429s to bounce us. Free tier is 33,333/day; 200 leaves a small buffer
// (~100 typical scan ticks) for the day's remainder.
const MAESTRO_LOW_CREDITS_THRESHOLD = Math.max(0, Number(process.env.MAESTRO_LOW_CREDITS_THRESHOLD ?? 200));
const MAESTRO_LOW_CREDITS_COOLDOWN_SEC = Math.max(1, Number(process.env.MAESTRO_LOW_CREDITS_COOLDOWN_SECONDS ?? 3600));
const MAESTRO_PAGE_SIZE = 100;
const MAESTRO_TIMEOUT_MS = 15_000;
const MAESTRO_COOLDOWN_KEY = 'maestro:cooldown';

const maestroBase = (network: Network) => `https://${String(network).toLowerCase()}.gomaestro-api.org/v1`;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export const isMaestroConfigured = (): boolean => MAESTRO_API_KEY.length > 0;

const isInCooldown = (): boolean => {
    try {
        return Number(getHandlesStore().redisClientCall('exists', MAESTRO_COOLDOWN_KEY)) === 1;
    } catch {
        return false;
    }
};

const setCooldown = (seconds: number): void => {
    try {
        getHandlesStore().redisClientCall('set', MAESTRO_COOLDOWN_KEY, '1', { expiry: { type: 'EX', count: seconds } });
    } catch {
        // Best-effort. If Redis is down the scanner has bigger problems than missing a Maestro cool-down.
    }
};

interface MaestroTxRow { tx_hash: string; slot: number; assets: string[]; }
interface MaestroPageResponse { data: MaestroTxRow[]; next_cursor: string | null; }

interface FetchPageOpts { from?: number; cursor?: string | null; }

// On every Maestro response (success or 429) we read X-Maestro-Credits-Remaining.
// If it dips at or below MAESTRO_LOW_CREDITS_THRESHOLD we proactively engage the
// long cool-down — better than waiting to be 429'd, especially since the daily
// quota resets only at the rollover and there's no point pinging in between.
const handleCreditsHeader = (response: { headers: { get: (k: string) => string | null } }): void => {
    const remainingRaw = response.headers.get('x-maestro-credits-remaining');
    if (!remainingRaw) return;
    const remaining = Number(remainingRaw);
    if (!Number.isFinite(remaining)) return;
    if (remaining <= MAESTRO_LOW_CREDITS_THRESHOLD) {
        setCooldown(MAESTRO_LOW_CREDITS_COOLDOWN_SEC);
        Logger.log({
            message: `Maestro daily credits low (remaining=${remaining} threshold=${MAESTRO_LOW_CREDITS_THRESHOLD}) — cool-down ${MAESTRO_LOW_CREDITS_COOLDOWN_SEC}s set; falling back for the rest of the window`,
            category: LogCategory.WARN,
            event: 'scannerLambda.maestro.creditsLow'
        });
    }
};

const fetchPage = async (network: Network, policy: string, opts: FetchPageOpts): Promise<MaestroPageResponse> => {
    const qs: string[] = [`count=${MAESTRO_PAGE_SIZE}`, 'order=asc'];
    if (opts.cursor) qs.push(`cursor=${encodeURIComponent(opts.cursor)}`);
    else if (typeof opts.from === 'number') qs.push(`from=${opts.from}`);
    const url = `${maestroBase(network)}/policy/${policy}/transactions?${qs.join('&')}`;
    const response = await fetch(url, {
        headers: { 'api-key': MAESTRO_API_KEY },
        signal: AbortSignal.timeout(MAESTRO_TIMEOUT_MS)
    });
    handleCreditsHeader(response);
    if (!response.ok) {
        const error: any = new Error(`Maestro ${policy.slice(0, 10)}… ${response.status}: ${(await response.text()).slice(0, 256)}`);
        error.status = response.status;
        const retryAfterRaw = response.headers.get('retry-after');
        const retryAfter = retryAfterRaw ? Number(retryAfterRaw) : 0;
        error.retryAfter = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 0;
        throw error;
    }
    return (await response.json()) as MaestroPageResponse;
};

const isRetriableMaestroError = (error: any): boolean => {
    const status = Number(error?.status ?? 0);
    if ([429, 502, 503, 504].includes(status)) return true;
    const name = `${error?.name ?? error?.cause?.name ?? ''}`;
    if (name === 'TimeoutError' || name === 'AbortError') return true;
    const code = `${error?.code ?? error?.cause?.code ?? ''}`.toLowerCase();
    if (code === 'und_err_socket' || code === 'econnreset' || code === 'etimedout') return true;
    return false;
};

const fetchPageWithRetry = async (network: Network, policy: string, opts: FetchPageOpts): Promise<MaestroPageResponse> => {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fetchPage(network, policy, opts);
        } catch (error: any) {
            const status = Number(error?.status ?? 0);
            const retriable = isRetriableMaestroError(error);
            if (status === 429) {
                // Set cool-down even mid-retry — subsequent ticks should respect Retry-After.
                const seconds = error?.retryAfter > 0 ? error.retryAfter : MAESTRO_DEFAULT_COOLDOWN_SEC;
                setCooldown(seconds);
            }
            if (!retriable || attempt >= MAESTRO_RETRY_DELAYS_MS.length) throw error;
            await sleep(MAESTRO_RETRY_DELAYS_MS[attempt]);
        }
    }
};

export interface MaestroDiscoveryResult {
    txHashes: string[]; // ordered by slot ascending; deduped across policies
    slotByTx: Map<string, number>;
}

/**
 * Returns every handle-touching tx_hash whose slot falls within [fromSlot, toSlot]
 * across all given policies, by querying Maestro's per-policy transactions endpoint.
 *
 * Returns null when:
 *   - MAESTRO_API_KEY is not configured (caller should use existing block_txs path)
 *   - A Redis-backed cool-down is active (set after a 429 to avoid retry storms)
 *   - Any underlying call fails after retries (caller should fall back this tick)
 */
export const discoverHandleTxsBySlotRange = async (
    network: Network,
    policies: string[],
    fromSlot: number,
    toSlot: number
): Promise<MaestroDiscoveryResult | null> => {
    if (!MAESTRO_API_KEY) return null;
    if (isInCooldown()) {
        Logger.local('Maestro discovery skipped (cool-down active)');
        return null;
    }
    if (fromSlot > toSlot) return { txHashes: [], slotByTx: new Map() };

    const collected: { tx_hash: string; slot: number }[] = [];
    try {
        for (const policy of policies) {
            let cursor: string | null = null;
            let firstPage = true;
            for (;;) {
                const page = await fetchPageWithRetry(network, policy, firstPage ? { from: fromSlot } : { cursor });
                firstPage = false;
                let stop = false;
                for (const row of page.data ?? []) {
                    if (row.slot > toSlot) { stop = true; break; }
                    // Drop nameless-only rows (CIP-27 royalty token under same policy).
                    const assets = row.assets ?? [];
                    if (assets.length > 0 && assets.every((a) => a === '')) continue;
                    collected.push({ tx_hash: row.tx_hash, slot: row.slot });
                }
                if (stop || !page.next_cursor) break;
                cursor = page.next_cursor;
                await sleep(MAESTRO_PAGE_INTERVAL_MS);
            }
        }
    } catch (error: any) {
        Logger.log({
            message: `Maestro discovery failed; falling back to block_txs for this tick. status=${error?.status ?? ''} error=${error?.message ?? error}`,
            category: LogCategory.WARN,
            event: 'scannerLambda.maestro.fallback'
        });
        return null;
    }

    collected.sort((a, b) => a.slot - b.slot || (a.tx_hash < b.tx_hash ? -1 : 1));
    const seen = new Set<string>();
    const txHashes: string[] = [];
    const slotByTx = new Map<string, number>();
    for (const row of collected) {
        if (seen.has(row.tx_hash)) continue;
        seen.add(row.tx_hash);
        txHashes.push(row.tx_hash);
        slotByTx.set(row.tx_hash, row.slot);
    }
    return { txHashes, slotByTx };
};
