import { AssetNameLabel, asyncForEach, bech32FromHex, buildHolderInfo, checkNameLabel, decodeCborToJson } from '@koralabs/kora-labs-common';
import fs from 'fs';
import http, { OutgoingHttpHeaders } from 'http';
import https from 'https';
import stdOut from 'node:readline';
import userReadLine from 'node:readline/promises';
import { Color, colorString } from './colors';

/* bash command to query the json files
    jq -r '.[] | select(.[0] == "papagoose")' localHandles.json
*/

let NETWORK: string = 'preview';
const networkDelay: any = {"preview": 101, "preprod": 101, "mainnet": 50}
const POLICIES: any[] = [ 
    { id: "f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a", supply: 0},
    { id: "6c32db33a422e0bc2cb535bb850b5a6e9a9572222056d6ddc9cbc26e", supply: 0}
]
interface KoiosAsset { asset_name: string; }

declare global {
  interface Console {
    sameLine(msg: string): void;
  }
}
console.sameLine = function(message) {
    stdOut.clearLine(process.stdout, 0); // Clear the current line from the cursor to the right
    stdOut.cursorTo(process.stdout, 0); // Move the cursor to the beginning of the line
    process.stdout.write(message);
}

const userInput = userReadLine.createInterface({
  input: process.stdin,
  output: process.stdout
});

async function askUserUseCachedData(name: string, date: Date): Promise<boolean> {
    let answer = "";
    while(!['y', 'n', 'yes', 'no'].includes(answer.toLowerCase())){
        answer = await userInput.question(`Would you like to use the already cached ${name} data - dated ${date.toLocaleDateString()} ${date.toLocaleTimeString()}? (yes/no): `);
    }
    return answer.toLowerCase().startsWith('y');
}

async function askUserForNetwork() {
    let network = ""
    while(!['preview', 'preprod', 'mainnet'].includes(network.toLowerCase())){
        network = await userInput.question(`Which Cardano network? ([preview], preprod, mainnet): `);
        if (!network) {
            return;
        }
    }
    NETWORK = network;
}

async function askUserForPolicyCounts() {
    for (const policy of POLICIES) {
        let supply = 0;
        while (!supply) {
            supply = parseInt((await userInput.question(`Enter the asset count/supply for (https://beta.cexplorer.io/policy/${policy.id}): `)).replaceAll(',', ''));
        }
        policy.supply = supply;
    }
}

