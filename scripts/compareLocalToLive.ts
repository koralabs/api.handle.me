import { AssetNameLabel, asyncForEach, delay } from '@koralabs/kora-labs-common';
import fs from 'fs';
import http, { OutgoingHttpHeaders } from 'http';
import https from 'https';
const NETWORK = 'mainnet';

const apiRequest = (url: string): Promise<{ statusCode?: number; body?: string; error?: string; headers?: OutgoingHttpHeaders }> => {
    const client = url.startsWith('http:') ? http : https;
    return new Promise((resolve, reject) => {
        try {
            const options: https.RequestOptions = {
                method: 'GET',
                headers: { Accept: 'application/json' }
            };

            let body = '';
            const get_req = client.request(url, options, (res) => {
                res.on('data', (chunk) => {
                    body += chunk;
                });
                res.on('error', (err) => {
                    resolve({
                        statusCode: res.statusCode,
                        error: err.message
                    });
                });
                res.on('end', (chunk: any) => {
                    resolve({
                        statusCode: res.statusCode,
                        body,
                        headers: res.headers
                    });
                });
            });
            get_req.end();
        } catch (error: any) {
            resolve({
                statusCode: 500,
                error: error.message
            });
        }
    });
};

const fetchKoios = async (path: string, method = 'GET', body?: string) => {
    const url = `https://${NETWORK.toLowerCase() === 'mainnet' ? 'api' : NETWORK.toLowerCase()}.koios.rest/api/v1/${path}`;

    console.log('BODY', body, process.env.KOIOS_API_BEARER_TOKEN);
    console.log('URL', url);

    const res = await fetch(url, {
        method,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.KOIOS_API_BEARER_TOKEN}`
        },
        body
    }).then((res) => res.json());

    return res;
};

export const fetchPolicyAssets = async (policyId: string): Promise<{ asset_name: string; fingerprint: string; total_supply: string }[]> => {
    const limit = 1000;
    let offset = 0;
    let hasMorePages = true;

    let results: { asset_name: string; fingerprint: string; total_supply: string }[] = [];
    try {
        while (hasMorePages) {
            const items = await fetchKoios(`policy_asset_list?_asset_policy=${policyId}&limit=${limit}&offset=${offset}`);

            if (!items || items.length === 0) {
                hasMorePages = false;
            } else {
                results = results.concat(items);
                hasMorePages = items.length === limit;
                offset += limit;
            }
            console.log(`Done fetching offset ${offset} with ${results.length} total results`);
            await delay(100);
        }
    } catch (error) {
        console.log(`Error fetching assets for ${policyId}: ${error}`);
        return [];
    }

    return results;
};

const fetchAssetData = async (assets: { asset_name: string; fingerprint: string; total_supply: string }[], policyId: string) => {
    const batchSize = 60;
    let allResults: Map<string, { asset_name: string; address: string; utxo: string; stake_address: string | null; policyId: string }> = new Map();

    for (let i = 0; i < assets.length; i += batchSize) {
        const batch = assets.slice(i, i + batchSize);
        const assetNames = batch.map((asset) => [policyId, asset.asset_name]);

        const result = await fetchKoios(`asset_utxos`, 'POST', JSON.stringify({ _asset_list: assetNames })).catch((error) => {
            console.log(`Error fetching batch ${Math.floor(i / batchSize) + 1}: ${error}`);
            return null;
        });

        if (result !== null) {
            // go through each asset and grab the data we need to test, tx_hash, tx_index, address
            for (const assetInfo of result) {
                for (const utxo of assetInfo.utxos) {
                    for (const asset of utxo.asset_list) {
                        if ((asset.asset_name.startsWith(AssetNameLabel.LBL_222) || asset.asset_name.startsWith(AssetNameLabel.LBL_000)) && Number(asset.total_supply) > 0) {
                            allResults.set(asset.asset_name, {
                                asset_name: asset.asset_name,
                                address: utxo.address,
                                utxo: `${utxo.tx_hash}#${utxo.tx_index}`,
                                stake_address: utxo.stake_address,
                                policyId
                            });
                        }
                    }
                }
            }
        }
        console.log(`Fetched batch ${Math.floor(i / batchSize) + 1} with ${allResults.size} total results`);
        await delay(100);
    }

    return allResults;
};

