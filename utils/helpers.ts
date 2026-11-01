import { AssetNameLabel, HANDLE_POLICIES, LogCategory, Logger, Network, NETWORK, UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import { KoiosAsset, KoiosOutput, KoiosTxInfo } from '../interfaces/provider.interface';
import { getHandleNameFromAssetName } from '../services/ogmios/utils';
import { createProviderLimiter, KoiosAdmission, observeKoiosBody, requestKoios } from './koiosRateLimit';
import { isRequestDeadlineError } from './requestDeadline';

export const defaultKoiosSettings = { _inputs: true, _withdrawals: false, _certs: false, _governance: false, _scripts: true, _bytecode: true, _metadata: true, _assets: true };

// Deterministic JSON encoding — sorts keys recursively and coerces bigints.
// Required for any value used as a Redis set member (e.g. MintingData in
// IndexNames.MINT), so that replaying a block produces a byte-identical
// member and SADD deduplicates instead of creating a second entry.
export const canonicalJsonStringify = (value: unknown): string => {
    const sortKeys = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(sortKeys);
        if (v && typeof v === 'object') {
            const sorted: Record<string, unknown> = {};
            for (const key of Object.keys(v as Record<string, unknown>).sort()) {
                sorted[key] = sortKeys((v as Record<string, unknown>)[key]);
            }
            return sorted;
        }
        return v;
    };
    return JSON.stringify(sortKeys(value), (_, v) => (typeof v === 'bigint' ? `${Number(v)}` : v));
};
const KOIOS_REQUEST_TIMEOUT_MS = 20_000;

const BLOCKFROST_REQUEST_TIMEOUT_MS = 20_000;

const blockfrost = createProviderLimiter();

export const blockfrostApiCall = async (endpointSegment: string, admission?: KoiosAdmission): Promise<Response> => {
    const headers = {
        project_id: process.env.BLOCKFROST_API_KEY ?? '',
        'Content-Type': 'application/json'
    };

    const url = `https://cardano-${NETWORK.toLowerCase()}.blockfrost.io/api/v0/${endpointSegment}`;
    // An implicit redirect would dispatch outside admission and hide its wait.
    const { response } = await blockfrost.request(() => fetch(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(BLOCKFROST_REQUEST_TIMEOUT_MS) }), admission);
    // Observe body hints without consuming the Response returned to callers.
    // Header registration already ran directly on the fetch promise.
    try {
        await response.clone().json().then((body) => blockfrost.observeBody(body));
    } catch (error) {
        if (isRequestDeadlineError(error)) throw error;
        // Non-JSON or unreadable bodies remain the original caller's response.
    }
    return response;
};

