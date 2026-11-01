export interface KoiosAdmission {
    beforeStart?: (earliestStartAtMs?: number) => void;
    minIntervalMs?: number;
}

const seconds = (value: unknown): number | undefined => {
    if (typeof value !== 'string' && typeof value !== 'number') return undefined;
    if (`${value}`.trim() === '') return undefined;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n * 1000 : undefined;
};

const retryAfter = (value: string | null, now: number): number | undefined => {
    if (value === null || value.trim() === '') return undefined;
    // A numeric lexeme is a duration, never a date (Date.parse('-2060') reads year 2060).
    if (Number.isFinite(Number(value))) return seconds(value);
    const at = Date.parse(value);
    return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
};

const resetDelay = (value: string | null, now: number, relative: boolean): number | undefined => {
    if (value === null || value.trim() === '') return undefined;
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
        if (numeric < 0) return undefined;
        if (relative && numeric < 1_000_000_000) return numeric * 1000;
        const at = numeric >= 1_000_000_000_000 ? numeric : numeric * 1000;
        return Math.max(0, at - now);
    }
    return retryAfter(value, now);
};

const retryInfoDelay = (value: unknown): number | undefined => {
    if (typeof value === 'string' && /^\d+(?:\.\d+)?s$/.test(value)) return Number(value.slice(0, -1)) * 1000;
    if (!value || typeof value !== 'object') return undefined;
    const duration = value as { seconds?: unknown; nanos?: unknown };
    const s = Number(duration.seconds ?? 0);
    const n = Number(duration.nanos ?? 0);
    return Number.isFinite(s) && s >= 0 && Number.isFinite(n) && n >= 0 ? s * 1000 + n / 1_000_000 : undefined;
};

/** One process-lifetime state per provider; shared parsing/admission, never shared quotas. */
export const createProviderLimiter = () => {
    let providerNotBefore = 0;
    let nextStart = 0;
    const remember = (delays: (number | undefined)[], now: number): number | undefined => {
        const stated = delays.filter((delay): delay is number => delay !== undefined && Number.isFinite(delay) && delay >= 0);
        if (!stated.length) return undefined;
        const wait = Math.max(...stated);
        providerNotBefore = Math.max(providerNotBefore, now + wait);
        return wait;
    };
    const observeHeaders = (headers: Headers, now = Date.now()): number | undefined => remember([
        retryAfter(headers.get('retry-after'), now),
        seconds(headers.get('x-ratelimit-reset-after')),
        seconds(headers.get('ratelimit-reset-after')),
        resetDelay(headers.get('ratelimit-reset'), now, true),
        headers.get('x-ratelimit-remaining')?.trim() === '0'
            ? resetDelay(headers.get('x-ratelimit-reset'), now, false) : undefined
    ], now);
    const observeBody = (body: unknown, now = Date.now()): number | undefined => {
        if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
        const object = body as { retry_after?: unknown; error?: { details?: unknown } };
        const details = object.error?.details;
        const retries = Array.isArray(details) ? details.filter((detail) =>
            detail && typeof detail === 'object' && detail['@type'] === 'type.googleapis.com/google.rpc.RetryInfo'
        ).map((detail) => retryInfoDelay(detail.retryDelay)) : [];
        return remember([seconds(object.retry_after), ...retries], now);
    };
    const admit = async <T>(notBefore: number, admission: KoiosAdmission, start: () => T | Promise<T>, claim: boolean): Promise<T> => {
        while (true) {
            const now = Date.now();
            const earliest = Math.max(now, notBefore, providerNotBefore, nextStart);
            // Reject an impossible start before sleeping, without shortening the
            // provider hold. Recheck on every wake, including at actual dispatch.
            admission.beforeStart?.(earliest);
            if (earliest > now) {
                await new Promise<void>((resolve) => setTimeout(resolve, earliest - now));
                continue;
            }
            if (claim) nextStart = now + (admission.minIntervalMs ?? 0);
            // No await separates the final budget check, pacing claim and HTTP start.
            return start();
        }
    };
    return {
        observeHeaders,
        observeBody,
        wait: (delayMs: number, admission: KoiosAdmission = {}): Promise<void> => admit(Date.now() + delayMs, admission, () => undefined, false),
        // Attach receipt handling to fetch itself, before this wrapper's adoption turns.
        request: (dispatch: () => Promise<Response>, admission: KoiosAdmission = {}): Promise<{ response: Response; headerWait: number | undefined }> =>
            admit(0, admission, () => dispatch().then((response) => ({ response, headerWait: observeHeaders(response.headers) })), true)
    };
};

const koios = createProviderLimiter();
export const observeKoiosHeaders = koios.observeHeaders;
export const observeKoiosBody = koios.observeBody;
export const requestKoios = koios.request;
