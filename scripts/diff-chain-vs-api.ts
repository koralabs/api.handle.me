import 'dotenv/config';

const MAIN_POLICY = 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a';
const DEMI_POLICY = '6c32db33a422e0bc2cb535bb850b5a6e9a9572222056d6ddc9cbc26e';
const KOIOS_BASE = 'https://api.koios.rest/api/v1';
const TOKEN = process.env.KOIOS_API_BEARER_TOKEN!.replace(/^['"]|['"]$/g, '');
const LBL_222 = '000de140';
const LBL_000 = '00000000';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fetchAllAssets = async (policy: string): Promise<{ asset_name: string; total_supply: string }[]> => {
    const PAGE_SIZE = 1000;
    const STAGGER_MS = 170;
    const fetchPage = async (offset: number) => {
        const url = `${KOIOS_BASE}/policy_asset_list?_asset_policy=${policy}&order=asset_name.asc&limit=${PAGE_SIZE}&offset=${offset}`;
        const r = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
        if (!r.ok) throw new Error(`koios ${r.status}: ${await r.text()}`);
        return r.json() as Promise<any[]>;
    };
    const all: any[] = [];
    const first = await fetchPage(0);
    all.push(...first);
    if (first.length < PAGE_SIZE) return all;
    let offset = PAGE_SIZE;
    let done = false;
    while (!done) {
        const BATCH = 32;
        const promises: Promise<any[]>[] = [];
        for (let i = 0; i < BATCH; i++) {
            promises.push(delay(i * STAGGER_MS).then(() => fetchPage(offset + i * PAGE_SIZE)));
        }
        const pages = await Promise.all(promises);
        for (const p of pages) {
            all.push(...p);
            if (p.length < PAGE_SIZE) done = true;
        }
        offset += BATCH * PAGE_SIZE;
        process.stderr.write(`\r${policy.slice(0, 10)}… fetched ${all.length}`);
    }
    process.stderr.write('\n');
    return all;
};

const classify = (hex: string): { name: string; kind: 'lbl222' | 'lbl000' | 'legacy' | 'skipped' } | null => {
    if (!hex) return null;
    if (hex.startsWith(LBL_222)) return { name: Buffer.from(hex.slice(8), 'hex').toString('utf8'), kind: 'lbl222' };
    if (hex.startsWith(LBL_000)) return { name: Buffer.from(hex.slice(8), 'hex').toString('utf8'), kind: 'lbl000' };
    if (hex.startsWith('00') && hex.length >= 8) return { name: Buffer.from(hex.slice(8), 'hex').toString('utf8'), kind: 'skipped' };
    return { name: Buffer.from(hex, 'hex').toString('utf8'), kind: 'legacy' };
};

const fetchAllApiHandles = async (): Promise<string[]> => {
    const all: string[] = [];
    let page = 1;
    while (true) {
        const r = await fetch(`https://api.handle.me/handles?records_per_page=50000&page=${page}`, { headers: { accept: 'text/plain' } });
        if (!r.ok) throw new Error(`api page ${page}: ${r.status}`);
        const batch = (await r.text()).split('\n').map((l) => l.trim()).filter(Boolean);
        if (!batch.length) break;
        all.push(...batch);
        process.stderr.write(`\rapi fetched ${all.length} names`);
        if (batch.length < 50000) break;
        page++;
    }
    process.stderr.write('\n');
    return all;
};

(async () => {
    const [mainAssets, demiAssets, apiNames] = await Promise.all([
        fetchAllAssets(MAIN_POLICY),
        fetchAllAssets(DEMI_POLICY),
        fetchAllApiHandles()
    ]);
    const chain = new Set<string>();
    for (const a of [...mainAssets, ...demiAssets]) {
        if (BigInt(a.total_supply ?? '0') <= 0n) continue;
        const c = classify(a.asset_name);
        if (!c || c.kind === 'skipped') continue;
        chain.add(c.name);
    }
    const api = new Set(apiNames);

    const onlyChain: string[] = [];
    const onlyApi: string[] = [];
    for (const h of chain) if (!api.has(h)) onlyChain.push(h);
    for (const h of api) if (!chain.has(h)) onlyApi.push(h);

    console.log(`chain total: ${chain.size}, api total: ${api.size}`);
    console.log(`on-chain but NOT in api (${onlyChain.length}):`);
    for (const h of onlyChain.slice(0, 50)) console.log(`  + ${h}`);
    if (onlyChain.length > 50) console.log(`  ... (+${onlyChain.length - 50} more)`);
    console.log(`in api but NOT on-chain (${onlyApi.length}):`);
    for (const h of onlyApi.slice(0, 50)) console.log(`  - ${h}`);
    if (onlyApi.length > 50) console.log(`  ... (+${onlyApi.length - 50} more)`);

    require('fs').writeFileSync('/tmp/chain-vs-api-diff.json', JSON.stringify({ onlyChain, onlyApi }, null, 2));
    console.log('\nFull diff written to /tmp/chain-vs-api-diff.json');
})().catch((e) => { console.error(e); process.exit(1); });
