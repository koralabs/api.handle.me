import 'dotenv/config';
import fs from 'fs';
import zlib from 'zlib';
import { Trie } from '@aiken-lang/merkle-patricia-forestry';
import { AssetNameLabel, HANDLE_POLICIES, MintingData, Network, UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import { checkNameLabel } from '@koralabs/kora-labs-common/utils/crypto';
import { decodeCborToJson } from '@koralabs/kora-labs-common/utils/cbor';
import { GHOST_HANDLES } from '../utils/snapshotVerification';
import { SnapshotVerification, VerifiedHandleFileContent } from '../utils/verifiedSnapshot';

// ---------- config ----------

const NETWORK = ((process.env.NETWORK || 'preview').toLowerCase()) as Network;

const KOIOS_HIGH = (process.env.KOIOS_API_BEARER_TOKEN ?? '').replace(/^['"]|['"]$/g, '');
const KOIOS_LOW = (process.env.KOIOS_API_BEARER_TOKEN_LOW ?? '').replace(/^['"]|['"]$/g, '');
const BF_HIGH = process.env.BLOCKFROST_API_KEY ?? '';
const BF_LOW = process.env.BLOCKFROST_API_KEY_LOW ?? '';

if (!KOIOS_HIGH) throw new Error('KOIOS_API_BEARER_TOKEN is required');
if (!BF_HIGH) throw new Error('BLOCKFROST_API_KEY is required');

const KOIOS_HIGH_RPS = Number(process.env.KOIOS_HIGH_RPS ?? 8);
const KOIOS_LOW_RPS = Number(process.env.KOIOS_LOW_RPS ?? 3);
const BF_HIGH_RPS = Number(process.env.BF_HIGH_RPS ?? 10);
const BF_LOW_RPS = Number(process.env.BF_LOW_RPS ?? 10);

const KOIOS_BASE = `https://${NETWORK === 'mainnet' ? 'api' : NETWORK}.koios.rest/api/v1`;
const BF_BASE = `https://cardano-${NETWORK}.blockfrost.io/api/v0`;

const MINTING_DATA_HANDLE_NAME = 'handle_root@handle_settings';
const MINTING_DATA_ASSET_HEX = `${AssetNameLabel.LBL_222}${Buffer.from(MINTING_DATA_HANDLE_NAME, 'utf8').toString('hex')}`;

const KOIOS_PAGE_SIZE = 1000;
const KOIOS_STAGGER_MS = 170;
const KOIOS_PARALLEL_PAGES = 16;

const KOIOS_ASSET_BATCH = 50;
const BF_ASSET_BATCH = 1;
const KOIOS_TX_INFO_BATCH = 35;

const SNAPSHOT_UTXO_SCHEMA_VERSION = Number(process.env.UTXO_SCHEMA_VERSION ?? 1);

// ---------- helpers ----------

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MAX_NETWORK_RETRIES = 5;
const isTransientError = (e: any): boolean => {
    const code = e?.cause?.code ?? e?.code;
    if (code === 'UND_ERR_SOCKET' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ENOTFOUND' || code === 'EAI_AGAIN') return true;
    const name = e?.name ?? e?.cause?.name;
    if (name === 'AbortError' || name === 'TimeoutError') return true;
    // Retriable HTTP errors: 5xx upstream problems + 429 rate limit.
    const msg = String(e?.message ?? '');
    if (/\b(429|500|502|503|504)\b/.test(msg)) return true;
    return false;
};

const withNetworkRetry = async <T>(_label: string, fn: () => Promise<T>): Promise<T> => {
    let attempt = 0;
    while (true) {
        try {
            return await fn();
        } catch (e: any) {
            if (!isTransientError(e) || attempt >= MAX_NETWORK_RETRIES) throw e;
            const backoff = 750 * Math.pow(2, attempt);
            await delay(backoff);
            attempt++;
        }
    }
};

const koiosFetch = async (path: string, init: { method?: string; body?: string; token?: string; timeoutMs?: number } = {}) => {
    const { method = 'GET', body, token = KOIOS_HIGH, timeoutMs = 60_000 } = init;
    return withNetworkRetry(`koios ${path}`, async () => {
        const r = await fetch(`${KOIOS_BASE}/${path}`, {
            method,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body,
            signal: AbortSignal.timeout(timeoutMs)
        });
        if (!r.ok) {
            throw new Error(`koios ${path} ${r.status}: ${(await r.text()).slice(0, 512)}`);
        }
        return r.json();
    });
};

const blockfrostFetch = async (path: string, token: string = BF_HIGH): Promise<any> => {
    return withNetworkRetry(`blockfrost ${path}`, async () => {
        const r = await fetch(`${BF_BASE}/${path}`, {
            headers: { project_id: token },
            signal: AbortSignal.timeout(30_000)
        });
        if (!r.ok) {
            throw new Error(`blockfrost ${path} ${r.status}: ${(await r.text()).slice(0, 512)}`);
        }
        return r.json();
    });
};

const listPolicies = (network: Network): string[] =>
    Object.entries(HANDLE_POLICIES[network])
        .filter(([, v]) => v && typeof v === 'object' && 'firstMintingSlot' in v)
        .map(([k]) => k);

// HANDLE_POLICIES.getActivePolicy(net, false) is broken upstream (undefined == false
// mismatch). Pick the non-DeMi policy directly.
const getMainPolicy = (network: Network): string => {
    const entry = Object.entries(HANDLE_POLICIES[network]).find(
        ([, v]) => v && typeof v === 'object' && 'firstMintingSlot' in v && !(v as { isDeMi?: boolean }).isDeMi
    );
    if (!entry) throw new Error(`No main (non-DeMi) policy configured for network ${network}`);
    return entry[0];
};

const extractMptRootFromConstructor0 = (decoded: any): string | undefined => {
    const raw = decoded?.constructor_0?.[0];
    if (typeof raw !== 'string') return undefined;
    const cleaned = raw.replace(/^0x/i, '').toLowerCase();
    return /^[0-9a-f]{64}$/.test(cleaned) ? cleaned : undefined;
};

// ---------- phase 1: start tips + on-chain MPT root ----------

interface StartTips {
    koiosTipSlot: number;
    koiosTipHash: string;
    blockfrostTipSlot: number;
    blockfrostTipHash: string;
    tStart: number;
    tStartHash: string;
    chainRootHash: string;
    chainRootTipSlot: number;
    chainRootProvider: 'koios' | 'blockfrost';
}

const fetchStartTips = async (): Promise<StartTips> => {
    const activePolicy = getMainPolicy(NETWORK);

    const [koiosTip, koiosProbe, bfTip] = await Promise.all([
        koiosFetch('tip') as Promise<any[]>,
        koiosFetch('asset_utxos', {
            method: 'POST',
            body: JSON.stringify({ _asset_list: [[activePolicy, MINTING_DATA_ASSET_HEX]], _extended: true })
        }) as Promise<any[]>,
        blockfrostFetch('blocks/latest')
    ]);

    const koiosTipEntry = Array.isArray(koiosTip) ? koiosTip[0] : koiosTip;
    const koiosTipSlot = Number(koiosTipEntry?.abs_slot);
    const koiosTipHash: string = koiosTipEntry?.hash ?? '';
    const blockfrostTipSlot = Number(bfTip?.slot);
    const blockfrostTipHash: string = bfTip?.hash ?? '';
    if (!Number.isFinite(koiosTipSlot) || !Number.isFinite(blockfrostTipSlot)) {
        throw new Error(`Tip fetch failed: koios=${koiosTipSlot} blockfrost=${blockfrostTipSlot}`);
    }

    // Koios returns inline_datum as { bytes: <cbor-hex>, value: { constructor, fields } }.
    // Use the raw bytes and decode via decodeCborToJson so the extractor sees the
    // same shape as Blockfrost's path.
    const koiosInlineCbor: string | undefined = koiosProbe?.[0]?.inline_datum?.bytes;
    const koiosDecoded = koiosInlineCbor ? decodeCborToJson({ cborString: koiosInlineCbor, schema: {} }) : undefined;
    let chainRootHash: string | undefined = extractMptRootFromConstructor0(koiosDecoded);
    let chainRootProvider: 'koios' | 'blockfrost' = 'koios';
    let chainRootTipSlot = koiosTipSlot;

    if (!chainRootHash) {
        // Blockfrost fallback: find the minting-data UTxO via /assets/{asset}/addresses
        // then read the tx's outputs and pull the inline_datum.
        const assetId = `${activePolicy}${MINTING_DATA_ASSET_HEX}`;
        const holders = await blockfrostFetch(`assets/${assetId}/addresses?count=1`) as { address: string }[];
        const holder = holders?.[0];
        if (!holder?.address) throw new Error('minting-data holder not found on Blockfrost');
        const utxos = await blockfrostFetch(`addresses/${encodeURIComponent(holder.address)}/utxos/${assetId}?count=1`) as any[];
        const u = utxos?.[0];
        if (!u) throw new Error('minting-data UTxO not found on Blockfrost');
        const inlineDatum: string | undefined = u.inline_datum;
        if (!inlineDatum) throw new Error('minting-data UTxO has no inline datum');
        const decoded = decodeCborToJson({ cborString: inlineDatum, schema: {} });
        chainRootHash = extractMptRootFromConstructor0(decoded);
        chainRootProvider = 'blockfrost';
        chainRootTipSlot = blockfrostTipSlot;
    }

    if (!chainRootHash) throw new Error('Could not extract MPT root from minting-data datum');

    const tStart = Math.min(koiosTipSlot, blockfrostTipSlot);
    const tStartHash = koiosTipSlot <= blockfrostTipSlot ? koiosTipHash : blockfrostTipHash;

    return {
        koiosTipSlot, koiosTipHash,
        blockfrostTipSlot, blockfrostTipHash,
        tStart, tStartHash,
        chainRootHash, chainRootTipSlot, chainRootProvider
    };
};

// ---------- phase 2: enumerate handle set (policy_asset_list, supply>0) ----------

interface PolicyAssetListRow { asset_name: string; total_supply: string }

const enumerateKoiosPolicy = async (policy: string): Promise<string[]> => {
    const fetchPage = (offset: number): Promise<PolicyAssetListRow[]> =>
        koiosFetch(`policy_asset_list?_asset_policy=${policy}&order=asset_name.asc&limit=${KOIOS_PAGE_SIZE}&offset=${offset}`) as Promise<PolicyAssetListRow[]>;

    const keep = (r: PolicyAssetListRow): boolean => BigInt(r.total_supply ?? '0') > 0n;

    const all: PolicyAssetListRow[] = [];
    const first = await fetchPage(0);
    all.push(...first);
    if (first.length < KOIOS_PAGE_SIZE) return all.filter(keep).map((r) => r.asset_name);

    let offset = KOIOS_PAGE_SIZE;
    let done = false;
    while (!done) {
        const promises: Promise<PolicyAssetListRow[]>[] = [];
        for (let i = 0; i < KOIOS_PARALLEL_PAGES; i++) {
            const o = offset + i * KOIOS_PAGE_SIZE;
            promises.push(delay(i * KOIOS_STAGGER_MS).then(() => fetchPage(o)));
        }
        const pages = await Promise.all(promises);
        for (const p of pages) {
            all.push(...p);
            if (p.length < KOIOS_PAGE_SIZE) done = true;
        }
        offset += KOIOS_PARALLEL_PAGES * KOIOS_PAGE_SIZE;
        process.stderr.write(`\r  koios ${policy.slice(0, 10)}… fetched ${all.length} assets`);
    }
    process.stderr.write('\n');
    return all.filter(keep).map((r) => r.asset_name);
};

// ---------- phase 2b: per-asset first-mint-tx (policy_asset_mints) ----------

interface PolicyAssetMintsRow {
    asset_name: string;
    minting_tx_hash: string;
    total_supply: string;
    mint_cnt: number;
    burn_cnt: number;
    creation_time: number;
}

const enumeratePolicyAssetMints = async (policy: string): Promise<PolicyAssetMintsRow[]> => {
    const fetchPage = (offset: number): Promise<PolicyAssetMintsRow[]> =>
        koiosFetch(`policy_asset_mints?_asset_policy=${policy}&order=asset_name.asc&limit=${KOIOS_PAGE_SIZE}&offset=${offset}`) as Promise<PolicyAssetMintsRow[]>;

    const all: PolicyAssetMintsRow[] = [];
    const first = await fetchPage(0);
    all.push(...first);
    if (first.length < KOIOS_PAGE_SIZE) return all;

    let offset = KOIOS_PAGE_SIZE;
    let done = false;
    while (!done) {
        const promises: Promise<PolicyAssetMintsRow[]>[] = [];
        for (let i = 0; i < KOIOS_PARALLEL_PAGES; i++) {
            const o = offset + i * KOIOS_PAGE_SIZE;
            promises.push(delay(i * KOIOS_STAGGER_MS).then(() => fetchPage(o)));
        }
        const pages = await Promise.all(promises);
        for (const p of pages) {
            all.push(...p);
            if (p.length < KOIOS_PAGE_SIZE) done = true;
        }
        offset += KOIOS_PARALLEL_PAGES * KOIOS_PAGE_SIZE;
        process.stderr.write(`\r  koios mints ${policy.slice(0, 10)}… fetched ${all.length} assets`);
    }
    process.stderr.write('\n');
    return all;
};

// ---------- phase 2c: asset_history fallback for multi-mint assets ----------

interface AssetHistoryMintTx { tx_hash: string; block_time: number; quantity: string }
const fetchAssetHistoryOne = async (policy: string, assetNameHex: string): Promise<AssetHistoryMintTx[]> => {
    const rows = await koiosFetch(`asset_history?_asset_policy=${policy}&_asset_name=${assetNameHex}`) as Array<{ minting_txs: AssetHistoryMintTx[] }>;
    return rows?.[0]?.minting_txs ?? [];
};

// ---------- phase 4: per-handle UTxO fetch across pools ----------

interface Pool {
    name: string;
    kind: 'koios' | 'blockfrost';
    token: string;
    rps: number;
    batchSize: number;
}

class RateLimiter {
    private nextStart = 0;
    constructor(private readonly intervalMs: number) {}
    async acquire() {
        const now = Date.now();
        const start = Math.max(now, this.nextStart);
        this.nextStart = start + this.intervalMs;
        const wait = start - now;
        if (wait > 0) await delay(wait);
    }
}

interface WorkItem {
    policy: string;
    assetNameHex: string;
    handleName: string;
    labelKey: 'lbl222' | 'lbl100' | 'lbl000' | 'lbl001' | 'legacy';
}

interface UtxoRecord {
    handleName: string;
    policy: string;
    assetNameHex: string;
    labelKey: WorkItem['labelKey'];
    txHash: string;
    txIndex: number;
    address: string;
    lovelace: string;
    blockHeight?: number;
    blockTime?: number;
    inlineDatumCbor?: string;
    datumHash?: string;
    referenceScriptHash?: string;
    referenceScriptCbor?: string;
    // Plutus language tag (`plutusV1` / `plutusV2` / `plutusV3`). Required so
    // /scripts can derive the right validator hash — without it, V3 scripts
    // were hashed as V2 and exposed at non-existent script addresses.
    referenceScriptType?: string;
    fetchedVia: 'koios' | 'blockfrost';
    poolName: string;
}

interface PoolStats {
    assetsAttempted: number;
    assetsFound: number;
    assetsMissing: number;
    calls: number;
    failures: number;
    notFound404s: number;
    elapsedMs: number;
}

const buildPools = (): Pool[] => {
    const pools: Pool[] = [];
    pools.push({ name: 'koios-high', kind: 'koios', token: KOIOS_HIGH, rps: KOIOS_HIGH_RPS, batchSize: KOIOS_ASSET_BATCH });
    if (KOIOS_LOW) pools.push({ name: 'koios-low', kind: 'koios', token: KOIOS_LOW, rps: KOIOS_LOW_RPS, batchSize: KOIOS_ASSET_BATCH });
    pools.push({ name: 'bf-high', kind: 'blockfrost', token: BF_HIGH, rps: BF_HIGH_RPS, batchSize: BF_ASSET_BATCH });
    if (BF_LOW) pools.push({ name: 'bf-low', kind: 'blockfrost', token: BF_LOW, rps: BF_LOW_RPS, batchSize: BF_ASSET_BATCH });
    return pools;
};

const workItemsFromAssets = (assetsByPolicy: Record<string, string[]>): WorkItem[] => {
    const items: WorkItem[] = [];
    for (const [policy, assets] of Object.entries(assetsByPolicy)) {
        for (const hex of assets) {
            if (!hex) continue;
            const { isCip67, assetLabel, name } = checkNameLabel(hex);
            if (isCip67) {
                if (assetLabel === AssetNameLabel.LBL_222) items.push({ policy, assetNameHex: hex, handleName: name, labelKey: 'lbl222' });
                else if (assetLabel === AssetNameLabel.LBL_100) items.push({ policy, assetNameHex: hex, handleName: name, labelKey: 'lbl100' });
                // LBL_000 (virtual subhandles) and LBL_001 (subhandle settings)
                // DO live in dedicated on-chain UTxOs — must fetch for parity.
                // They're Koios-only; Blockfrost 404s on these labels.
                else if (assetLabel === AssetNameLabel.LBL_000) items.push({ policy, assetNameHex: hex, handleName: name, labelKey: 'lbl000' });
                else if (assetLabel === AssetNameLabel.LBL_001) items.push({ policy, assetNameHex: hex, handleName: name, labelKey: 'lbl001' });
            } else {
                items.push({ policy, assetNameHex: hex, handleName: name, labelKey: 'legacy' });
            }
        }
    }
    return items;
};

const toKoiosRecords = (rows: any[], batch: WorkItem[], poolName: string): UtxoRecord[] => {
    const byAsset = new Map<string, WorkItem>();
    for (const w of batch) byAsset.set(`${w.policy}/${w.assetNameHex}`, w);

    const records: UtxoRecord[] = [];
    for (const r of rows ?? []) {
        if (r?.is_spent === true) continue;
        for (const a of (r.asset_list ?? [])) {
            const w = byAsset.get(`${a.policy_id}/${a.asset_name}`);
            if (!w) continue;
            records.push({
                handleName: w.handleName,
                policy: w.policy,
                assetNameHex: w.assetNameHex,
                labelKey: w.labelKey,
                txHash: r.tx_hash,
                txIndex: r.tx_index,
                address: r.address,
                lovelace: String(r.value ?? ''),
                blockHeight: r.block_height,
                blockTime: r.block_time,
                inlineDatumCbor: r.inline_datum?.bytes,
                datumHash: r.datum_hash ?? undefined,
                referenceScriptHash: r.reference_script?.hash,
                referenceScriptCbor: r.reference_script?.bytes,
                referenceScriptType: r.reference_script?.type,
                fetchedVia: 'koios',
                poolName
            });
        }
    }
    return records;
};

// Koios's asset_utxos enforces a 5120-byte body limit and returns 413 when a
// batch's assets serialize past it. @-subhandle names are long enough that a
// 50-item batch can hit the cap; the previous catch in runWorker logged the
// 413 and dropped the entire batch's work items, leaving e.g. 15 handles from
// the stale-preview list missing from the snapshot's utxos despite their
// minting data being present. Recursively halve the batch on 413 so every
// work item still ends up attempted.
const fetchUtxoBatchKoios = async (pool: Pool, batch: WorkItem[]): Promise<UtxoRecord[]> => {
    const body = JSON.stringify({
        _asset_list: batch.map((w) => [w.policy, w.assetNameHex]),
        _extended: true
    });
    try {
        const rows = await koiosFetch('asset_utxos', { method: 'POST', body, token: pool.token }) as any[];
        return toKoiosRecords(rows, batch, pool.name);
    } catch (e: any) {
        const msg = String(e?.message ?? '');
        if (/\b413\b/.test(msg) && batch.length > 1) {
            const mid = Math.ceil(batch.length / 2);
            const [left, right] = await Promise.all([
                fetchUtxoBatchKoios(pool, batch.slice(0, mid)),
                fetchUtxoBatchKoios(pool, batch.slice(mid))
            ]);
            return [...left, ...right];
        }
        throw e;
    }
};

// Koios `asset_utxos` rejects POST bodies > 5120 bytes with HTTP 413. A batch
// of 50 CIP-67 assets with long handle names (e.g. virtual subhandle UTF-8
// names) routinely overshoots that. Without this split-retry, every 413 batch
// silently dropped up to 50 items — manifesting later as MPT root mismatches
// (the snapshot's mintingData listed handles whose UTxOs never arrived in the
// snapshot, so the api index had fewer keys than the chain MPT).
const fetchUtxoBatchKoiosWithSplit = async (pool: Pool, batch: WorkItem[]): Promise<UtxoRecord[]> => {
    try {
        return await fetchUtxoBatchKoios(pool, batch);
    } catch (e: any) {
        const msg = String(e?.message ?? '');
        const isOversize = /\b413\b/.test(msg) || /Payload too large/i.test(msg);
        if (!isOversize || batch.length <= 1) throw e;
        const mid = Math.floor(batch.length / 2);
        const [a, b] = await Promise.all([
            fetchUtxoBatchKoiosWithSplit(pool, batch.slice(0, mid)),
            fetchUtxoBatchKoiosWithSplit(pool, batch.slice(mid))
        ]);
        return [...a, ...b];
    }
};

// Blockfrost has no /assets/{id}/utxos endpoint (confirmed against its OpenAPI
// spec). Two-call path: /assets/{asset}/addresses → /addresses/{addr}/utxos/{asset}.
//
// /addresses/.../utxos returns reference_script_hash but NOT the script bytes;
// when a handle's UTxO carries a reference script we must fetch the bytes via
// /scripts/{hash}/cbor so groupUtxosByOutput stores a complete `script` field
// downstream. Without this, any handle assigned to the Blockfrost pool during
// the 4-pool dispatch lands in the snapshot with script=null, and the api's
// /scripts index drops it (entries require handle.script.cbor). Concrete miss
// observed on preview demimnt1/2 + demimntmpt1/2 — Koios's asset_utxos returns
// reference_script.bytes for the same UTxO, so handles that happened to land
// in the Koios pool got cbor while Blockfrost-pool handles didn't.
const fetchUtxoBlockfrost = async (pool: Pool, work: WorkItem): Promise<UtxoRecord | null> => {
    const assetId = `${work.policy}${work.assetNameHex}`;
    const holders = await blockfrostFetch(`assets/${assetId}/addresses?count=1`, pool.token) as { address: string; quantity: string }[];
    const holder = holders?.[0];
    if (!holder?.address) return null;
    const utxos = await blockfrostFetch(`addresses/${encodeURIComponent(holder.address)}/utxos/${assetId}?count=1`, pool.token) as any[];
    const u = utxos?.[0];
    if (!u) return null;
    let referenceScriptCbor: string | undefined;
    if (u.reference_script_hash) {
        try {
            const cborResp = await blockfrostFetch(`scripts/${u.reference_script_hash}/cbor`, pool.token) as { cbor?: string };
            referenceScriptCbor = cborResp?.cbor;
        } catch (e: any) {
            // Surface the failure but don't abort the whole record — the
            // snapshot loader can still index the handle without a script,
            // and a later forward scan via Koios will populate it.
            console.error(`  ${pool.name} scripts/${u.reference_script_hash}/cbor failed: ${e?.message ?? e}`);
        }
    }
    return {
        handleName: work.handleName,
        policy: work.policy,
        assetNameHex: work.assetNameHex,
        labelKey: work.labelKey,
        txHash: u.tx_hash,
        txIndex: Number(u.tx_index ?? u.output_index),
        address: holder.address,
        lovelace: (u.amount ?? []).find((x: any) => x.unit === 'lovelace')?.quantity ?? '',
        blockHeight: u.block_height,
        inlineDatumCbor: u.inline_datum,
        // Blockfrost's /addresses/.../utxos field name is `data_hash`, not `datum_hash`.
        // Capture it so groupUtxosByOutput can carry the hash through to a Phase 4d
        // datum-bytes resolution pass for non-inline datums.
        datumHash: u.data_hash ?? undefined,
        referenceScriptHash: u.reference_script_hash,
        referenceScriptCbor,
        fetchedVia: 'blockfrost',
        poolName: pool.name
    };
};

// LBL_000/001 live in script UTxOs that Blockfrost's /assets/{id}/addresses
// doesn't index; Koios handles them fine. Split the queue.
const isBfCompatible = (w: WorkItem) => w.labelKey === 'lbl222' || w.labelKey === 'lbl100' || w.labelKey === 'legacy';

const runPhase4 = async (work: WorkItem[]): Promise<{ results: UtxoRecord[]; stats: Record<string, PoolStats>; pools: Pool[] }> => {
    const pools = buildPools();

    const sharedQueue = work.filter(isBfCompatible);
    const koiosOnlyQueue = work.filter((w) => !isBfCompatible(w));
    let sharedCursor = 0;
    let koiosOnlyCursor = 0;
    const takeBatch = (size: number, koiosOnly: boolean): WorkItem[] => {
        if (sharedCursor < sharedQueue.length) {
            const start = sharedCursor;
            const end = Math.min(start + size, sharedQueue.length);
            sharedCursor = end;
            return sharedQueue.slice(start, end);
        }
        if (!koiosOnly || koiosOnlyCursor >= koiosOnlyQueue.length) return [];
        const start = koiosOnlyCursor;
        const end = Math.min(start + size, koiosOnlyQueue.length);
        koiosOnlyCursor = end;
        return koiosOnlyQueue.slice(start, end);
    };
    const totalWork = work.length;
    const cursorDisplay = () => `shared ${sharedCursor}/${sharedQueue.length}, koios-only ${koiosOnlyCursor}/${koiosOnlyQueue.length}`;

    const results: UtxoRecord[] = [];
    const stats: Record<string, PoolStats> = {};

    // Fail-fast: any non-413 batch error or non-404 Blockfrost error throws
    // out of the worker, rejects Promise.all, and exits the script via the
    // top-level catch. No point spending more rate-limit budget once we know
    // the snapshot will be incomplete. 413s are already handled inside
    // fetchUtxoBatchKoios via recursive halving.
    const runPool = async (pool: Pool) => {
        const limiter = new RateLimiter(Math.ceil(1000 / pool.rps));
        const st: PoolStats = stats[pool.name] = { assetsAttempted: 0, assetsFound: 0, assetsMissing: 0, calls: 0, failures: 0, notFound404s: 0, elapsedMs: 0 };
        const poolStart = Date.now();
        const workerCount = Math.max(1, Math.min(16, pool.rps * 2));

        const runWorker = async () => {
            while (true) {
                const batch = takeBatch(pool.batchSize, pool.kind === 'koios');
                if (batch.length === 0) break;
                await limiter.acquire();
                st.calls++;
                st.assetsAttempted += batch.length;
                if (pool.kind === 'koios') {
                    const recs = await fetchUtxoBatchKoiosWithSplit(pool, batch);
                    results.push(...recs);
                    st.assetsFound += recs.length;
                    st.assetsMissing += Math.max(0, batch.length - recs.length);
                } else {
                    for (const w of batch) {
                        try {
                            const rec = await fetchUtxoBlockfrost(pool, w);
                            if (rec) {
                                results.push(rec);
                                st.assetsFound++;
                            } else {
                                st.assetsMissing++;
                            }
                        } catch (inner: any) {
                            if (/\b404\b/.test(String(inner?.message ?? ''))) {
                                st.notFound404s++;
                            } else {
                                throw new Error(`Phase 4: ${pool.name} asset ${w.assetNameHex.slice(0, 16)}… failed: ${inner?.message ?? inner}`);
                            }
                        }
                    }
                }
                if (st.calls % 10 === 0) {
                    process.stderr.write(
                        `\r  [phase4] ${cursorDisplay()} (total ${totalWork})  ` +
                        pools.map((p) => `${p.name}=${stats[p.name]?.assetsFound ?? 0}`).join(' ')
                    );
                }
            }
        };

        await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
        st.elapsedMs = Date.now() - poolStart;
    };

    await Promise.all(pools.map(runPool));
    process.stderr.write('\n');

    return { results, stats, pools };
};

// ---------- phase 4c: tx_info fetch ----------

interface TxInfoAssetMinted { policy_id: string; asset_name: string; quantity: string; fingerprint?: string }
interface TxInfoRow {
    tx_hash: string;
    absolute_slot: number;
    block_hash?: string;
    block_height?: number;
    block_time?: number;
    assets_minted?: TxInfoAssetMinted[];
    metadata?: Record<string, any> | null;
}

type TxInfoMap = Map<string, TxInfoRow>;

const fetchTxInfoBatchKoios = async (pool: Pool, hashes: string[]): Promise<TxInfoRow[]> => {
    // Koios tx_info defaults to _metadata=false and _assets=false. Must enable
    // both for snapshot parity.
    const body = JSON.stringify({
        _tx_hashes: hashes,
        _metadata: true,
        _assets: true,
        _inputs: false,
        _withdrawals: false,
        _certs: false,
        _scripts: false,
        _bytecode: false,
        _governance: false
    });
    return (await koiosFetch('tx_info', { method: 'POST', body, token: pool.token })) as TxInfoRow[];
};

const runPhase4c = async (txHashes: string[]): Promise<{ txInfo: TxInfoMap; stats: Record<string, PoolStats>; pools: Pool[] }> => {
    const pools: Pool[] = [{ name: 'koios-high', kind: 'koios', token: KOIOS_HIGH, rps: KOIOS_HIGH_RPS, batchSize: KOIOS_TX_INFO_BATCH }];
    if (KOIOS_LOW) pools.push({ name: 'koios-low', kind: 'koios', token: KOIOS_LOW, rps: KOIOS_LOW_RPS, batchSize: KOIOS_TX_INFO_BATCH });

    const queue = txHashes;
    let cursor = 0;
    const takeBatch = (size: number): string[] => {
        const start = cursor;
        const end = Math.min(cursor + size, queue.length);
        cursor = end;
        return start < end ? queue.slice(start, end) : [];
    };

    const txInfo: TxInfoMap = new Map();
    const stats: Record<string, PoolStats> = {};

    // Fail-fast: any throw out of fetchTxInfoBatchKoios propagates and aborts
    // the phase. A snapshot with missing tx_info rows would ship handles whose
    // minting history is incomplete — better to surface the upstream failure
    // and re-run than spend the remaining rate-limit budget on a dead phase.
    const runPool = async (pool: Pool) => {
        const limiter = new RateLimiter(Math.ceil(1000 / pool.rps));
        const st: PoolStats = stats[pool.name] = { assetsAttempted: 0, assetsFound: 0, assetsMissing: 0, calls: 0, failures: 0, notFound404s: 0, elapsedMs: 0 };
        const poolStart = Date.now();
        const workerCount = Math.max(1, Math.min(16, pool.rps * 2));

        const runWorker = async () => {
            while (true) {
                const batch = takeBatch(pool.batchSize);
                if (batch.length === 0) break;
                await limiter.acquire();
                st.calls++;
                st.assetsAttempted += batch.length;
                const rows = await fetchTxInfoBatchKoios(pool, batch);
                for (const row of rows ?? []) {
                    if (row?.tx_hash) txInfo.set(row.tx_hash, row);
                }
                st.assetsFound += rows?.length ?? 0;
                st.assetsMissing += Math.max(0, batch.length - (rows?.length ?? 0));
                if (st.calls % 10 === 0) {
                    process.stderr.write(
                        `\r  [phase4c] queue ${cursor}/${queue.length}  ` +
                        pools.map((p) => `${p.name}=${stats[p.name]?.assetsFound ?? 0}`).join(' ')
                    );
                }
            }
        };

        await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
        st.elapsedMs = Date.now() - poolStart;
    };

    await Promise.all(pools.map(runPool));
    process.stderr.write('\n');

    return { txInfo, stats, pools };
};

// ---------- phase 3: MPT build ----------

const buildRoot = async (names: Iterable<string>): Promise<string> => {
    const sorted = [...new Set([...names].map((h) => h.trim()).filter(Boolean))].sort();
    const trie = await Trie.fromList(sorted.map((h) => ({ key: h, value: '' })));
    return trie.hash?.toString('hex') ?? Buffer.alloc(32).toString('hex');
};

// ---------- phase 5: build snapshot ----------

interface MintSource {
    policy: string;
    assetNameHex: string;
    mintTxHash: string;
    mintCnt: number;
}

const extract721FromTxInfoMetadata = (metadata: Record<string, any> | null | undefined): any => {
    if (!metadata || typeof metadata !== 'object') return {};
    return metadata['721'] ?? {};
};

const filter721ForUtxo = (metadata721: any, policiesSet: Set<string>, utxoHandleNames: Set<string>): any => {
    if (!metadata721 || typeof metadata721 !== 'object') return {};
    const { version, ...policies } = metadata721;
    const filteredPolicies: Record<string, any> = {};
    for (const [policyId, assets] of Object.entries(policies ?? {})) {
        if (!policiesSet.has(policyId)) continue;
        if (!assets || typeof assets !== 'object') continue;
        const filteredAssets: Record<string, any> = {};
        for (const [assetName, value] of Object.entries(assets as any)) {
            const asUtf8 = assetName;
            const asFromHex = (() => { try { return Buffer.from(assetName, 'hex').toString('utf8'); } catch { return ''; } })();
            if (utxoHandleNames.has(asUtf8) || (asFromHex && utxoHandleNames.has(asFromHex))) {
                filteredAssets[assetName] = value;
            }
        }
        if (Object.keys(filteredAssets).length > 0) filteredPolicies[policyId] = filteredAssets;
    }
    if (Object.keys(filteredPolicies).length === 0) return {};
    return { '721': { ...filteredPolicies, ...(version && { version }) } };
};

const expandMultiMintSources = async (multiMintSources: MintSource[], existing: MintSource[]): Promise<MintSource[]> => {
    if (multiMintSources.length === 0) return [];
    const existingByAsset = new Map<string, Set<string>>();
    for (const s of existing) {
        const key = `${s.policy}/${s.assetNameHex}`;
        if (!existingByAsset.has(key)) existingByAsset.set(key, new Set());
        existingByAsset.get(key)!.add(s.mintTxHash);
    }
    const added: MintSource[] = [];
    for (const src of multiMintSources) {
        const events = await fetchAssetHistoryOne(src.policy, src.assetNameHex);
        const alreadyHave = existingByAsset.get(`${src.policy}/${src.assetNameHex}`) ?? new Set();
        for (const ev of events) {
            if (BigInt(ev.quantity ?? '0') <= 0n) continue;
            if (alreadyHave.has(ev.tx_hash)) continue;
            added.push({ policy: src.policy, assetNameHex: src.assetNameHex, mintTxHash: ev.tx_hash, mintCnt: src.mintCnt });
        }
    }
    return added;
};

const buildMintingData = (
    mintSources: MintSource[],
    handleNamesInSet: Set<string>,
    txInfo: TxInfoMap,
    policiesSet: Set<string>
): { [handle: string]: MintingData[] } => {
    // Null-prototype object so "constructor" / "__proto__" handle names don't
    // collide with Object.prototype members.
    const out: { [handle: string]: MintingData[] } = Object.create(null);
    for (const src of mintSources) {
        const { isCip67, assetLabel, name } = checkNameLabel(src.assetNameHex);
        const shouldIndexMint = isCip67
            ? assetLabel === AssetNameLabel.LBL_222 || assetLabel === AssetNameLabel.LBL_000
            : true;
        if (!shouldIndexMint) continue;
        if (!handleNamesInSet.has(name)) continue;

        const tx = txInfo.get(src.mintTxHash);
        if (!tx) continue;
        const metadata721 = extract721FromTxInfoMetadata(tx.metadata);
        const filtered = filter721ForUtxo(metadata721, policiesSet, new Set([name]));
        const md: MintingData = {
            created_slot: Number(tx.absolute_slot),
            metadata: filtered,
            txHash: src.mintTxHash
        };
        (out[name] ??= []).push(md);
    }
    // Sort each handle's mint events by created_slot ascending for parity with
    // the existing snapshot's chronological ordering.
    for (const name of Object.keys(out)) {
        out[name].sort((a, b) => a.created_slot - b.created_slot);
    }
    return out;
};

interface GroupedUtxo {
    txHash: string;
    txIndex: number;
    address: string;
    lovelace: string;
    blockHeight?: number;
    inlineDatumCbor?: string;
    datumHash?: string;
    referenceScriptCbor?: string;
    referenceScriptType?: string;
    handlesByPolicy: Map<string, Set<string>>;
}

// Multiple WorkItems can describe the same on-chain UTxO (e.g. LBL_222 + LBL_100
// in the same UTxO are two work items, sometimes dispatched to different pools).
// Each fetch path returns its own UtxoRecord; whichever lands in the group first
// used to set datum/script for the whole group, so a Blockfrost record whose
// /scripts/{hash}/cbor sub-fetch errored could shadow the Koios record that did
// have the bytes. Merge with `prev ?? incoming` so any non-null field wins.
const groupUtxosByOutput = (records: UtxoRecord[]): GroupedUtxo[] => {
    const byKey = new Map<string, GroupedUtxo>();
    for (const r of records) {
        const key = `${r.txHash}#${r.txIndex}`;
        let g = byKey.get(key);
        if (!g) {
            g = {
                txHash: r.txHash,
                txIndex: r.txIndex,
                address: r.address,
                lovelace: r.lovelace,
                blockHeight: r.blockHeight,
                inlineDatumCbor: r.inlineDatumCbor,
                datumHash: r.datumHash,
                referenceScriptCbor: r.referenceScriptCbor,
                referenceScriptType: r.referenceScriptType,
                handlesByPolicy: new Map()
            };
            byKey.set(key, g);
        } else {
            g.inlineDatumCbor = g.inlineDatumCbor ?? r.inlineDatumCbor;
            g.datumHash = g.datumHash ?? r.datumHash;
            g.referenceScriptCbor = g.referenceScriptCbor ?? r.referenceScriptCbor;
            g.blockHeight = g.blockHeight ?? r.blockHeight;
        }
        let set = g.handlesByPolicy.get(r.policy);
        if (!set) { set = new Set(); g.handlesByPolicy.set(r.policy, set); }
        set.add(r.assetNameHex);
    }
    return Array.from(byKey.values());
};

const buildUtxosWithTxInfo = (
    grouped: GroupedUtxo[],
    txInfo: TxInfoMap,
    policiesSet: Set<string>,
    datumByHash: Map<string, string>
): UTxOWithTxInfo[] => {
    return grouped.map((g) => {
        const tx = txInfo.get(g.txHash);
        const assetsInUtxo = new Set<string>();
        for (const assets of g.handlesByPolicy.values()) for (const a of assets) assetsInUtxo.add(a);

        const mintByPolicy = new Map<string, string[]>();
        const burnByPolicy = new Map<string, string[]>();
        if (tx?.assets_minted) {
            for (const a of tx.assets_minted) {
                if (!policiesSet.has(a.policy_id)) continue;
                const q = BigInt(a.quantity ?? '0');
                if (q > 0n) {
                    if (!assetsInUtxo.has(a.asset_name)) continue;
                    const list = mintByPolicy.get(a.policy_id) ?? mintByPolicy.set(a.policy_id, []).get(a.policy_id)!;
                    list.push(a.asset_name);
                } else if (q < 0n) {
                    if (!g.handlesByPolicy.has(a.policy_id)) continue;
                    const list = burnByPolicy.get(a.policy_id) ?? burnByPolicy.set(a.policy_id, []).get(a.policy_id)!;
                    list.push(a.asset_name);
                }
            }
        }

        const utxoHandleNamesUtf8 = new Set<string>();
        for (const assets of g.handlesByPolicy.values()) {
            for (const hex of assets) {
                const { name } = checkNameLabel(hex);
                utxoHandleNamesUtf8.add(name);
            }
        }
        const metadata = tx
            ? filter721ForUtxo(extract721FromTxInfoMetadata(tx.metadata), policiesSet, utxoHandleNamesUtf8)
            : {};

        // Datum resolution: prefer inline bytes, otherwise look up by hash. A
        // missing-from-datumByHash hash means Koios `datum_info` legitimately
        // had no row (e.g., the hash hasn't been resolved on chain) — leave
        // datum undefined and let the snapshot reflect that.
        const datum = g.inlineDatumCbor
            ?? (g.datumHash ? datumByHash.get(g.datumHash) : undefined);

        const utxo: UTxOWithTxInfo = {
            id: `${g.txHash}#${g.txIndex}`,
            tx_id: g.txHash,
            index: g.txIndex,
            blockHash: tx?.block_hash ?? '',
            blockNum: tx?.block_height ?? g.blockHeight ?? 0,
            slot: Number(tx?.absolute_slot ?? 0),
            address: g.address,
            lovelace: Number(g.lovelace || 0),
            datum,
            script: g.referenceScriptCbor ? { type: g.referenceScriptType ?? 'plutusV2', cbor: g.referenceScriptCbor } : undefined,
            handles: Array.from(g.handlesByPolicy.entries()).map(([p, set]) => [p, Array.from(set)]),
            mint: Array.from(mintByPolicy.entries()).map(([p, arr]) => [p, arr]),
            metadata
        };
        if (burnByPolicy.size > 0) {
            utxo.burn = Array.from(burnByPolicy.entries()).map(([p, arr]) => [p, arr]);
        }
        return utxo;
    });
};

interface BuildSnapshotArgs {
    computedRoot: string;
    tips: StartTips;
    utxoRecords: UtxoRecord[];
    mintSources: MintSource[];
    handleNamesInSet: Set<string>;
    txInfo: TxInfoMap;
    policiesSet: Set<string>;
    datumByHash: Map<string, string>;
}

const buildSnapshotFile = (args: BuildSnapshotArgs): VerifiedHandleFileContent => {
    const verification: SnapshotVerification = {
        verifiedAgainstChain: args.computedRoot === args.tips.chainRootHash,
        snapshotMptRootHash: args.computedRoot,
        chainMptRootHash: args.tips.chainRootHash,
        network: NETWORK,
        verifiedAtUtc: new Date().toISOString()
    };
    const grouped = groupUtxosByOutput(args.utxoRecords);
    const utxos = buildUtxosWithTxInfo(grouped, args.txInfo, args.policiesSet, args.datumByHash);
    const mintingData = buildMintingData(args.mintSources, args.handleNamesInSet, args.txInfo, args.policiesSet);

    return {
        slot: args.tips.tStart,
        hash: args.tips.tStartHash,
        utxoSchemaVersion: SNAPSHOT_UTXO_SCHEMA_VERSION,
        utxos,
        mintingData,
        verification
    };
};

const writeSnapshotGz = (snapshot: VerifiedHandleFileContent, outPath: string) => {
    const json = JSON.stringify(snapshot);
    fs.mkdirSync(outPath.replace(/\/[^/]+$/, ''), { recursive: true });
    fs.writeFileSync(outPath, zlib.deflateSync(json));
    fs.writeFileSync(outPath.replace(/\.gz$/, '.json'), json);
    return { bytes: json.length, gzBytes: fs.statSync(outPath).size };
};

// ---------- classification ----------

interface ClassifyBuckets {
    handleNames: Set<string>;
    keptLabel222: number;
    keptLabel000: number;
    keptLegacy: number;
    droppedLabel100: number;
    droppedLabel001: number;
    droppedOther: number;
}

const classifyAssetNames = (assetNames: Iterable<string>): ClassifyBuckets => {
    const b: ClassifyBuckets = {
        handleNames: new Set<string>(),
        keptLabel222: 0, keptLabel000: 0, keptLegacy: 0,
        droppedLabel100: 0, droppedLabel001: 0, droppedOther: 0
    };
    for (const hex of assetNames) {
        if (!hex) continue;
        const { isCip67, assetLabel, name } = checkNameLabel(hex);
        if (isCip67) {
            if (assetLabel === AssetNameLabel.LBL_222) { b.handleNames.add(name); b.keptLabel222++; }
            else if (assetLabel === AssetNameLabel.LBL_000) { b.handleNames.add(name); b.keptLabel000++; }
            else if (assetLabel === AssetNameLabel.LBL_100) b.droppedLabel100++;
            else if (assetLabel === AssetNameLabel.LBL_001) b.droppedLabel001++;
            else b.droppedOther++;
        } else {
            b.handleNames.add(name);
            b.keptLegacy++;
        }
    }
    return b;
};

// ---------- main ----------

const fmtMs = (ms: number) => `${(ms / 1000).toFixed(2)}s`;

(async () => {
    console.log(`Bootstrap from APIs — NETWORK=${NETWORK}`);
    const policies = listPolicies(NETWORK);
    console.log(`Policies: ${policies.join(', ')}`);

    // Phase 1
    const t1 = Date.now();
    console.log('\nPhase 1: start tips + on-chain MPT root');
    const tips = await fetchStartTips();
    console.log(`  Koios tip slot:       ${tips.koiosTipSlot}`);
    console.log(`  Blockfrost tip slot:  ${tips.blockfrostTipSlot}`);
    console.log(`  T_start:              ${tips.tStart} (${tips.koiosTipSlot <= tips.blockfrostTipSlot ? 'koios' : 'blockfrost'})`);
    console.log(`  On-chain MPT root:    ${tips.chainRootHash} (via ${tips.chainRootProvider} @ slot ${tips.chainRootTipSlot})`);
    console.log(`  [elapsed ${fmtMs(Date.now() - t1)}]`);

    // Phase 2
    const t2 = Date.now();
    console.log('\nPhase 2: enumerate handle set (Koios policy_asset_list)');
    const assetsByPolicy: Record<string, string[]> = {};
    const assetNames = new Set<string>();
    for (const p of policies) {
        const names = await enumerateKoiosPolicy(p);
        console.log(`  ${p.slice(0, 10)}…  ${names.length} assets`);
        assetsByPolicy[p] = names;
        for (const n of names) assetNames.add(n);
    }
    const classified = classifyAssetNames(assetNames);
    console.log(`  Classified: 222=${classified.keptLabel222} 000=${classified.keptLabel000} legacy=${classified.keptLegacy} | dropped 100=${classified.droppedLabel100} 001=${classified.droppedLabel001} other=${classified.droppedOther}`);
    console.log(`  Unique handle names (pre-ghost): ${classified.handleNames.size}`);
    console.log(`  [elapsed ${fmtMs(Date.now() - t2)}]`);

    // Phase 3
    const t3 = Date.now();
    console.log('\nPhase 3: build MPT + verify against on-chain root');
    const ghosts = GHOST_HANDLES[NETWORK] ?? [];
    console.log(`  Ghost handles (${ghosts.length}): ${ghosts.join(', ') || '<none>'}`);
    for (const g of ghosts) classified.handleNames.add(g);
    const computedRoot = await buildRoot(classified.handleNames);
    const match = computedRoot === tips.chainRootHash;
    console.log(`  Computed root: ${computedRoot}  handles=${classified.handleNames.size}`);
    console.log(`  On-chain root: ${tips.chainRootHash}`);
    console.log(`  ${match ? 'MATCH' : 'MISMATCH'}`);
    console.log(`  [elapsed ${fmtMs(Date.now() - t3)}]`);

    if (!match) {
        console.error('\nMPT root mismatch. Aborting.');
        console.log(`\nTotal: ${fmtMs(Date.now() - t1)}`);
        process.exit(2);
    }

    if (process.env.PHASE4 === '0') {
        console.log('\nPhase 4 skipped (PHASE4=0).');
        console.log(`\nTotal: ${fmtMs(Date.now() - t1)}`);
        return;
    }

    // Phase 4: per-handle UTxO fetch
    const t4 = Date.now();
    console.log('\nPhase 4: per-handle UTxO fetch (4-pool dispatch)');
    let work = workItemsFromAssets(assetsByPolicy);
    const maxItems = Number(process.env.PHASE4_MAX_ITEMS ?? 0);
    if (maxItems > 0 && work.length > maxItems) {
        console.log(`  PHASE4_MAX_ITEMS=${maxItems} — truncating from ${work.length}`);
        work = work.slice(0, maxItems);
    }
    console.log(`  Work items: ${work.length} (222=${work.filter((w) => w.labelKey === 'lbl222').length} 100=${work.filter((w) => w.labelKey === 'lbl100').length} 000=${work.filter((w) => w.labelKey === 'lbl000').length} 001=${work.filter((w) => w.labelKey === 'lbl001').length} legacy=${work.filter((w) => w.labelKey === 'legacy').length})`);
    const { results, stats, pools } = await runPhase4(work);
    console.log('\n  Per-pool stats:');
    for (const p of pools) {
        const s = stats[p.name];
        const effRps = s.calls > 0 ? (s.calls / (s.elapsedMs / 1000)).toFixed(2) : '0';
        console.log(`    ${p.name.padEnd(12)} rps=${p.rps} batch=${p.batchSize}  attempted=${s.assetsAttempted} found=${s.assetsFound} missing=${s.assetsMissing} 404s=${s.notFound404s} calls=${s.calls} fails=${s.failures} elapsed=${fmtMs(s.elapsedMs)} effRps=${effRps}`);
    }
    console.log(`  Total UTxO records: ${results.length}`);

    // Phase 4b: per-handle Blockfrost rescue.
    // Koios sometimes returns no UTxO for an asset that exists on chain (we've
    // observed ~50 LBL_222/LBL_000 holders silently dropped per preprod run).
    // The on-chain MPT keys these asset names regardless of where Koios's
    // index thinks the UTxO is, so dropping them produces a snapshot whose
    // computed root then misses chain by one entry per drop. After the main
    // dispatch finishes, walk the original work set, find items that didn't
    // yield a UtxoRecord, and re-fetch via Blockfrost (which has them).
    const foundKeys = new Set(results.map((r) => `${r.policy}|${r.assetNameHex}`));
    const stillMissing = work.filter((w) => !foundKeys.has(`${w.policy}|${w.assetNameHex}`));
    if (stillMissing.length > 0) {
        console.log(`  Phase 4b: ${stillMissing.length} work items dropped by Koios — rescuing via Blockfrost`);
        const rescuePool: Pool = { name: 'bf-rescue', kind: 'blockfrost', apiKey: BF_HIGH, rps: BF_HIGH_RPS, batchSize: 1 };
        let rescued = 0;
        let rescuedFails = 0;
        for (const w of stillMissing) {
            try {
                const rec = await fetchUtxoBlockfrost(rescuePool, w);
                if (rec) {
                    results.push(rec);
                    rescued++;
                }
            } catch (e: any) {
                rescuedFails++;
                console.error(`  bf-rescue ${w.policy.slice(0, 10)}…/${w.assetNameHex.slice(0, 16)}…: ${e?.message ?? e}`);
            }
            if (rescued > 0 && rescued % 20 === 0) process.stderr.write(`\r  [phase4b] rescued ${rescued}/${stillMissing.length}`);
        }
        process.stderr.write('\n');
        console.log(`  Phase 4b done: rescued=${rescued} fails=${rescuedFails} stillMissing=${stillMissing.length - rescued}`);
        console.log(`  Total UTxO records (post-rescue): ${results.length}`);
    }

    console.log(`  [elapsed ${fmtMs(Date.now() - t4)}]`);

    // Phase 2b: per-asset first-mint-tx
    const t2b = Date.now();
    console.log('\nPhase 2b: per-asset first-mint-tx (Koios policy_asset_mints)');
    const mintSourcesAll: MintSource[] = [];
    let multiMintCount = 0;
    for (const p of policies) {
        const rows = await enumeratePolicyAssetMints(p);
        for (const r of rows) {
            if (r.mint_cnt > 1) multiMintCount++;
            mintSourcesAll.push({ policy: p, assetNameHex: r.asset_name, mintTxHash: r.minting_tx_hash, mintCnt: r.mint_cnt });
        }
        console.log(`  ${p.slice(0, 10)}…  ${rows.length} assets`);
    }
    const mintSourcesIndexed = mintSourcesAll.filter((s) => {
        const { isCip67, assetLabel, name } = checkNameLabel(s.assetNameHex);
        const shouldIndex = isCip67
            ? assetLabel === AssetNameLabel.LBL_222 || assetLabel === AssetNameLabel.LBL_000
            : true;
        return shouldIndex && classified.handleNames.has(name);
    });
    console.log(`  Mint sources total=${mintSourcesAll.length} indexed=${mintSourcesIndexed.length} multi-mint(>1)=${multiMintCount}`);

    // Phase 2c: asset_history for multi-mint assets
    const multiMintSources = mintSourcesIndexed.filter((s) => s.mintCnt > 1);
    if (multiMintSources.length > 0) {
        console.log(`  Phase 2c: fetching asset_history for ${multiMintSources.length} multi-mint assets`);
        const extraSources = await expandMultiMintSources(multiMintSources, mintSourcesIndexed);
        console.log(`  Recovered ${extraSources.length} additional mint events`);
        mintSourcesIndexed.push(...extraSources);
    }

    let mintSourcesForFetch = mintSourcesIndexed;
    if (maxItems > 0 && mintSourcesIndexed.length > maxItems) {
        console.log(`  PHASE4_MAX_ITEMS=${maxItems} — sampling mint sources from ${mintSourcesIndexed.length}`);
        const copy = [...mintSourcesIndexed];
        for (let i = copy.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        mintSourcesForFetch = copy.slice(0, maxItems);
    }
    console.log(`  [elapsed ${fmtMs(Date.now() - t2b)}]`);

    // Phase 4c: tx_info
    const t4c = Date.now();
    console.log('\nPhase 4c: tx_info fetch for unique tx hashes');
    const uniqueTxHashes = new Set<string>();
    for (const r of results) if (r.txHash) uniqueTxHashes.add(r.txHash);
    for (const s of mintSourcesForFetch) if (s.mintTxHash) uniqueTxHashes.add(s.mintTxHash);
    console.log(`  Unique tx hashes: ${uniqueTxHashes.size}`);
    const txInfoRun = await runPhase4c(Array.from(uniqueTxHashes));
    console.log('\n  Per-pool stats:');
    for (const p of txInfoRun.pools) {
        const s = txInfoRun.stats[p.name];
        const effRps = s.calls > 0 ? (s.calls / (s.elapsedMs / 1000)).toFixed(2) : '0';
        console.log(`    ${p.name.padEnd(12)} rps=${p.rps} batch=${p.batchSize}  attempted=${s.assetsAttempted} found=${s.assetsFound} missing=${s.assetsMissing} calls=${s.calls} fails=${s.failures} elapsed=${fmtMs(s.elapsedMs)} effRps=${effRps}`);
    }
    console.log(`  TxInfo rows collected: ${txInfoRun.txInfo.size}`);
    console.log(`  [elapsed ${fmtMs(Date.now() - t4c)}]`);

    // Phase 4d: resolve datum hashes to bytes for any UTxO that stores its
    // datum off-output (Cardano allows datum-by-hash where the bytes live in
    // a separate witness, not the output itself). The pre-fix bootstrap had
    // no field for the hash and no resolution step, so any handle whose
    // canonical UTxO used datum-by-hash shipped in the snapshot with
    // datum=undefined. Koios's datum_info POST takes _datum_hashes and
    // returns { datum_hash, bytes }; we batch and merge into datumByHash.
    const t4d = Date.now();
    console.log('\nPhase 4d: resolve datum-hash bytes (for datums not stored inline)');
    const datumHashesToResolve = new Set<string>();
    for (const r of results) {
        if (!r.inlineDatumCbor && r.datumHash) datumHashesToResolve.add(r.datumHash);
    }
    console.log(`  Datum hashes needing resolution: ${datumHashesToResolve.size}`);
    const datumByHash = new Map<string, string>();
    if (datumHashesToResolve.size > 0) {
        const KOIOS_DATUM_BATCH = 50;
        const hashList = Array.from(datumHashesToResolve);
        for (let i = 0; i < hashList.length; i += KOIOS_DATUM_BATCH) {
            const batch = hashList.slice(i, i + KOIOS_DATUM_BATCH);
            const body = JSON.stringify({ _datum_hashes: batch });
            const rows = await koiosFetch('datum_info', { method: 'POST', body }) as Array<{ datum_hash?: string; bytes?: string }>;
            for (const row of rows ?? []) {
                if (row?.datum_hash && row?.bytes) datumByHash.set(row.datum_hash, row.bytes);
            }
        }
        const missing = hashList.filter((h) => !datumByHash.has(h));
        console.log(`  Datum bytes resolved: ${datumByHash.size}/${datumHashesToResolve.size}${missing.length ? ` (missing ${missing.length}: ${missing.slice(0, 3).join(',')}${missing.length > 3 ? '…' : ''})` : ''}`);
    }
    console.log(`  [elapsed ${fmtMs(Date.now() - t4d)}]`);

    // Phase 5: snapshot
    const t5 = Date.now();
    console.log('\nPhase 5: build snapshot + gzip');
    const outPath = process.env.SNAPSHOT_OUT ?? 'tmp/handles_utxos.gz';
    const policiesSet = new Set(policies);
    const snapshot = buildSnapshotFile({
        computedRoot,
        tips,
        utxoRecords: results,
        mintSources: mintSourcesForFetch,
        handleNamesInSet: classified.handleNames,
        txInfo: txInfoRun.txInfo,
        policiesSet,
        datumByHash
    });
    const { bytes, gzBytes } = writeSnapshotGz(snapshot, outPath);
    const mintCount = Object.values(snapshot.mintingData).reduce((a, b) => a + b.length, 0);
    console.log(`  Wrote ${outPath} (${(gzBytes / 1024 / 1024).toFixed(2)} MB gz, ${(bytes / 1024 / 1024).toFixed(2)} MB json)`);
    console.log(`  Snapshot: slot=${snapshot.slot} hash=${snapshot.hash} utxos=${snapshot.utxos.length} mintingData handles=${Object.keys(snapshot.mintingData).length} mint events=${mintCount} verified=${snapshot.verification?.verifiedAgainstChain}`);
    console.log(`  [elapsed ${fmtMs(Date.now() - t5)}]`);

    console.log(`\nTotal: ${fmtMs(Date.now() - t1)}`);
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
