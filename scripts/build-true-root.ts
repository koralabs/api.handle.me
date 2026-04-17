import 'dotenv/config';
import { Trie } from '@aiken-lang/merkle-patricia-forestry';

const MAIN_POLICY = 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a';
const DEMI_POLICY = '6c32db33a422e0bc2cb535bb850b5a6e9a9572222056d6ddc9cbc26e';
const KOIOS_BASE = 'https://api.koios.rest/api/v1';
const TOKEN = process.env.KOIOS_API_BEARER_TOKEN!.replace(/^['"]|['"]$/g, '');
const LBL_222 = '000de140';
const LBL_000 = '00000000';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fetchAll = async (policy: string): Promise<{ asset_name: string; total_supply: string }[]> => {
    const PAGE_SIZE = 1000;
    const STAGGER_MS = 170; // ~6 RPS, stay under Koios tier 3 rate limit
    // Probe the first page to decide whether we need more.
    const fetchPage = async (offset: number): Promise<any[]> => {
        const url = `${KOIOS_BASE}/policy_asset_list?_asset_policy=${policy}&order=asset_name.asc&limit=${PAGE_SIZE}&offset=${offset}`;
        const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
        if (!r.ok) throw new Error(`koios ${r.status}: ${await r.text()}`);
        return r.json() as Promise<any[]>;
    };

    const all: any[] = [];
    const first = await fetchPage(0);
    all.push(...first);
    if (first.length < PAGE_SIZE) {
        process.stderr.write(`\r${policy.slice(0, 10)}… fetched ${all.length} assets\n`);
        return all;
    }

    // Fire page requests in parallel with a stagger. We don't know total count,
    // so issue pages in rounds until a round returns a short/empty page.
    let offset = PAGE_SIZE;
    let done = false;
    while (!done) {
        const BATCH = 32; // up to 32 pages in flight per round
        const promises: Promise<any[]>[] = [];
        for (let i = 0; i < BATCH; i++) {
            const o = offset + i * PAGE_SIZE;
            promises.push(delay(i * STAGGER_MS).then(() => fetchPage(o)));
        }
        const pages = await Promise.all(promises);
        for (const p of pages) {
            all.push(...p);
            if (p.length < PAGE_SIZE) done = true;
        }
        offset += BATCH * PAGE_SIZE;
        process.stderr.write(`\r${policy.slice(0, 10)}… fetched ${all.length} assets`);
    }
    process.stderr.write('\n');
    return all;
};

interface Classified {
    name: string;
    kind: 'lbl222' | 'lbl000' | 'legacy' | 'skipped';
}

const classify = (hex: string): Classified | null => {
    if (!hex) return null;
    if (hex.startsWith(LBL_222)) {
        return { name: Buffer.from(hex.slice(8), 'hex').toString('utf8'), kind: 'lbl222' };
    }
    if (hex.startsWith(LBL_000)) {
        return { name: Buffer.from(hex.slice(8), 'hex').toString('utf8'), kind: 'lbl000' };
    }
    if (hex.startsWith('00') && hex.length >= 8) {
        // Some other CIP-67 label (LBL_100 reference tokens, LBL_001 subhandle settings)
        return { name: Buffer.from(hex.slice(8), 'hex').toString('utf8'), kind: 'skipped' };
    }
    return { name: Buffer.from(hex, 'hex').toString('utf8'), kind: 'legacy' };
};

const computeRoot = async (names: Set<string>, label: string) => {
    const sorted = [...names].sort();
    const trie = await Trie.fromList(sorted.map((h) => ({ key: h, value: '' })));
    const root = trie.hash!.toString('hex').toLowerCase();
    console.log(`${label.padEnd(48)} ${root}  (${sorted.length} handles)`);
};

(async () => {
    const mainAssets = await fetchAll(MAIN_POLICY);
    const demiAssets = await fetchAll(DEMI_POLICY);
    console.error(`Totals: main=${mainAssets.length}, demi=${demiAssets.length}`);

    const buckets = {
        main_lbl222: new Set<string>(),
        main_lbl000: new Set<string>(),
        main_legacy: new Set<string>(),
        demi_lbl222: new Set<string>(),
        demi_lbl000: new Set<string>(),
        demi_legacy: new Set<string>(),
    };
    const classifyInto = (assets: any[], prefix: 'main' | 'demi') => {
        for (const a of assets) {
            const supply = BigInt(a.total_supply ?? '0');
            if (supply <= 0n) continue;
            const c = classify(a.asset_name);
            if (!c || c.kind === 'skipped') continue;
            const key = `${prefix}_${c.kind}` as keyof typeof buckets;
            buckets[key].add(c.name);
        }
    };
    classifyInto(mainAssets, 'main');
    classifyInto(demiAssets, 'demi');

    console.error('bucket sizes:');
    for (const [k, v] of Object.entries(buckets)) console.error(`  ${k}: ${v.size}`);

    const ghosts = ['watchman@ngmerchs'];
    const union = (...sets: Set<string>[]) => {
        const r = new Set<string>();
        for (const s of sets) for (const x of s) r.add(x);
        for (const g of ghosts) r.add(g);
        return r;
    };

    console.log('');
    console.log('=== candidate MPT roots ===');
    console.log('label'.padEnd(48) + ' root                                                              (count)');
    await computeRoot(buckets.main_lbl222, 'main_lbl222 only');
    await computeRoot(union(buckets.main_lbl222, buckets.main_lbl000), 'main_lbl222 + main_lbl000');
    await computeRoot(buckets.demi_lbl222, 'demi_lbl222 only');
    await computeRoot(union(buckets.demi_lbl222, buckets.demi_lbl000), 'demi_lbl222 + demi_lbl000');
    await computeRoot(union(buckets.main_lbl222, buckets.main_lbl000, buckets.demi_lbl222, buckets.demi_lbl000), 'all CIP68 (main+demi, 222+000)');
    await computeRoot(union(buckets.main_lbl222, buckets.main_lbl000, buckets.main_legacy, buckets.demi_lbl222, buckets.demi_lbl000, buckets.demi_legacy), 'ALL handles (CIP25 + CIP68, both policies)');

    console.log('');
    console.log('known chain values:');
    console.log('  current datum:        c6c076501473940e02a6009e7489de640005fc681f05106d44d53354907e5b9d');
    console.log('  pre-Apr-12 datum:     9a5896c1e44d419ef5cd5ab16a8efcc99a564d8dec53112d4445e5f48329df5a');
})().catch((e) => { console.error(e); process.exit(1); });
