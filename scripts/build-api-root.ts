import 'dotenv/config';
import { Trie } from '@aiken-lang/merkle-patricia-forestry';

(async () => {
    const names: string[] = [];
    let page = 1;
    while (true) {
        const url = `https://api.handle.me/handles?records_per_page=50000&page=${page}`;
        const r = await fetch(url, { headers: { accept: 'text/plain' } });
        if (!r.ok) throw new Error(`api page ${page}: ${r.status}`);
        const text = await r.text();
        const batch = text.split('\n').map((l) => l.trim()).filter(Boolean);
        if (!batch.length) break;
        names.push(...batch);
        process.stderr.write(`\rfetched ${names.length} names (page ${page})`);
        if (batch.length < 50000) break;
        page++;
    }
    process.stderr.write('\n');

    const unique = [...new Set(names)].sort();
    // Ghost
    unique.push('watchman@ngmerchs');

    const trie = await Trie.fromList(unique.map((h) => ({ key: h, value: '' })));
    console.log('API_TRIE_ROOT:', trie.hash!.toString('hex').toLowerCase());
    console.log('COUNT:', unique.length);
})().catch((e) => { console.error(e); process.exit(1); });
