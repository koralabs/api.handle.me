import { asyncForEach } from '@koralabs/kora-labs-common';
import fs from 'fs';
import http, { OutgoingHttpHeaders } from 'http';
import https from 'https';
import stdOut from 'node:readline';
import userReadLine from 'node:readline/promises';
import { HandleViewModel } from '../models/view/handle.view.model';
import { Color, colorString } from './colors';

/* bash command to query the json files
    jq -r '.[] | select(.[0] == "papagoose")' localHandles.json
*/
let NETWORK: string = 'preview';
const apiDelay: any = 2000
const apiPageSize = 250;
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
        network = await userInput.question(`Which Cardano network? (preview, preprod, mainnet): `);
    }
    NETWORK = network;
}


const apiRequest = (url: string): Promise<{ statusCode?: number; body?: string; error?: string; headers?: OutgoingHttpHeaders }> => {
    const client = url.startsWith('http:') ? http : https;
    return new Promise((resolve, reject) => {
        try {
            const options: https.RequestOptions = {
                method: 'GET',
                headers: {
                    'Accept': 'application/json', 
                    'api-key': process.env.HANDLES_API_KEY 
                }
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

const counts: Record<string, {page:number, total:number}> = {};

const getApiHandles = async (host: string) => {
    let handles = new Map<string, any>();
    console.log();
    console.sameLine(`Getting Handles count from ${host}...`);
    const handlesCount = parseInt((await apiRequest(`${host}/handles?records_per_page=1&page=1`)).headers!['x-handles-search-total']!.toString())
    const totalPages = Math.ceil(handlesCount / apiPageSize);
    console.sameLine(`${Color.FgBlue}Handles count on ${host} is: ${handlesCount}${Color.Reset}`)
    console.log();
    await asyncForEach(
        [...Array(totalPages).keys()],
        async (i) => {
            const apiRes = await apiRequest(`${host}/handles?records_per_page=${apiPageSize}&page=${i + 1}`);
            counts[host] = {page: i + 1, total: totalPages}
            console.sameLine(Object.entries(counts).map(([key, { page, total }]) => `${key} is on ${page} of ${total}`).join(' | '));
            if (apiRes.error || !apiRes.statusCode || apiRes.statusCode > 299) {
                console.log();
                console.error(`ERROR: ${apiRes.statusCode}`, host, apiRes.error ?? apiRes.body);
                process.exit(1);
            }

            handles = new Map([...handles, ...new Map<string, any>(JSON.parse(apiRes.body!).map((h: any) => [h.name, h]))]);
        },
        apiDelay
    );
    console.log(); // Needed to break the same line above
    return handles;
}

(async () => {
    const startTime = new Date();
    console.log(`Start time: ${startTime.toLocaleString()}`);

    let useLiveCachedData: boolean | Date = fs.existsSync('liveHandles.json') && fs.statSync('liveHandles.json').mtime;
    let useLocalCachedData: boolean | Date = fs.existsSync('localHandles.json') && fs.statSync('localHandles.json').mtime;

    if (useLiveCachedData) {
        useLiveCachedData = await askUserUseCachedData('live API', useLiveCachedData);
    }
    if (useLocalCachedData) {
        useLocalCachedData = await askUserUseCachedData('local API', useLocalCachedData);
    }
    // DON'T TURN THIS INTO AN else!
    if (!useLiveCachedData) {
        await askUserForNetwork();
    }
    userInput.close();
    
    let liveHandles: Map<string, HandleViewModel> | Promise<Map<string, HandleViewModel>> = new Map<string, HandleViewModel>();
    if (useLiveCachedData) {
        liveHandles = new Map<string, HandleViewModel>(JSON.parse(fs.readFileSync('liveHandles.json').toString()));
    } else {
        liveHandles = getApiHandles(`https://${NETWORK == 'mainnet' ? '' : NETWORK + '.'}api.handle.me`);
    }

    let localHandles: Map<string, HandleViewModel> | Promise<Map<string, HandleViewModel>> = new Map<string, HandleViewModel>();
    if (useLocalCachedData) {
        localHandles = new Map<string, HandleViewModel>(JSON.parse(fs.readFileSync('localHandles.json').toString()));
    }
    else {
        localHandles = getApiHandles('http://localhost:3142');
    }

    liveHandles = await liveHandles;
    localHandles = await localHandles;

    fs.writeFileSync('tmp/liveHandles.json', JSON.stringify(Array.from(liveHandles.entries())));
    fs.writeFileSync('tmp/localHandles.json', JSON.stringify(Array.from(localHandles.entries())));

    const lastLiveSlot = Array.from(liveHandles.values()).reduce((max, h) => (h.updated_slot_number > max ? h.updated_slot_number : max), -Infinity);
    const lastLocalSlot = Array.from(localHandles.values()).reduce((max, h) => (h.updated_slot_number > max ? h.updated_slot_number : max), -Infinity);
    const startingSlot = Math.min(lastLocalSlot, lastLiveSlot);

    const localKeys = new Set(localHandles.keys());
    const liveKeys = new Set(liveHandles.keys());
    const bothKeys = new Set([...localKeys].filter((k) => liveKeys.has(k)));

    const missingInLive = [...localKeys].filter((key) => !liveKeys.has(key));
    const missingInLocal = [...liveKeys].filter((key) => !localKeys.has(key));
    const updatedAfter: string[] = [];
    
    const addressMismatches: Record<string, any> = {};
    const utxoMismatches: Record<string, any> = {};
    const holderMismatches: Record<string, any> = {};
    const defaultMismatches: Record<string, any> = {};

    console.log(colorString(Color.FgBlue, `Comparing ${bothKeys.size} handles present in both local and live data`));

    let updatedAfterLastSlot = 0;
    bothKeys.forEach((key) => {
        const localHandle = localHandles.get(key)!;
        const liveHandle = liveHandles.get(key)!;

        if (localHandle.updated_slot_number != liveHandle.updated_slot_number) {
            updatedAfter.push(localHandle.name);
            updatedAfterLastSlot++;
            return;
        };
        if (localHandle.utxo != liveHandle.utxo) {
            utxoMismatches[key] = { utxo: { live: liveHandle.utxo, local: localHandle.utxo } };
        }
        if (localHandle.resolved_addresses.ada != liveHandle.resolved_addresses.ada) {
            addressMismatches[key] = { resolved_address: { live: liveHandle.resolved_addresses.ada, local: localHandle.resolved_addresses.ada } };
        }
        if (localHandle.holder != liveHandle.holder) {
            holderMismatches[key] = { holder: { live: liveHandle.holder, local: localHandle.holder } };
        }
        if (localHandle.default_in_wallet != liveHandle.default_in_wallet) {
            defaultMismatches[key] = { default_in_wallet: { live: liveHandle.default_in_wallet, local: localHandle.default_in_wallet } };
        }
    });

    const mismatches: Record<string, any> = {};
    for (const map of [utxoMismatches, addressMismatches, holderMismatches, defaultMismatches]) {
        for (const [key, value] of Object.entries(map)) {
            mismatches[key] = { ...mismatches[key], ...value };
        }
    }

    console.log(colorString(updatedAfterLastSlot ? Color.FgYellow : Color.FgGreen, `Updated after last slot: ${updatedAfterLastSlot}`));
    console.log(colorString(missingInLive.length ? Color.FgRed : Color.FgGreen, `Missing in live: ${missingInLive.length ?? 0}`));
    console.log(colorString(missingInLocal.length ? Color.FgRed : Color.FgGreen, `Missing in local: ${missingInLocal.length ?? 0}`));
    console.log(colorString(Object.entries(addressMismatches).length ? Color.FgRed : Color.FgGreen, `Address mismatches: ${Object.entries(addressMismatches).length ?? 0}`));
    console.log(colorString(Object.entries(utxoMismatches).length ? Color.FgRed : Color.FgGreen, `UTxO mismatches: ${Object.entries(utxoMismatches).length ?? 0}`));
    console.log(colorString(Object.entries(holderMismatches).length ? Color.FgRed : Color.FgGreen, `Holder mismatches: ${Object.entries(holderMismatches).length ?? 0}`));
    console.log(colorString(Object.entries(defaultMismatches).length ? Color.FgRed : Color.FgGreen, `Default mismatches: ${Object.entries(defaultMismatches).length ?? 0}`));

    fs.writeFileSync('tmp/discrepancies.json', JSON.stringify({ updatedAfter, missingInLive, missingInLocal, mismatches }, null, 2));
    const endTime = new Date();
    console.log(`End time: ${endTime.toLocaleString()}`)
    const pad = (num: number) => num.toString().padStart(2, '0');
    const seconds = (endTime.getTime() - startTime.getTime()) / 1000;
    console.log(`Duration: ${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`)
})();
