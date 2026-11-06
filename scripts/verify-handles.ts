/**
 * Read-only comparison of API ownership-token UTxOs with Koios.
 * NETWORK=mainnet npx tsx scripts/verify-handles.ts --output tmp/handle-audit.json
 * MAX_HANDLES may limit a sample. A paginated live API is not a chain snapshot;
 * recheck every finding before any repair. This does not detect missing API records.
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { fetchKoios } from '../utils/helpers';
import { createProviderLimiter } from '../utils/koiosRateLimit';
import { ApiHandle, Finding, compareBatch } from './handle-audit';

const network = (process.env.NETWORK ?? 'preview').toLowerCase();
const apiBase = process.env.API_BASE ?? (network === 'mainnet' ? 'https://api.handle.me' : `https://${network}.api.handle.me`);
const maxHandles = Number(process.env.MAX_HANDLES ?? Infinity);
const pageSize = 250;
const batchSize = 20;
const limiter = createProviderLimiter();

async function run() {
    if (!(maxHandles > 0)) throw new Error('MAX_HANDLES must be positive');
    const handles: ApiHandle[] = [];
    const seen = new Set<string>();
    let ended = false;
    for (let page = 1; handles.length < maxHandles; page++) {
        const url = `${apiBase}/handles?page=${page}&sort=asc&records_per_page=${pageSize}`;
        const { response } = await limiter.request(() => fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(30_000) }), { minIntervalMs: 200 });
        if (!response.ok) throw new Error(`API page ${page}: HTTP ${response.status}`);
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
    const findings: Finding[] = [];
    for (let i = 0; i < handles.length; i += batchSize) {
        const batch = handles.slice(i, i + batchSize);
        const rows = await fetchKoios('asset_utxos', 'POST', JSON.stringify({ _asset_list: batch.map((h) => [h.policy, h.hex]), _extended: true }), { minIntervalMs: 250 });
        if (!Array.isArray(rows) || rows.some((r) => !r || typeof r.tx_hash !== 'string' || !Number.isInteger(r.tx_index) || !Array.isArray(r.asset_list))) {
            throw new Error(`Invalid asset_utxos response at batch ${i / batchSize + 1}`);
        }
        findings.push(...compareBatch(batch, rows));
        if ((i / batchSize) % 50 === 0) process.stderr.write(`checked ${Math.min(i + batchSize, handles.length)}/${handles.length}, findings ${findings.length}\n`);
    }
    const report = { network, api: apiBase, checked: handles.length, enumerationEnded: ended, sampled: !ended,
        caveat: 'Live pagination is not a snapshot; missing API records are not checked. Recheck findings before repair.', findings };
    const outputIndex = process.argv.indexOf('--output');
    const json = JSON.stringify(report, null, 2) + '\n';
    if (outputIndex !== -1) {
        const path = process.argv[outputIndex + 1];
        if (!path) throw new Error('--output requires a path');
        writeFileSync(path, json);
    } else process.stdout.write(json);
    if (findings.some((f) => f.status === 'unresolved')) process.exitCode = 2;
}

run().catch((e) => { console.error(e); process.exitCode = 1; });
