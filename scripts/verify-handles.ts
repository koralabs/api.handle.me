/**
 * verify-handles.ts
 *
 * Full-chain handle verification. Iterates every handle in the API, queries
 * Koios asset_utxos to get the canonical on-chain UTxO, and compares against
 * the stored `utxo` field. Reports any stale handles where stored ≠ canonical.
 *
 * Usage:
 *   NETWORK=mainnet npx tsx scripts/verify-handles.ts [--output stale.json]
 *
 * Env:
 *   API_BASE               — defaults to https://api.handle.me (or preprod/preview)
 *   NETWORK                — mainnet | preprod | preview (used for API_BASE default)
 *   KOIOS_API_BEARER_TOKEN — for Koios rate-limit bypass
 *   MAX_HANDLES            — cap number of handles processed (for testing)
 *   START_SLOT             — only check handles with updated_slot_number >= this
 *
 * Output (JSON to stdout or --output file):
 *   [{ name, hex, policy, stored_tx, stored_slot, canonical_tx, canonical_block }]
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { fetchKoios } from '../utils/helpers';

interface StaleHandle {
    name: string;
    hex: string;
    policy: string;
    stored_tx: string;
    stored_slot: number;
    canonical_tx: string;
    canonical_block: number;
}

const NETWORK = (process.env.NETWORK ?? 'preview').toLowerCase();
const API_BASE = process.env.API_BASE
    ?? (NETWORK === 'mainnet' ? 'https://api.handle.me'
        : `https://${NETWORK}.api.handle.me`);
const MAX_HANDLES = Number(process.env.MAX_HANDLES ?? Infinity);
const START_SLOT = Number(process.env.START_SLOT ?? 0);
const HANDLE_POLICY = 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a';

const ASSET_UTXOS_BATCH = 20;
const ASSET_UTXOS_RPS = 6;
const ASSET_UTXOS_INTERVAL_MS = Math.ceil(1000 / ASSET_UTXOS_RPS);
const API_PAGE_SIZE = 250;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const getOutputArg = (): string | null => {
    const idx = process.argv.indexOf('--output');
    return idx > 0 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
};

const getRepairArgs = (): { endpoint: string; apiKey: string; chunkSize: number } | null => {
    if (!process.argv.includes('--repair')) return null;
    const endpoint = process.env.SCANNER_REPAIR_URL;
    const apiKey = process.env.SCANNER_REPAIR_API_KEY;
    if (!endpoint || !apiKey) {
        console.error('ERROR: --repair requires SCANNER_REPAIR_URL and SCANNER_REPAIR_API_KEY env vars');
        process.exit(1);
    }
    const chunkIdx = process.argv.indexOf('--repair-chunk-size');
    const chunkSize = chunkIdx > 0 && process.argv[chunkIdx + 1]
        ? Math.max(1, Number(process.argv[chunkIdx + 1]))
        : 100;
    return { endpoint, apiKey, chunkSize };
};

const repairStaleHandles = async (stale: StaleHandle[], config: { endpoint: string; apiKey: string; chunkSize: number }) => {
    console.error(`\n=== Repairing ${stale.length} stale handles in chunks of ${config.chunkSize} ===`);
    const url = config.endpoint.replace(/\/$/, '') + '/repair-handles';
    let totalRepaired = 0;
    let totalNotFound = 0;
    for (let i = 0; i < stale.length; i += config.chunkSize) {
        const chunk = stale.slice(i, i + config.chunkSize);
        const handles = chunk.map((s) => s.name);
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'api-key': config.apiKey
            },
            body: JSON.stringify({ handles })
        });
        if (!resp.ok) {
            console.error(`  chunk ${i}: repair failed ${resp.status} ${await resp.text()}`);
            continue;
        }
        const result = (await resp.json()) as { checked: number; repaired: number; notFound: number };
        totalRepaired += result.repaired;
        totalNotFound += result.notFound;
        process.stderr.write(
            `\r  chunk ${Math.min(i + config.chunkSize, stale.length)}/${stale.length} · total repaired=${totalRepaired} notFound=${totalNotFound}`
        );
    }
    process.stderr.write('\n');
    console.error(`Repair complete: repaired=${totalRepaired} notFound=${totalNotFound}`);
};

interface ApiHandle {
    name: string;
    hex: string;
    policy: string;
    utxo: string;
    updated_slot_number: number;
}

const fetchAllHandles = async (): Promise<ApiHandle[]> => {
    const all: ApiHandle[] = [];
    let page = 1;
    const slotFilter = START_SLOT > 0 ? `&slot_number=${START_SLOT}` : '';

    while (all.length < MAX_HANDLES) {
        const url = `${API_BASE}/handles?page=${page}&sort=asc&records_per_page=${API_PAGE_SIZE}${slotFilter}`;
        const resp = await fetch(url);
        if (!resp.ok) {
            console.error(`page ${page} failed: ${resp.status}`);
            break;
        }
        const data = (await resp.json()) as any[];
        if (!data.length) break;

        for (const h of data) {
            all.push({
                name: h.name,
                hex: h.hex,
                policy: h.policy ?? HANDLE_POLICY,
                utxo: h.utxo,
                updated_slot_number: h.updated_slot_number
            });
            if (all.length >= MAX_HANDLES) break;
        }
        process.stderr.write(`\rfetched ${all.length} handles (page ${page})`);
        if (data.length < API_PAGE_SIZE) break;
        if (all.length >= MAX_HANDLES) break;
        page++;
        await delay(150);
    }
    process.stderr.write('\n');
    return all;
};

const verifyBatch = async (batch: ApiHandle[]): Promise<StaleHandle[]> => {
    const assetList: [string, string][] = batch.map((h) => [h.policy, h.hex]);
    let koiosResults: any[] = [];
    try {
        koiosResults = (await fetchKoios(
            'asset_utxos',
            'POST',
            JSON.stringify({ _asset_list: assetList, _extended: true })
        )) as any[];
    } catch (e: any) {
        console.error(`koios batch error: ${e?.message ?? e}`);
        return [];
    }

    // Build canonical map: asset_hex → { tx_hash, block_height }
    const canonicalByHex = new Map<string, { tx: string; block: number }>();
    for (const u of koiosResults) {
        for (const a of u.asset_list ?? []) {
            if (a.policy_id === HANDLE_POLICY) {
                canonicalByHex.set(a.asset_name, { tx: u.tx_hash, block: u.block_height });
            }
        }
    }

    const stale: StaleHandle[] = [];
    for (const h of batch) {
        const storedTx = h.utxo?.split('#')[0];
        const canonical = canonicalByHex.get(h.hex);
        if (!canonical) continue; // not found on-chain — could be burned/transferred off-policy
        if (storedTx && storedTx !== canonical.tx) {
            stale.push({
                name: h.name,
                hex: h.hex,
                policy: h.policy,
                stored_tx: storedTx,
                stored_slot: h.updated_slot_number,
                canonical_tx: canonical.tx,
                canonical_block: canonical.block
            });
        }
    }
    return stale;
};

const run = async () => {
    console.error(`=== Handle Verification: ${NETWORK} ===`);
    console.error(`API base: ${API_BASE}`);
    console.error(`Start slot: ${START_SLOT}, max handles: ${MAX_HANDLES === Infinity ? 'all' : MAX_HANDLES}`);

    const handles = await fetchAllHandles();
    console.error(`\nFetched ${handles.length} handles. Verifying against Koios asset_utxos...`);

    const stale: StaleHandle[] = [];
    let lastProgressLog = Date.now();

    for (let i = 0; i < handles.length; i += ASSET_UTXOS_BATCH) {
        const batch = handles.slice(i, i + ASSET_UTXOS_BATCH);
        const batchStale = await verifyBatch(batch);
        stale.push(...batchStale);

        if (Date.now() - lastProgressLog > 2000) {
            process.stderr.write(
                `\rchecked ${Math.min(i + ASSET_UTXOS_BATCH, handles.length)}/${handles.length} · stale=${stale.length}`
            );
            lastProgressLog = Date.now();
        }
        await delay(ASSET_UTXOS_INTERVAL_MS);
    }
    process.stderr.write('\n');

    console.error(`\n=== RESULTS ===`);
    console.error(`Total checked:  ${handles.length}`);
    console.error(`Stale handles:  ${stale.length} (${((stale.length / handles.length) * 100).toFixed(3)}%)`);

    if (stale.length) {
        console.error(`\nBy canonical block (top 20):`);
        const byBlock = new Map<number, number>();
        for (const s of stale) byBlock.set(s.canonical_block, (byBlock.get(s.canonical_block) ?? 0) + 1);
        const sortedBlocks = [...byBlock].sort((a, b) => b[1] - a[1]).slice(0, 20);
        for (const [block, count] of sortedBlocks) {
            console.error(`  block ${block}: ${count} stale`);
        }
    }

    const outputPath = getOutputArg();
    const jsonOutput = JSON.stringify(stale, null, 2);
    if (outputPath) {
        writeFileSync(outputPath, jsonOutput);
        console.error(`\nWrote ${stale.length} stale handles to ${outputPath}`);
    } else if (!getRepairArgs()) {
        process.stdout.write(jsonOutput);
    }

    const repairConfig = getRepairArgs();
    if (repairConfig && stale.length) {
        await repairStaleHandles(stale, repairConfig);
    }
};

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
