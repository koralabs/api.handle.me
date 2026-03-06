import { AssetNameLabel, delay, HANDLE_POLICIES, LogCategory, Logger, Network, NETWORK, UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import { KoiosTxInfo } from '../interfaces/provider.interface';
import { getHandleNameFromAssetName } from '../services/ogmios/utils';

export const defaultKoiosSettings = { _inputs: true, _withdrawals: false, _certs: false, _governance: false, _scripts: true, _bytecode: true, _metadata: true, _assets: true };
const KOIOS_REQUEST_TIMEOUT_MS = 20_000;

export const blockfrostApiCall = async (endpointSegment: string) => {
    const headers = {
        project_id: process.env.BLOCKFROST_API_KEY ?? '',
        'Content-Type': 'application/json'
    };

    const url = `https://cardano-${NETWORK.toLowerCase()}.blockfrost.io/api/v0/${endpointSegment}`;
    return await fetch(url, { headers });
};

export const fetchPaginatedResults = async <T>(endpointSegment: string, maxResults = Infinity): Promise<T[]> => {
    const maxCount = 100;
    let page = 1;
    let hasMorePages = true;

    let results: T[] = [];
    try {
        while (hasMorePages && results.length < maxResults) {
            const response = await blockfrostApiCall(`${endpointSegment}?order=asc&count=${maxCount}&page=${page}`);

            if (response.status == 404) {
                return [];
            }
            if (response.status >= 300) {
                hasMorePages = false;
            } else {
                const items = await response.json();
                results = results.concat(items);
                hasMorePages = items.length == maxCount;
            }
            page += 1;
            await delay(100);
        }
    } catch (error) {
        Logger.log({ message: `Error fetching ${endpointSegment}: ${error}`, category: LogCategory.NOTIFY, event: 'fetchPaginatedResults' });
        return [];
    }

    return Number.isFinite(maxResults) ? results.slice(0, maxResults) : results;
};

/**
 * 
 * @param block Can be either block's hash or height
 * @returns 
 */
export const fetchTxList = async (block: string) => {
    const _tx_hashes = await fetchPaginatedResults(`blocks/${block}/txs`);

    const txList: KoiosTxInfo[] = await fetchKoios(`tx_info`, 'POST', JSON.stringify({ _tx_hashes, ...defaultKoiosSettings }));
    return txList;
};

export const fetchKoios = async (path: string, method = 'GET', body?: string) => {
    const url = `https://${NETWORK.toLowerCase() === 'mainnet' ? 'api' : NETWORK.toLowerCase()}.koios.rest/api/v1/${path}`;
    const koiosToken = process.env.KOIOS_API_BEARER_TOKEN?.trim();
    const headers: Record<string, string> = {
        'Content-Type': 'application/json'
    };
    if (koiosToken) {
        headers.Authorization = `Bearer ${koiosToken}`;
    }
    const response = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(KOIOS_REQUEST_TIMEOUT_MS)
    });

    const responseText = await response.text();
    const parseResponseJson = () => {
        if (!responseText) return null;
        return JSON.parse(responseText);
    };

    if (!response.ok) {
        let responseJson: any = null;
        try {
            responseJson = parseResponseJson();
        } catch {
            responseJson = null;
        }
        const error: any = new Error(`Koios ${path} request failed: ${response.status} ${response.statusText}`);
        error.status = response.status;
        error.statusText = response.statusText;
        error.koiosResponse = responseJson;
        if (!responseJson && responseText) {
            error.responseText = responseText.slice(0, 512);
        }
        throw error;
    }

    return parseResponseJson();
};

export const buildUTxOsFromKoiosTxs = (transactions: KoiosTxInfo[]): UTxOWithTxInfo[] => {
    const utxos: UTxOWithTxInfo[] = [];
    for (const t of transactions) {
        const mint: [string, string[]][] = []
        const burn: [string, string[]][] = []
        t.assets_minted.forEach((asset) => {
            if (HANDLE_POLICIES.contains(NETWORK as Network, asset.policy_id)) {
                const { isCip67 } = getHandleNameFromAssetName(asset.asset_name);
                if (!isCip67 || asset.asset_name.startsWith(AssetNameLabel.LBL_222) || asset.asset_name.startsWith(AssetNameLabel.LBL_000)) {
                    let whichOne = mint;
                    if (Number(asset.quantity) < 0)
                        whichOne = burn;
                    if (!whichOne.find((a) => a[0] === asset.policy_id))
                        whichOne.push([asset.policy_id, []]);
                    const policyEntry = whichOne.find((a) => a[0] === asset.policy_id)!;
                    policyEntry[1].push(asset.asset_name);
                }
            }
        }, []);

        for (const o of t.outputs) {
            const handles = o.asset_list.reduce<[string, string[]][]>((acc, asset) => {
                const { policy_id: policyId, asset_name: assetName } = asset;
                if (HANDLE_POLICIES.contains(NETWORK as Network, policyId)) {
                    if (!acc.find((a) => a[0] === policyId)) {
                        acc.push([policyId, []]);
                    }
                    const policyEntry = acc.find((a) => a[0] === policyId)!;
                    policyEntry[1].push(assetName);
                }
                return acc;
            }, []);

            const metadata = Object.fromEntries(
                Object.entries(t?.metadata ?? {})
                    .filter(([label, labelObj]) => label == '721' && Object.keys(labelObj).some(k => HANDLE_POLICIES.contains(NETWORK as Network, k))) // We only need 721 label
                    .map(([label, labelObj]) => {
                        const { version, ...policies } = labelObj as any;
                        const filteredPolicies = Object.fromEntries(
                            Object.entries(policies)
                                .map(([policyId, assets]) => {
                                    // Only handles in this UTxO
                                    const filteredAssets = Object.fromEntries(Object.entries(assets as any).filter(([assetName]) => handles.flatMap((h) => h[1]).includes(assetName) || handles.flatMap((h) => h[1]).includes(Buffer.from(assetName).toString('hex'))));
                                    return [policyId, filteredAssets];
                                })
                                .filter(([, assets]) => Object.keys(assets as any).length > 0)
                        );

                        return [label, { ...filteredPolicies, ...(version && { version }) }];
                    })
                    // drop labels that ended up with no assets under any policyId
                    .filter(([, labelObj]) => Object.keys(labelObj as any).some((k) => k !== 'version'))
            );

            const utxo: UTxOWithTxInfo = {
                handles,
                // filter for handles in this UTxO
                mint: mint.map(([policy, mintedHandles]) => [policy, handles.flatMap((h) => h[1]).filter((k) => mintedHandles.some((mh) => mh === k))]),
                burn,
                metadata,
                id: `${o.tx_hash}#${o.tx_index}`,
                tx_id: o.tx_hash,
                index: o.tx_index,
                blockHash: t.block_hash,
                blockNum: t.block_height,
                slot: t.absolute_slot,
                address: o.payment_addr.bech32,
                lovelace: Number(o.value),
                datum: o.inline_datum?.bytes,
                script: o.reference_script
                    ? {
                        type: 'PlutusScriptV2',
                        cbor: o.reference_script.bytes
                    }
                    : undefined
            };

            if (handles.length) {
                utxos.push(utxo);
            }
        }
    }

    // Sort the UTxOs so that Handles with 222 are first. This fixes when we look for mintingData later.
    utxos.sort(u => u.handles.some(h => h[1].some(a => a.startsWith(AssetNameLabel.LBL_222))) ? -1 : 1);
    
    return utxos;
}
