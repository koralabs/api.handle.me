/**
 * Read-only comparison of API ownership-token UTxOs with Koios.
 * NETWORK=mainnet npx tsx scripts/verify-handles.ts --output tmp/handle-audit.json
 * MAX_HANDLES may limit a sample. A paginated live API is not a chain snapshot;
 * recheck every finding before any repair. This does not detect missing API records.
 */
import 'dotenv/config';
import { readFileSync, renameSync, writeFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { fetchKoios } from '../utils/helpers';
import { createProviderLimiter } from '../utils/koiosRateLimit';
import { ApiHandle, Finding, compareBatch } from './handle-audit';

const network = (process.env.NETWORK ?? 'preview').toLowerCase();
const apiBase = process.env.API_BASE ?? (network === 'mainnet' ? 'https://api.handle.me' : `https://${network}.api.handle.me`);
const maxHandles = Number(process.env.MAX_HANDLES ?? Infinity);
const pageSize = 250;
const batchSize = 20;
const limiter = createProviderLimiter();

export async function run() {
    if (!(maxHandles > 0)) throw new Error('MAX_HANDLES must be positive');
    const outputIndex = process.argv.indexOf('--output');
    const output = outputIndex === -1 ? undefined : process.argv[outputIndex + 1];
    if (outputIndex !== -1 && !output) throw new Error('--output requires a path');
    const resume = process.argv.includes('--resume');
    if (resume && !output) throw new Error('--resume requires --output');
    const checkpoint = output ? `${output}.checkpoint` : undefined;
    const progress = output ? `${output}.progress` : undefined;
    const limitsPath = output ? `${output}.limits` : undefined;
    const save = (path: string, data: unknown) => {
        const temp = `${path}.tmp`;
        writeFileSync(temp, JSON.stringify(data));
        renameSync(temp, path);
    };
    type Limit = { notBefore?: number; blockedWithoutReset?: boolean; noResetAttempts?: number };
    let limits: Record<'api' | 'koios', Limit> = { api: {}, koios: {} };
    if (limitsPath) {
        try {
            const saved = JSON.parse(readFileSync(limitsPath, 'utf8'));
            if (saved.network !== network || saved.api !== apiBase || !saved.limits?.api || !saved.limits?.koios) throw new Error('Invalid or mismatched rate-limit state');
            limits = saved.limits;
        } catch (error: any) {
            if (error?.code !== 'ENOENT') throw error;
        }
    }
    const saveLimits = () => { if (limitsPath) save(limitsPath, { network, api: apiBase, limits }); };
    const rememberWait = (provider: 'api' | 'koios', notBefore: number) => {
        limits[provider].notBefore = Math.max(limits[provider].notBefore ?? 0, notBefore);
        saveLimits();
    };
    const backoff = (provider: 'api' | 'koios') => {
        const limit = limits[provider];
        const attempts = (limit.noResetAttempts ?? 0) + 1;
        const base = 5000 * 2 ** Math.min(attempts - 1, 6);
        const delay = base + Math.floor(Math.random() * base / 4);
        limit.noResetAttempts = attempts;
        delete limit.blockedWithoutReset;
        rememberWait(provider, Date.now() + delay);
        process.stderr.write(`${provider} 429 without a reset; backing off ${delay}ms (attempt ${attempts})\n`);
    };
    const waitForProvider = async (provider: 'api' | 'koios') => {
        if (limits[provider].blockedWithoutReset) backoff(provider);
        const wait = (limits[provider].notBefore ?? 0) - Date.now();
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    };
    const clearBackoff = (provider: 'api' | 'koios') => {
        if (limits[provider].noResetAttempts) {
            delete limits[provider].noResetAttempts;
            saveLimits();
        }
    };
    let checkpointId = randomUUID();
    let handles: ApiHandle[] = [];
    let ended = false;
    let checked = 0;
    let findings: Finding[] = [];
    if (resume) {
        const saved = JSON.parse(readFileSync(checkpoint!, 'utf8'));
        const savedProgress = JSON.parse(readFileSync(progress!, 'utf8'));
        if (saved.network !== network || saved.api !== apiBase || typeof saved.checkpointId !== 'string' || savedProgress.checkpointId !== saved.checkpointId || !Array.isArray(saved.handles) || !Number.isSafeInteger(savedProgress.checked) || savedProgress.checked < 0 || savedProgress.checked > saved.handles.length || !Array.isArray(savedProgress.findings)) {
            throw new Error('Invalid or mismatched audit checkpoint');
        }
        checkpointId = saved.checkpointId;
        handles = saved.handles;
        ended = saved.ended;
        checked = savedProgress.checked;
        findings = savedProgress.findings;
        const wait = Number(savedProgress.notBefore ?? 0) - Date.now();
        if (wait > 0) {
            process.stderr.write(`respecting saved rate-limit wait of ${wait}ms\n`);
            await new Promise((resolve) => setTimeout(resolve, wait));
        }
        process.stderr.write(`resuming ${checked}/${handles.length}, findings ${findings.length}\n`);
    }
    const seen = new Set(handles.map((h) => h.name));
    if (!resume) await waitForProvider('api');
    for (let page = 1; !resume && handles.length < maxHandles; page++) {
        const url = `${apiBase}/handles?page=${page}&sort=asc&records_per_page=${pageSize}`;
        let response: Response;
        for (;;) {
            const result = await limiter.request(() => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) }), {
                minIntervalMs: 200, onWait: (until) => rememberWait('api', until)
            });
            response = result.response;
            if (response.status !== 429) break;
            if (result.headerWait === undefined || result.headerWait <= 0) {
                backoff('api');
                await waitForProvider('api');
            } else {
                process.stderr.write(`API rate limited; waiting ${result.headerWait}ms before resuming\n`);
            }
        }
        if (!response.ok) throw new Error(`API page ${page}: HTTP ${response.status}`);
        clearBackoff('api');
        const result: unknown = await response.json();
        if (!Array.isArray(result)) throw new Error(`API page ${page}: expected an array`);
        if (!result.length) { ended = true; break; }
        if (page % 25 === 0) process.stderr.write(`enumerated ${handles.length + result.length} records (page ${page})\n`);
        for (const h of result) {
            if (!h || typeof h.name !== 'string' || typeof h.policy !== 'string' || typeof h.hex !== 'string' || typeof h.utxo !== 'string' || !h.utxo) {
                throw new Error(`API page ${page}: handle missing ownership identity or UTxO`);
            }
            if (seen.has(h.name)) throw new Error(`API pagination repeated ${h.name}; results are not a consistent enumeration`);
            seen.add(h.name);
            handles.push(h);
            if (handles.length >= maxHandles) break;
        }
    }
    if (!resume && checkpoint && progress) {
        save(checkpoint, { checkpointId, network, api: apiBase, ended, handles });
        save(progress, { checkpointId, checked, findings });
    }
    await waitForProvider('koios');
    for (let i = checked; i < handles.length; i += batchSize) {
        const batch = handles.slice(i, i + batchSize);
        let rows: Awaited<ReturnType<typeof fetchKoios>>;
        for (;;) {
            try {
                rows = await fetchKoios('asset_utxos', 'POST', JSON.stringify({ _asset_list: batch.map((h) => [h.policy, h.hex]), _extended: true }), {
                    minIntervalMs: 250, onWait: (until) => rememberWait('koios', until)
                });
                break;
            } catch (error: any) {
                // The shared limiter retains the server's wait across the next request.
                // Without a stated wait, stop with the last completed batch preserved.
                if (error?.status !== 429) throw error;
                if (!Number.isFinite(error.retryAfterMs) || error.retryAfterMs <= 0) {
                    backoff('koios');
                    await waitForProvider('koios');
                } else {
                    if (progress) save(progress, { checkpointId, checked, findings, notBefore: Date.now() + error.retryAfterMs });
                    process.stderr.write(`rate limited; waiting ${error.retryAfterMs}ms before resuming\n`);
                }
            }
        }
        clearBackoff('koios');
        if (!Array.isArray(rows) || rows.some((r) => !r || typeof r.tx_hash !== 'string' || !Number.isInteger(r.tx_index) || !Array.isArray(r.asset_list))) {
            throw new Error(`Invalid asset_utxos response at batch ${i / batchSize + 1}`);
        }
        findings.push(...compareBatch(batch, rows));
        checked = i + batch.length;
        if (progress) save(progress, { checkpointId, checked, findings });
        if ((i / batchSize) % 50 === 0) process.stderr.write(`checked ${checked}/${handles.length}, findings ${findings.length}\n`);
    }
    const report = { network, api: apiBase, checked: handles.length, enumerationEnded: ended, sampled: !ended,
        caveat: 'Live pagination is not a snapshot; missing API records are not checked. Recheck findings before repair.', findings };
    const json = JSON.stringify(report, null, 2) + '\n';
    if (output) writeFileSync(output, json);
    else process.stdout.write(json);
    if (findings.some((f) => f.status === 'unresolved')) process.exitCode = 2;
}