const startTime = new Date();
console.log(`Start time: ${startTime.toLocaleString()}`)

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

    const res = await fetch(url, {
        method,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.KOIOS_API_BEARER_TOKEN}`
        },
        body
    })
    .catch((error) => {
        console.log(); // Needed to break the same line above
        console.log(`Error fetching ${path} with body length ${body?.length ?? 0}: ${error}`);
        process.exit();
    })
    .then((res) => {
        if (res?.ok)
            return res?.json()
        else {
            console.log(); // Needed to break the same line above
            console.log(`Error fetching ${path} with body length ${body?.length ?? 0}: ${res?.status}: ${res?.statusText} \n ${res?.body}`);
        }
        process.exit();
    });

    return res;
};

export const fetchPolicyAssets = async (policyId: string, policySupply: number): Promise<string[]> => {
    const limit = 100;
    let results: Set<string> = new Set();
    try {
        const offsets = Array.from({ length: Math.ceil(policySupply / limit) }, (_, index) => index * limit)
        // console.log(`OFFSETS`, JSON.stringify(offsets))
        // process.exit()
        await asyncForEach(offsets, async (offset) => {
            console.sameLine(`Requesting policy assets page ${(offset/limit) + 1} of ${offsets.length}`);
            const items: KoiosAsset[] = await fetchKoios(`asset_list?policy_id=eq.${policyId}&limit=${limit}&offset=${offset}&order=fingerprint`);
            for (const item of items) {
                results.add(item.asset_name);
            }
        }, networkDelay[NETWORK]);
        console.log(); // Needed to break the same line above
        console.log(colorString(Color.FgBlue, `Finished receiving ${results.size} policy assets`))
    } catch (error) {
        console.log(); // Needed to break the same line above
        console.log(`Error fetching assets for ${policyId}: ${error}`);
        process.exit();
    }

    return Array.from(results);
};

const fetchAssetData = async (assets: string[], policyId: string) => {
    let allResults: Map<string, { asset_name: string; name: string; address: string; utxo: string; stake_address: string | null; policyId: string }> = new Map();

    const handles = assets.filter((a) => {
        const result = checkNameLabel(a);
        return a != "" && (!result.isCip67 || result.assetLabel == AssetNameLabel.LBL_222 || result.assetLabel == AssetNameLabel.LBL_000);
    });

    console.log(colorString(Color.FgBlue,`Found ${handles.length} CIP-25/68 Handles and SubHandles for policy ${policyId}`));

    const batchedHandles: [string, string][][] = []
    let i=0;
    let assetNames: [string, string][] = [];
    while (i < handles.length) {
        assetNames.push([policyId, handles[i]]);
        if (JSON.stringify({ _asset_list: assetNames, _extended: true }).length >= 4900) { // Max possible ",[policy,handle]" length is 96
            batchedHandles.push(assetNames)
            assetNames = [];
        }
        i++;
        // last check if last handle
        if (i == handles.length && assetNames.length) {
            batchedHandles.push(assetNames);
        }
    }

    await asyncForEach(batchedHandles, async (handleNames) => {
        const body = JSON.stringify({ _asset_list: handleNames, _extended: true });
        const result = await fetchKoios(`asset_utxos`, 'POST', body);
        if (result !== null) {
            // go through each asset and grab the data we need to test, tx_hash, tx_index, address
            for (const utxo of result) {
                for (const asset of utxo.asset_list) {
                    const result = checkNameLabel(asset.asset_name);
                    if (asset.policy_id === policyId && Number(asset.quantity) > 0) {
                        // for virtual subHandles, use the datum to get the address.
                        let address = utxo.address;
                        let stake_address = buildHolderInfo(utxo.address).address;
                        if (result.assetLabel == AssetNameLabel.LBL_000) {
                            const datum = utxo.inline_datum.bytes;
                            const d = await decodeCborToJson({ cborString: datum });
                            address = bech32FromHex(d.constructor_0[2].resolved_addresses.ada.replace('0x', ''), NETWORK != 'mainnet');
                            stake_address = buildHolderInfo(address).address;
                        }
                        if (result.name == "" || asset.asset_name == "")
                            continue;
                        allResults.set(result.name, {
                            asset_name: asset.asset_name,
                            name: result.name,
                            address,
                            utxo: `${utxo.tx_hash}#${utxo.tx_index}`,
                            stake_address,
                            policyId
                        });
                    }
                }
            }
        }
        console.sameLine(`Received ${allResults.size} handle UTxOs out of ${handles.length}`);
    }, networkDelay[NETWORK]);
    console.log(); // Needed to break the same line above
    return allResults;
};

const getPolicyAssets = async () => {
    let assetMap: Map<string, any> = new Map();
    for (const {id, supply} of POLICIES) {
        const policyAssets = await fetchPolicyAssets(id, supply);
        const assetsWithData = await fetchAssetData(policyAssets, id)
        assetMap = new Map([...assetMap, ...assetsWithData]);
    }
    return assetMap;
};