export const fetchPaginatedResults = async <T>(endpointSegment: string, maxResults = Infinity, admission?: KoiosAdmission): Promise<T[]> => {
    const maxCount = 100;
    const maxRetries = 5;
    let page = 1;
    let hasMorePages = true;

    let results: T[] = [];
    try {
        while (hasMorePages && results.length < maxResults) {
            // Retry transient/rate-limit/auth failures with backoff and SURFACE a persistent
            // failure, instead of silently treating any non-2xx as "no more pages". Swallowing a
            // 403 into blocks=0 is what let a missing/exhausted BLOCKFROST_API_KEY wedge the
            // scanner invisibly for ~24h — it kept reporting success while indexing nothing.
            let response: Awaited<ReturnType<typeof blockfrostApiCall>> | undefined;
            for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
                response = await blockfrostApiCall(`${endpointSegment}?order=asc&count=${maxCount}&page=${page}`, admission);
                if (response.status === 404 || response.status < 300) break;
                const retriable = response.status === 429 || response.status === 403 || response.status >= 500;
                if (!retriable || attempt === maxRetries) {
                    const body = await response.text().catch((error) => { if (isRequestDeadlineError(error)) throw error; return ''; });
                    throw new Error(
                        `Blockfrost ${response.status} for ${endpointSegment} (page ${page})${retriable ? ` after ${maxRetries} retries` : ''}: ${body.slice(0, 200)}`
                    );
                }
                await blockfrost.wait(Math.min(2000, 200 * 2 ** attempt), admission);
            }

            if (!response || response.status === 404) {
                return [];
            }
            const items = await response.json();
            results = results.concat(items);
            hasMorePages = items.length === maxCount;
            page += 1;
            await blockfrost.wait(100, admission);
        }
    } catch (error) {
        Logger.log({ message: `Error fetching ${endpointSegment}: ${error}`, category: LogCategory.NOTIFY, event: 'fetchPaginatedResults' });
        throw error;
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

export const fetchKoios = async (path: string, method = 'GET', body?: string, admission?: KoiosAdmission) => {
    const url = `https://${NETWORK.toLowerCase() === 'mainnet' ? 'api' : NETWORK.toLowerCase()}.koios.rest/api/v1/${path}`;
    const koiosToken = process.env.KOIOS_API_BEARER_TOKEN?.trim();
    const headers: Record<string, string> = {
        'Content-Type': 'application/json'
    };
    if (koiosToken) {
        headers.Authorization = `Bearer ${koiosToken}`;
    }
    const { response, headerWait } = await requestKoios(() => fetch(url, {
        method,
        headers,
        body,
        // Surface every response to the limiter; never replay through fetch's redirect engine.
        redirect: 'manual',
        signal: AbortSignal.timeout(KOIOS_REQUEST_TIMEOUT_MS)
    }), admission);
    // The direct transport reaction already registered headers before wrapper adoption.
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
        const bodyWait = observeKoiosBody(responseJson);
        if (headerWait !== undefined || bodyWait !== undefined) {
            error.retryAfterMs = Math.max(headerWait ?? 0, bodyWait ?? 0);
        }
        if (!responseJson && responseText) {
            error.responseText = responseText.slice(0, 512);
        }
        throw error;
    }

    const responseJson = parseResponseJson();
    observeKoiosBody(responseJson);
    return responseJson;
};

const resolveKoiosOutputDatum = (output: KoiosTxInfo['outputs'][number], datumByHash: Map<string, string>): string | undefined =>
    output.inline_datum?.bytes || (output.datum_hash ? datumByHash.get(output.datum_hash) : undefined);

