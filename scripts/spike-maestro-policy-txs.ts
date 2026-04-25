import 'dotenv/config';
import { HANDLE_POLICIES, Network } from '@koralabs/kora-labs-common';

// Validation spike: prove that Maestro's /policy/{policy}/transactions returns
// the same set of handle-touching tx_hashes as the current scanner path
// (Blockfrost blocks/next + Koios block_txs + Koios tx_info filter).
//
// READ-ONLY. No Redis writes. No state mutation. Run any time.
//
// env:
//   NETWORK              mainnet | preview | preprod   (default mainnet)
//   SPIKE_BLOCKS_BEHIND  blocks back from tip          (default 100)
//   SPIKE_WINDOW_BLOCKS  block count to sample         (default 200)

const NETWORK = ((process.env.NETWORK || 'mainnet').toLowerCase()) as Network;
const BLOCKS_BEHIND_TIP = Number(process.env.SPIKE_BLOCKS_BEHIND ?? 100);
const WINDOW_BLOCKS = Number(process.env.SPIKE_WINDOW_BLOCKS ?? 200);

const KOIOS_TOKEN = (process.env.KOIOS_API_BEARER_TOKEN ?? '').replace(/^['"]|['"]$/g, '');
const MAESTRO_KEY = (process.env.MAESTRO_API_KEY ?? '').replace(/^['"]|['"]$/g, '');
const BF_KEY = (process.env.BLOCKFROST_API_KEY ?? '').replace(/^['"]|['"]$/g, '');

if (!KOIOS_TOKEN) throw new Error('KOIOS_API_BEARER_TOKEN required');
if (!MAESTRO_KEY) throw new Error('MAESTRO_API_KEY required');
if (!BF_KEY) throw new Error('BLOCKFROST_API_KEY required');

const KOIOS_BASE = `https://${NETWORK === 'mainnet' ? 'api' : NETWORK}.koios.rest/api/v1`;
const BF_BASE = `https://cardano-${NETWORK}.blockfrost.io/api/v0`;
const MAESTRO_BASE = `https://${NETWORK}.gomaestro-api.org/v1`;

const POLICIES: string[] = Object.entries(HANDLE_POLICIES[NETWORK] ?? {})
    .filter(([, v]) => v && typeof v === 'object' && 'firstMintingSlot' in v)
    .map(([k]) => k);

if (POLICIES.length === 0) throw new Error(`No handle policies configured for ${NETWORK}`);

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const koios = async (path: string, init: { method?: string; body?: string } = {}): Promise<any> => {
    const r = await fetch(`${KOIOS_BASE}/${path}`, {
        method: init.method ?? 'GET',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KOIOS_TOKEN}` },
        body: init.body,
        signal: AbortSignal.timeout(60_000)
    });
    if (!r.ok) throw new Error(`koios ${path} ${r.status}: ${(await r.text()).slice(0, 256)}`);
    return r.json();
};

const blockfrost = async (path: string): Promise<any> => {
    const r = await fetch(`${BF_BASE}/${path}`, { headers: { project_id: BF_KEY }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`blockfrost ${path} ${r.status}: ${(await r.text()).slice(0, 256)}`);
    return r.json();
};

const maestro = async (path: string): Promise<any> => {
    const r = await fetch(`${MAESTRO_BASE}/${path}`, { headers: { 'api-key': MAESTRO_KEY }, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`maestro ${path} ${r.status}: ${(await r.text()).slice(0, 256)}`);
    return r.json();
};

interface BlockMeta { hash: string; height: number; slot: number; }
interface MaestroRow { tx_hash: string; slot: number; assets: string[]; }

const fetchWindowBlocks = async (startHeight: number, count: number): Promise<BlockMeta[]> => {
    // Blockfrost blocks/{height}/next paginates 100 per call.
    const out: BlockMeta[] = [];
    let from = startHeight;
    while (out.length < count) {
        const need = Math.min(100, count - out.length);
        const page = await blockfrost(`blocks/${from}/next?count=${need}`);
        if (!Array.isArray(page) || page.length === 0) break;
        for (const b of page) out.push({ hash: b.hash, height: b.height, slot: b.slot });
        from = page[page.length - 1].height;
    }
    return out;
};

// Path A — current scanner approach. Returns tx_hashes that touch any handle policy.
const pathA_currentScanner = async (blocks: BlockMeta[]): Promise<{ txHashes: Set<string>; calls: { blockTxs: number; txInfo: number }; ms: number; allTxCount: number; }> => {
    const t0 = Date.now();
    const calls = { blockTxs: 0, txInfo: 0 };

    // 1. block_txs in batches (POST takes _block_hashes array)
    const blockHashes = blocks.map((b) => b.hash);
    const allTxHashes: string[] = [];
    const BLOCK_TXS_BATCH = 30;
    for (let i = 0; i < blockHashes.length; i += BLOCK_TXS_BATCH) {
        const batch = blockHashes.slice(i, i + BLOCK_TXS_BATCH);
        const rows = await koios('block_txs', { method: 'POST', body: JSON.stringify({ _block_hashes: batch }) }) as { tx_hash: string }[];
        for (const r of rows) allTxHashes.push(r.tx_hash);
        calls.blockTxs++;
        await delay(170); // ~6 RPS, matches scanner cadence
    }
    const allTxCount = allTxHashes.length;

    // 2. tx_info with minimal flags (just _assets) to determine handle-touching set
    const policySet = new Set(POLICIES);
    const handleTxHashes = new Set<string>();
    const TX_INFO_BATCH = 35;
    for (let i = 0; i < allTxHashes.length; i += TX_INFO_BATCH) {
        const batch = allTxHashes.slice(i, i + TX_INFO_BATCH);
        const body = JSON.stringify({
            _tx_hashes: batch,
            _inputs: false, _withdrawals: false, _certs: false, _governance: false,
            _scripts: false, _bytecode: false, _metadata: false, _assets: true
        });
        const txs = await koios('tx_info', { method: 'POST', body }) as Array<{
            tx_hash: string;
            assets_minted?: Array<{ policy_id: string; asset_name: string }>;
            outputs?: Array<{ asset_list?: Array<{ policy_id: string; asset_name: string }> }>;
        }>;
        for (const tx of txs ?? []) {
            const minted = tx.assets_minted?.some((a) => policySet.has(a.policy_id));
            const inOutput = tx.outputs?.some((o) => o.asset_list?.some((a) => policySet.has(a.policy_id)));
            if (minted || inOutput) handleTxHashes.add(tx.tx_hash);
        }
        calls.txInfo++;
        await delay(170);
    }

    return { txHashes: handleTxHashes, calls, ms: Date.now() - t0, allTxCount };
};

// Path B — Maestro policy-tx discovery.
const pathB_maestro = async (startSlot: number, endSlot: number): Promise<{ txHashes: Set<string>; calls: number; ms: number; rawCount: number; namelessCount: number; perPolicy: Record<string, { rows: number; pages: number }>; firstSlots: Record<string, number | null>; }> => {
    const t0 = Date.now();
    let calls = 0;
    let rawCount = 0;
    let namelessCount = 0;
    const txHashes = new Set<string>();
    const perPolicy: Record<string, { rows: number; pages: number }> = {};
    const firstSlots: Record<string, number | null> = {};

    for (const policy of POLICIES) {
        perPolicy[policy] = { rows: 0, pages: 0 };
        firstSlots[policy] = null;
        let cursor: string | null = null;
        let stop = false;
        while (!stop) {
            const qs: string[] = ['count=100', 'order=asc'];
            if (cursor) qs.push(`cursor=${encodeURIComponent(cursor)}`);
            else qs.push(`from=${startSlot}`);
            const resp = await maestro(`policy/${policy}/transactions?${qs.join('&')}`) as { data: MaestroRow[]; next_cursor: string | null; };
            calls++;
            perPolicy[policy].pages++;
            const rows = resp.data ?? [];
            for (const row of rows) {
                if (firstSlots[policy] === null) firstSlots[policy] = row.slot;
                if (row.slot > endSlot) { stop = true; break; }
                rawCount++;
                perPolicy[policy].rows++;
                const assets = row.assets ?? [];
                const allNameless = assets.length > 0 && assets.every((a) => a === '');
                if (allNameless) { namelessCount++; continue; }
                txHashes.add(row.tx_hash);
            }
            if (!resp.next_cursor) stop = true;
            cursor = resp.next_cursor;
            await delay(125); // ~8 RPS
        }
    }
    return { txHashes, calls, ms: Date.now() - t0, rawCount, namelessCount, perPolicy, firstSlots };
};

const fmtMs = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

(async () => {
    console.log(`spike-maestro-policy-txs — NETWORK=${NETWORK}`);
    console.log(`policies: ${POLICIES.join(', ')}`);

    // Pick window: end at (tip - BLOCKS_BEHIND_TIP), span WINDOW_BLOCKS
    const tip = await blockfrost('blocks/latest') as { hash: string; height: number; slot: number };
    const endHeight = tip.height - BLOCKS_BEHIND_TIP;
    const startHeight = endHeight - WINDOW_BLOCKS;
    console.log(`tip: height=${tip.height} slot=${tip.slot}`);
    console.log(`window: heights ${startHeight}..${endHeight} (${WINDOW_BLOCKS} blocks, ${BLOCKS_BEHIND_TIP} back from tip)`);

    // Fetch window block list once for both paths
    const blocks = await fetchWindowBlocks(startHeight, WINDOW_BLOCKS);
    if (blocks.length === 0) throw new Error('no blocks fetched');
    const startSlot = blocks[0].slot;
    const endSlot = blocks[blocks.length - 1].slot;
    console.log(`window slot range: ${startSlot}..${endSlot} (${blocks.length} blocks fetched)`);

    console.log('\n--- Path A: current scanner (block_txs + tx_info filter) ---');
    const A = await pathA_currentScanner(blocks);
    console.log(`  block_txs calls: ${A.calls.blockTxs}`);
    console.log(`  tx_info calls:   ${A.calls.txInfo}`);
    console.log(`  total txs in window: ${A.allTxCount}`);
    console.log(`  handle-touching tx_hashes: ${A.txHashes.size}`);
    console.log(`  elapsed: ${fmtMs(A.ms)}`);

    console.log('\n--- Path B: Maestro policy-tx discovery ---');
    const B = await pathB_maestro(startSlot, endSlot);
    console.log(`  Maestro calls: ${B.calls}`);
    for (const p of POLICIES) {
        console.log(`  ${p.slice(0, 10)}…  pages=${B.perPolicy[p].pages} rows=${B.perPolicy[p].rows} firstSlot=${B.firstSlots[p]}`);
    }
    console.log(`  raw rows: ${B.rawCount}`);
    console.log(`  nameless-only rows (filtered out): ${B.namelessCount}`);
    console.log(`  handle-touching tx_hashes: ${B.txHashes.size}`);
    console.log(`  elapsed: ${fmtMs(B.ms)}`);

    console.log('\n--- Diff ---');
    const inAOnly = [...A.txHashes].filter((h) => !B.txHashes.has(h));
    const inBOnly = [...B.txHashes].filter((h) => !A.txHashes.has(h));
    const inBoth = [...A.txHashes].filter((h) => B.txHashes.has(h));
    console.log(`  in both:        ${inBoth.length}`);
    console.log(`  in A only (MISSED by Maestro — correctness fail if any): ${inAOnly.length}`);
    if (inAOnly.length > 0) {
        console.log(`    samples: ${inAOnly.slice(0, 10).join(', ')}${inAOnly.length > 10 ? ` (+${inAOnly.length - 10})` : ''}`);
    }
    console.log(`  in B only (extra from Maestro — investigate): ${inBOnly.length}`);
    if (inBOnly.length > 0) {
        console.log(`    samples: ${inBOnly.slice(0, 10).join(', ')}${inBOnly.length > 10 ? ` (+${inBOnly.length - 10})` : ''}`);
    }

    console.log('\n--- Slot semantics check ---');
    for (const p of POLICIES) {
        const fs = B.firstSlots[p];
        if (fs === null) { console.log(`  ${p.slice(0, 10)}…  no rows returned`); continue; }
        const cmp = fs === startSlot ? 'INCLUSIVE (== from)' : fs > startSlot ? `EXCLUSIVE-or-no-activity-at-boundary (first slot ${fs} > from ${startSlot}, delta ${fs - startSlot})` : `BEFORE WINDOW? (first slot ${fs} < from ${startSlot})`;
        console.log(`  ${p.slice(0, 10)}…  first slot returned ${fs}  vs from=${startSlot}  →  ${cmp}`);
    }

    console.log('\n--- Verdict ---');
    if (inAOnly.length === 0) {
        console.log('  PASS: Maestro returned every handle-touching tx that the current scanner path identified.');
    } else {
        console.log(`  FAIL: ${inAOnly.length} txs are missing from Maestro. Investigate before proceeding.`);
        process.exit(2);
    }
})().catch((e) => { console.error(e); process.exit(1); });