(async () => {
    let useLiveCachedData: boolean | Date = fs.existsSync('liveHandles.json') && fs.statSync('liveHandles.json').mtime;
    let useLocalCachedData: boolean | Date = fs.existsSync('localHandles.json') && fs.statSync('localHandles.json').mtime;

    if (useLiveCachedData) {
        useLiveCachedData = await askUserUseCachedData('Koios', useLiveCachedData);
    }
    if (useLocalCachedData) {
        useLocalCachedData = await askUserUseCachedData('local API', useLocalCachedData);
    }
    // DON'T TURN THIS INTO AN else!
    if (!useLiveCachedData) {
        await askUserForNetwork();
        await askUserForPolicyCounts();
    }
    userInput.close();

    let liveHandles: Map<string, any> = new Map<string, any>();
    if (useLiveCachedData) {
        liveHandles = new Map<string, any>(JSON.parse(fs.readFileSync('liveHandles.json').toString()));
    } else {
        liveHandles = await getPolicyAssets();
        fs.writeFileSync('liveHandles.json', JSON.stringify(Array.from(liveHandles.entries())));
    }

    let localHandles: Map<string, any> = new Map<string, any>();
    if (useLocalCachedData) {
        localHandles = new Map<string, any>(JSON.parse(fs.readFileSync('localHandles.json').toString()));
    }
    else {

        const pageSize = 250;
        const totalPages = Math.ceil(parseInt((await apiRequest(`http://localhost:3141/handles?records_per_page=${pageSize}&page=1`)).headers!['x-handles-search-total']!.toString()) / pageSize);
        await asyncForEach(
            [...Array(totalPages).keys()],
            async (i) => {
                const local = await apiRequest(`http://localhost:3141/handles?records_per_page=${pageSize}&page=${i + 1}`);
                console.sameLine(`Receiving local API Handles page ${i + 1} of ${totalPages}`);
                if (local.error || !local.statusCode || local.statusCode > 299) {
                    console.error(`ERROR: ${local.statusCode}`, local.error);
                    process.exit(1);
                }

                localHandles = new Map([...localHandles, ...new Map<string, any>(JSON.parse(local.body!).map((h: any) => [h.name, h]))]);
            },
            75
        );
        console.log(); // Needed to break the same line above
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
    const scriptMismatches: Record<string, any> = {};
    const datumMismatches: Record<string, any> = {};
    const defaultMismatches: Record<string, any> = {};

    console.log(colorString(Color.FgBlue, `Comparing ${bothKeys.size} handles present in both local and live data`));

    bothKeys.forEach((key) => {
        const localHandle = localHandles.get(key);
        const liveHandle = liveHandles.get(key);

        if (localHandle.utxo !== liveHandle.utxo) {
            utxoMismatches[key] = { utxo: { live: liveHandle.utxo, local: localHandle.utxo } };
        }
        if (localHandle.resolved_addresses.ada !== liveHandle.address) {
            addressMismatches[key] = { resolved_address: { live: liveHandle.address, local: localHandle.resolved_addresses.ada } };
        }
        if (localHandle.holder !== liveHandle.stake_address) {
            holderMismatches[key] = { holder: { live: liveHandle.stake_address, local: localHandle.holder } };
        }
        // if (localHandle.default_in_wallet !== liveHandle.default_in_wallet) {
        //     defaultMismatches[key] = { default_in_wallet: { live: liveHandle.default_in_wallet, local: localHandle.default_in_wallet } };
        // }
    });

    const mismatches: Record<string, any> = {};
    for (const map of [utxoMismatches, addressMismatches, holderMismatches, defaultMismatches]) {
        for (const [key, value] of Object.entries(map)) {
            mismatches[key] = { ...mismatches[key], ...value };
        }
    }

    console.log(colorString(missingInLive.length ? Color.FgRed : Color.FgGreen, `Missing in live: ${missingInLive.length ?? 0}`));
    console.log(colorString(missingInLocal.length ? Color.FgRed : Color.FgGreen, `Missing in local: ${missingInLocal.length ?? 0}`));
    console.log(colorString(Object.entries(addressMismatches).length ? Color.FgRed : Color.FgGreen, `Address mismatches: ${Object.entries(addressMismatches).length ?? 0}`));
    console.log(colorString(Object.entries(utxoMismatches).length ? Color.FgRed : Color.FgGreen, `UTxO mismatches: ${Object.entries(utxoMismatches).length ?? 0}`));
    console.log(colorString(Object.entries(holderMismatches).length ? Color.FgRed : Color.FgGreen, `Holder mismatches: ${Object.entries(holderMismatches).length ?? 0}`));
    //console.log(colorString(Object.entries(defaultMismatches).length ? Color.FgRed : Color.FgGreen, `Default mismatches: ${Object.entries(defaultMismatches).length ?? 0}`));

    fs.writeFileSync('discrepancies.json', JSON.stringify({ missingInLive, missingInLocal, mismatches }, null, 2));
    const endTime = new Date();
    console.log(`End time: ${endTime.toLocaleString()}`)
    const pad = (num: number) => num.toString().padStart(2, '0');
    const seconds = (endTime.getTime() - startTime.getTime()) / 1000;
    console.log(`Duration: ${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`)
})();