export const buildUTxOsFromKoiosTxs = (transactions: KoiosTxInfo[], datumByHash = new Map<string, string>()): UTxOWithTxInfo[] => {
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

        for (const o of t.outputs ?? []) {
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
                datum: resolveKoiosOutputDatum(o, datumByHash),
                script: o.reference_script
                    ? {
                        // Preserve Plutus language version from koios so the
                        // /scripts hash computation can pick the right tag.
                        // Hardcoding 'PlutusScriptV2' broke V3 deployments —
                        // the resulting validator hash was wrong, and the
                        // /scripts response advertised V3 scripts at a
                        // V2-derived address that didn't exist on chain.
                        type: o.reference_script.type ?? 'plutusV2',
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
    // Proper binary comparator — the previous unary form caused V8 to silently REVERSE the order of
    // items within the LBL_222 group, leading to newer-then-older handle update ordering within a
    // single block (e.g. tx[5] spending tx[4]'s output, processed in reverse → stale handle pointer).
    utxos.sort((a, b) => {
        const aHas = a.handles.some(h => h[1].some(asset => asset.startsWith(AssetNameLabel.LBL_222)));
        const bHas = b.handles.some(h => h[1].some(asset => asset.startsWith(AssetNameLabel.LBL_222)));
        return Number(bHas) - Number(aHas);
    });

    return utxos;
}

// ========== Blockfrost fallback for scanner ==========

const BLOCKFROST_FALLBACK_MIN_INTERVAL_MS = 110; // ~9 RPS

const blockfrostFallbackJson = async (endpointSegment: string, admission?: KoiosAdmission): Promise<any> => {
    const response = await blockfrostApiCall(endpointSegment, {
        ...admission, minIntervalMs: Math.max(BLOCKFROST_FALLBACK_MIN_INTERVAL_MS, admission?.minIntervalMs ?? 0)
    });
    if (!response.ok) {
        const error: any = new Error(`Blockfrost ${endpointSegment}: ${response.status} ${response.statusText}`);
        error.status = response.status;
        throw error;
    }
    return response.json();
};

export const fetchBlockfrostTxHashes = async (blockHashes: string[], admission?: KoiosAdmission): Promise<{ block_hash: string; tx_hash: string }[]> => {
    const rows: { block_hash: string; tx_hash: string }[] = [];
    for (const blockHash of blockHashes) {
        const txHashes = await fetchPaginatedResults<string>(`blocks/${blockHash}/txs`, Infinity, admission);
        for (const tx_hash of txHashes) rows.push({ block_hash: blockHash, tx_hash });
    }
    return rows;
};

export const fetchBlockfrostTxInfo = async (txHash: string, admission?: KoiosAdmission): Promise<KoiosTxInfo> => {
    const txData = await blockfrostFallbackJson(`txs/${txHash}`, admission);
    const utxoData = await blockfrostFallbackJson(`txs/${txHash}/utxos`, admission);

    // Compute minted/burned assets from input/output difference
    const assetTotals = new Map<string, bigint>();
    for (const output of utxoData.outputs ?? []) {
        if (output.collateral) continue;
        for (const { unit, quantity } of output.amount ?? []) {
            if (unit === 'lovelace') continue;
            assetTotals.set(unit, (assetTotals.get(unit) ?? 0n) + BigInt(quantity));
        }
    }
    for (const input of utxoData.inputs ?? []) {
        if (input.collateral || input.reference) continue;
        for (const { unit, quantity } of input.amount ?? []) {
            if (unit === 'lovelace') continue;
            assetTotals.set(unit, (assetTotals.get(unit) ?? 0n) - BigInt(quantity));
        }
    }

    const assets_minted: KoiosAsset[] = [];
    for (const [unit, qty] of assetTotals) {
        if (qty === 0n) continue;
        assets_minted.push({
            policy_id: unit.slice(0, 56),
            asset_name: unit.slice(56),
            quantity: qty.toString(),
            decimals: 0,
            fingerprint: ''
        });
    }

    // Map outputs to KoiosOutput format
    const outputs: KoiosOutput[] = (utxoData.outputs ?? [])
        .filter((o: any) => !o.collateral)
        .map((o: any) => ({
            tx_hash: txHash,
            tx_index: o.output_index,
            datum_hash: o.data_hash ?? null,
            stake_addr: null,
            value: o.amount?.find((a: any) => a.unit === 'lovelace')?.quantity ?? '0',
            payment_addr: { bech32: o.address ?? '', cred: '' },
            asset_list: (o.amount ?? [])
                .filter((a: any) => a.unit !== 'lovelace')
                .map((a: any) => ({
                    policy_id: a.unit.slice(0, 56),
                    asset_name: a.unit.slice(56),
                    quantity: a.quantity,
                    decimals: 0,
                    fingerprint: ''
                })),
            inline_datum: o.inline_datum ? { bytes: o.inline_datum, value: {} } : null,
            reference_script: null as { bytes: string; type: string } | null
        }));

    // Fetch reference script bytes AND the language-tag metadata for outputs
    // that have them. The /cbor endpoint only returns the bytes — the language
    // lives on /scripts/{hash} and we need it so the api computes the right
    // validator hash for V1/V2/V3 scripts (was hardcoded V2). If the cbor
    // fetch fails with anything but 404 the throw propagates so the scanner
    // halts cleanly (same posture as dabea7e/6772557 for incomplete coverage).
    for (const output of outputs) {
        const bfOutput = (utxoData.outputs ?? []).find((o: any) => o.output_index === output.tx_index && !o.collateral);
        if (bfOutput?.reference_script_hash) {
            // 404 = the chain has no script bytes registered for this hash.
            // Match the fetchBlockfrostDatumCbor posture: persist no script
            // and move on. Other errors propagate (transient 5xx, network)
            // so the scanner halts and retries cleanly.
            // Fetch BOTH the cbor and the script-type metadata. The type
            // (plutusV1/V2/V3, camelCase from Blockfrost) flows into
            // handle.script.type and feeds the validator-hash language
            // tag in scripts.service.ts. Hardcoding 'plutusV2' (the
            // historical default) produced wrong hashes for V3 scripts
            // and broke BFF tx builders that look up the script address
            // by validatorHash. Mirror the koios path which also passes
            // through Blockfrost's camelCase type raw.
            let scriptCbor: { cbor?: string };
            try {
                scriptCbor = await blockfrostFallbackJson(`scripts/${bfOutput.reference_script_hash}/cbor`, admission);
            } catch (e: any) {
                if (isRequestDeadlineError(e) || e?.status !== 404) throw e;
                continue;
            }
            if (!scriptCbor?.cbor) continue;
            // Once bytes exist, even a metadata 404 is unknown language,
            // not evidence of script absence. Preserve the actual read error.
            const scriptMeta = await blockfrostFallbackJson(`scripts/${bfOutput.reference_script_hash}`, admission);
            if (typeof scriptMeta?.type !== 'string' || !scriptMeta.type.trim()) {
                throw new Error(`Blockfrost script ${bfOutput.reference_script_hash}: missing language metadata`);
            }
            output.reference_script = { bytes: scriptCbor.cbor, type: scriptMeta.type };
        }
    }

    // Map inputs
    const inputs = (utxoData.inputs ?? [])
        .filter((i: any) => !i.collateral && !i.reference)
        .map((i: any) => ({ tx_hash: i.tx_hash, tx_index: i.output_index }));

    const reference_inputs = (utxoData.inputs ?? [])
        .filter((i: any) => i.reference)
        .map((i: any) => ({ tx_hash: i.tx_hash, tx_index: i.output_index }));

    // Fetch metadata only if assets were minted/burned (721 metadata only exists for mints)
    let metadata: KoiosTxInfo['metadata'] = {};
    if (txData.asset_mint_or_burn_count > 0) {
        try {
            const metadataArray = await blockfrostFallbackJson(`txs/${txHash}/metadata`, admission);
            if (Array.isArray(metadataArray)) {
                for (const entry of metadataArray) {
                    metadata[entry.label] = entry.json_metadata;
                }
            }
        } catch (e: any) {
            if (isRequestDeadlineError(e) || e?.status !== 404) throw e;
            Logger.log({
                message: `Failed to fetch metadata for ${txHash}: ${e?.message ?? e}`,
                category: LogCategory.NOTIFY,
                event: 'blockfrostFallback.metadataFetchFailed'
            });
        }
    }

    return {
        tx_hash: txHash,
        block_hash: txData.block ?? '',
        block_height: txData.block_height ?? 0,
        absolute_slot: txData.slot ?? 0,
        reference_inputs,
        outputs,
        inputs,
        assets_minted,
        metadata
    };
};

export const fetchBlockfrostDatumCbor = async (datumHash: string, admission?: KoiosAdmission): Promise<string | null> => {
    try {
        const data = await blockfrostFallbackJson(`scripts/datum/${datumHash}/cbor`, admission);
        return data?.cbor ?? null;
    } catch (e: any) {
        // 404 = the chain has no datum bytes registered for this hash. That is a
        // legitimate state (e.g. a datum hash referenced in a tx where the bytes
        // were never published). Persist null and move on; this is NOT a coverage
        // gap, it's the chain saying the datum doesn't exist. Transient errors
        // (5xx, network) must throw so the scanner halts and retries cleanly.
        if (!isRequestDeadlineError(e) && e?.status === 404) return null;
        throw e;
    }
};