const getPolicyAssets = async () => {
    const legacyAssets = await fetchPolicyAssets('f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a');
    const legacyAssetsWithData = await fetchAssetData(legacyAssets, 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a');

    const demiAssets = await fetchPolicyAssets('6c32db33a422e0bc2cb535bb850b5a6e9a9572222056d6ddc9cbc26e');
    const demiAssetsWithData = await fetchAssetData(demiAssets, '6c32db33a422e0bc2cb535bb850b5a6e9a9572222056d6ddc9cbc26e');

    return new Map<string, any>([...legacyAssetsWithData, ...demiAssetsWithData]);
};

(async () => {
    let localHandles: Map<string, any> = new Map<string, any>();
    let liveHandles: Map<string, any> = new Map<string, any>();
    if (fs.existsSync('localHandles.json')) {
        localHandles = new Map<string, any>(JSON.parse(fs.readFileSync('localHandles.json').toString()));
        liveHandles = new Map<string, any>(JSON.parse(fs.readFileSync('liveHandles.json').toString()));
    } else {
        const koiosHandles = await getPolicyAssets();
        fs.writeFileSync('liveHandles.json', JSON.stringify(Array.from(koiosHandles.entries())));

        const pageSize = 1000;
        const totalPages = Math.ceil(parseInt((await apiRequest(`http://localhost:3141/handles?records_per_page=${pageSize}&page=1`)).headers!['x-handles-search-total']!.toString()) / pageSize);
        await asyncForEach(
            [...Array(totalPages).keys()],
            async (i) => {
                const local = await apiRequest(`http://localhost:3141/handles?records_per_page=${pageSize}&page=${i + 1}`);
                console.log(`Page ${i + 1} of ${totalPages} - Local: ${local.statusCode}`);
                if (local.error) {
                    console.error('ERROR', local.error);
                    process.exit(1);
                }

                localHandles = new Map([...localHandles, ...new Map<string, any>(JSON.parse(local.body!).map((h: any) => [h.name, h]))]);
            },
            1000
        );
        fs.writeFileSync('localHandles.json', JSON.stringify(Array.from(localHandles.entries())));
    }

    const localKeys = new Set(localHandles.keys());
    const liveKeys = new Set(liveHandles.keys());
    const bothKeys = new Set([...localKeys].filter((k) => liveKeys.has(k)));

    const missingInLive = [...localKeys].filter((key) => !liveKeys.has(key));
    const missingInLocal = [...liveKeys].filter((key) => !localKeys.has(key));

    const addressMismatches: Record<string, any> = {};
    const utxoMismatches: Record<string, any> = {};
    const holderMismatches: Record<string, any> = {};
    const defaultMismatches: Record<string, any> = {};
    bothKeys.forEach((key) => {
        const localHandle = localHandles.get(key);
        const liveHandle = liveHandles.get(key);

        if (localHandle.utxo !== liveHandle.utxo) {
            utxoMismatches[key] = { utxo: { live: liveHandle.utxo, local: localHandle.utxo } };
        }
        if (localHandle.resolved_addresses.ada !== liveHandle.resolved_addresses.ada) {
            addressMismatches[key] = { resolved_address: { live: liveHandle.resolved_addresses.ada, local: localHandle.resolved_addresses.ada } };
        }
        if (localHandle.holder !== liveHandle.holder) {
            holderMismatches[key] = { holder: { live: liveHandle.holder, local: localHandle.holder } };
        }
        if (localHandle.default_in_wallet !== liveHandle.default_in_wallet) {
            defaultMismatches[key] = { default_in_wallet: { live: liveHandle.default_in_wallet, local: localHandle.default_in_wallet } };
        }
    });

    const mismatches: Record<string, any> = {};
    for (const map of [utxoMismatches, addressMismatches, holderMismatches, defaultMismatches]) {
        for (const [key, value] of Object.entries(map)) {
            mismatches[key] = { ...mismatches[key], ...value };
        }
    }

    console.log(`Missing in live: ${missingInLive.length ?? 0}\nMissing in local: ${missingInLocal.length ?? 0}`);
    console.log(`Address mismatches: ${Object.entries(addressMismatches).length ?? 0}`);
    console.log(`UTxO mismatches: ${Object.entries(utxoMismatches).length ?? 0}`);
    console.log(`Holder mismatches: ${Object.entries(holderMismatches).length ?? 0}`);
    console.log(`Default mismatches: ${Object.entries(defaultMismatches).length ?? 0}`);

    fs.writeFileSync('discrepancies.json', JSON.stringify({ missingInLive, missingInLocal, mismatches }, null, 2));
})();
