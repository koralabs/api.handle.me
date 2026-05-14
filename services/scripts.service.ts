import { bech32AddressFromHashes, blake2b, HandleSearchModel, ScriptDetails, ScriptType, StoredHandle } from '@koralabs/kora-labs-common';
import { Request } from 'express';
import { parse as parseYaml } from 'yaml';
import { IRegistry } from '../interfaces/registry.interface';
import { HandlesRepository } from '../repositories/handlesRepository';

const SCRIPT_ROOT_HANDLE = 'handlecontract';
const MAX_SCRIPT_RESULTS = '50000';
const HANDLE_SUFFIX = `@${SCRIPT_ROOT_HANDLE}`;
const DEFAULT_NETWORK = 'preview';
const GITHUB_RAW_BASE_URL = 'https://raw.githubusercontent.com/koralabs';
const SCRIPT_SOURCES: Record<ScriptType, { slug: string; repo: string; deploymentStatePath?: string }> = {
    [ScriptType.PZ_CONTRACT]: { slug: 'pers', repo: 'handles-personalization', deploymentStatePath: 'deploy/${network}/personalization.yaml' },
    [ScriptType.SUB_HANDLE_SETTINGS]: { slug: 'subh', repo: 'handles-subhandle-settings' },
    [ScriptType.MARKETPLACE_CONTRACT]: { slug: 'mkpl', repo: 'handles-marketplace-contracts' },
    [ScriptType.DEMI_MINT_PROXY]: { slug: 'demimntprx', repo: 'decentralized-minting' },
    [ScriptType.DEMI_MINT]: { slug: 'demimnt', repo: 'decentralized-minting' },
    [ScriptType.DEMI_MINTING_DATA]: { slug: 'demimntmpt', repo: 'decentralized-minting' },
    [ScriptType.DEMI_ORDERS]: { slug: 'demiord', repo: 'decentralized-minting' },
    [ScriptType.HAL_MINT_PROXY]: { slug: 'halmntprx', repo: 'hal-minting-contracts' },
    [ScriptType.HAL_MINT]: { slug: 'halmnt', repo: 'hal-minting-contracts' },
    [ScriptType.HAL_MINTING_DATA]: { slug: 'halmntmpt', repo: 'hal-minting-contracts' },
    [ScriptType.HAL_ORDERS_SPEND]: { slug: 'halord', repo: 'hal-minting-contracts' },
    [ScriptType.HAL_REF_SPEND_PROXY]: { slug: 'halrefprx', repo: 'hal-minting-contracts' },
    [ScriptType.HAL_REF_SPEND]: { slug: 'halref', repo: 'hal-minting-contracts' },
    [ScriptType.HAL_ROYALTY_SPEND]: { slug: 'halroy', repo: 'hal-minting-contracts' }
};
// V3 personalization split: persprx + 3 observers (perspz, perslfc, persdsg)
// all share repo/sources with the legacy `pers` (PZ_CONTRACT) family but have
// distinct on-chain validators. We expose each via its specific slug as the
// `type` field in /scripts so the BFF can pick the right script for spend
// vs observer roles. They all roll up to ScriptType.PZ_CONTRACT for
// repo/deployment-state/unoptimized-cbor lookups.
const PZ_V3_SUB_SLUGS = ['persprx', 'perspz', 'perslfc', 'persdsg'] as const;

// Ordered slug → script-family mapping. Longest slug first so parser prefers
// `persprx` over `pers`. Each entry tracks the response `type` (the specific
// slug, exposed to callers) and the `sourceType` (ScriptType used to look up
// SCRIPT_SOURCES for repo/url details).
const SCRIPT_HANDLE_SLUGS: Array<{ slug: string; type: string; sourceType: ScriptType }> = [
    ...PZ_V3_SUB_SLUGS.map((slug) => ({ slug, type: slug as string, sourceType: ScriptType.PZ_CONTRACT })),
    ...Object.entries(SCRIPT_SOURCES).map(([type, source]) => ({
        slug: source.slug,
        type: type as ScriptType,
        sourceType: type as ScriptType
    }))
].sort((a, b) => b.slug.length - a.slug.length);

const SCRIPT_TYPES_BY_SLUG = SCRIPT_HANDLE_SLUGS.map((entry) => [entry.slug, entry.sourceType] as const);
const LEGACY_SCRIPT_TYPE_ALIASES: Record<string, ScriptType> = {
    pz_contract: ScriptType.PZ_CONTRACT,
    sub_handle_settings: ScriptType.SUB_HANDLE_SETTINGS,
    marketplace_contract: ScriptType.MARKETPLACE_CONTRACT,
    demi_mint_proxy: ScriptType.DEMI_MINT_PROXY,
    demi_mint: ScriptType.DEMI_MINT,
    demi_minting_data: ScriptType.DEMI_MINTING_DATA,
    demi_orders: ScriptType.DEMI_ORDERS,
    hal_mint_proxy: ScriptType.HAL_MINT_PROXY,
    hal_mint: ScriptType.HAL_MINT,
    hal_minting_data: ScriptType.HAL_MINTING_DATA,
    hal_orders_spend: ScriptType.HAL_ORDERS_SPEND,
    hal_ref_spend_proxy: ScriptType.HAL_REF_SPEND_PROXY,
    hal_ref_spend: ScriptType.HAL_REF_SPEND,
    hal_royalty_spend: ScriptType.HAL_ROYALTY_SPEND
};
// Resolve `?type=X` query param to the ScriptType used for the candidate
// search. V3 sub-slugs (persprx etc.) all map to PZ_CONTRACT so the search
// returns every `pers*@handlecontract` candidate; the per-handle parser then
// records the specific sub-slug.
const SCRIPT_TYPE_BY_QUERY: Record<string, ScriptType> = {
    ...Object.fromEntries(Object.entries(SCRIPT_SOURCES).map(([type, source]) => [source.slug, type as ScriptType])),
    ...Object.fromEntries(PZ_V3_SUB_SLUGS.map((slug) => [slug, ScriptType.PZ_CONTRACT]))
};

const createRepo = (req: Request<any>): HandlesRepository | null => {
    const registry = req.app?.get?.('registry') as IRegistry | undefined;
    if (!registry?.handlesStore) {
        return null;
    }

    return new HandlesRepository(new registry.handlesStore());
};

const parseScriptHandle = (handleName: string): { type: ScriptType; responseType: string; ordinal: number } | null => {
    const normalizedName = `${handleName}`.toLowerCase();
    if (!normalizedName.endsWith(HANDLE_SUFFIX)) {
        return null;
    }

    const slugWithOrdinal = normalizedName.slice(0, -HANDLE_SUFFIX.length);
    // SCRIPT_HANDLE_SLUGS is longest-first so persprx wins over pers, etc.
    // Continue past non-digit-suffix matches instead of returning null —
    // a longer slug like `persprx` could shadow a still-valid shorter
    // slug like `pers`, but only the digit-suffix variant is a real handle.
    for (const { slug, sourceType, type } of SCRIPT_HANDLE_SLUGS) {
        if (!slugWithOrdinal.startsWith(slug)) {
            continue;
        }

        const ordinal = slugWithOrdinal.slice(slug.length);
        if (!/^\d+$/.test(ordinal)) {
            continue;
        }

        return {
            type: sourceType,
            responseType: type,
            ordinal: Number.parseInt(ordinal, 10)
        };
    }

    return null;
};

const getNetwork = () => {
    const network = process.env.NETWORK?.toLowerCase();
    return network === 'mainnet' || network === 'preprod' ? network : DEFAULT_NETWORK;
};

const getUnoptimizedCborUrl = (type: ScriptType) => {
    const source = SCRIPT_SOURCES[type];
    if (!source) {
        return null;
    }

    return `${GITHUB_RAW_BASE_URL}/${source.repo}/master/deploy/${getNetwork()}/${source.slug}.unoptimized.cbor`;
};

const getDeploymentStateUrl = (type: ScriptType) => {
    const source = SCRIPT_SOURCES[type];
    if (!source?.deploymentStatePath) {
        return null;
    }

    return `${GITHUB_RAW_BASE_URL}/${source.repo}/master/${source.deploymentStatePath.replace('${network}', getNetwork())}`;
};

export const resolveScriptTypeQuery = (type?: string): ScriptType | undefined => {
    if (!type) {
        return;
    }

    return SCRIPT_TYPE_BY_QUERY[type.toLowerCase()] ?? LEGACY_SCRIPT_TYPE_ALIASES[type.toLowerCase()];
};

export const resolvePreferredScriptTypeForHandleName = (handleName?: string): ScriptType => {
    const normalizedHandleName = `${handleName ?? ''}`.toLowerCase();
    if (/^pz_contract_\d+$/i.test(normalizedHandleName)) {
        return ScriptType.PZ_CONTRACT;
    }

    if (normalizedHandleName.endsWith(HANDLE_SUFFIX)) {
        const slugWithOrdinal = normalizedHandleName.slice(0, -HANDLE_SUFFIX.length);
        const match = SCRIPT_TYPES_BY_SLUG.find(([slug]) => {
            if (!slugWithOrdinal.startsWith(slug)) {
                return false;
            }

            return /^\d+$/.test(slugWithOrdinal.slice(slug.length));
        });
        if (match) {
            return match[1];
        }
    }

    return ScriptType.PZ_CONTRACT;
};

const fetchUnoptimizedCbor = async (type: ScriptType, cache: Map<ScriptType, Promise<string | undefined>>) => {
    const cached = cache.get(type);
    if (cached) {
        return cached;
    }

    const url = getUnoptimizedCborUrl(type);
    const request = (async () => {
        if (!url) {
            return;
        }

        try {
            const response = await fetch(url);
            if (!response.ok) {
                return;
            }

            const unoptimizedCbor = (await response.text()).trim();
            return unoptimizedCbor || undefined;
        } catch {
            return;
        }
    })();

    cache.set(type, request);
    return request;
};

const fetchAssignedScriptHandles = async (type: ScriptType, cache: Map<ScriptType, Promise<string[] | undefined>>) => {
    const cached = cache.get(type);
    if (cached) {
        return cached;
    }

    const url = getDeploymentStateUrl(type);
    const request = (async () => {
        if (!url) {
            return;
        }

        try {
            const response = await fetch(url);
            if (!response.ok) {
                return;
            }

            const payload = parseYaml(await response.text()) as {
                assigned_handles?: { scripts?: unknown };
            } | null;
            const handles = payload?.assigned_handles?.scripts;
            if (!Array.isArray(handles)) {
                return;
            }

            const normalizedHandles = handles
                .map((handle) => `${handle}`.trim())
                .filter((handle) => handle.length > 0);
            return normalizedHandles.length > 0 ? normalizedHandles : undefined;
        } catch {
            return;
        }
    })();

    cache.set(type, request);
    return request;
};

export const getScriptSlug = (type: ScriptType) => SCRIPT_SOURCES[type]?.slug ?? type;

// Map possible script.type strings (varies by indexer / fallback path) to
// the canonical Plutus language tag byte. Cardano on-chain Plutus script_hash
// = blake2b-224(language_tag || cbor_bytes); V1=0x01, V2=0x02, V3=0x03.
const PLUTUS_LANGUAGE_TAGS: Record<string, string> = {
    plutusV1: '01',
    plutusV2: '02',
    plutusV3: '03',
    PlutusScriptV1: '01',
    PlutusScriptV2: '02',
    PlutusScriptV3: '03',
    'plutus:v1': '01',
    'plutus:v2': '02',
    'plutus:v3': '03'
};

const getValidatorHashFromScriptCbor = (scriptCbor?: string, scriptType?: string) => {
    if (!scriptCbor || !/^[0-9a-f]+$/i.test(scriptCbor) || scriptCbor.length % 2 !== 0) {
        return null;
    }
    const tag = (scriptType && PLUTUS_LANGUAGE_TAGS[scriptType]) || '02';
    return blake2b(Buffer.from(`${tag}${scriptCbor}`, 'hex'), 28);
};

// Resolve the script's actual on-chain plutus version by querying Blockfrost
// for which of {V1,V2,V3}-tagged hash exists. The api's stored
// `script.type` field is unreliable (the koios-fallback path historically
// hardcoded PlutusScriptV2 regardless of actual). The chain is the source
// of truth — only one of the three hashes will resolve.
const resolveOnChainScriptVersion = async (scriptCbor: string): Promise<string | null> => {
    const hashes: Array<[string, string]> = [
        ['plutusV1', blake2b(Buffer.from(`01${scriptCbor}`, 'hex'), 28)],
        ['plutusV2', blake2b(Buffer.from(`02${scriptCbor}`, 'hex'), 28)],
        ['plutusV3', blake2b(Buffer.from(`03${scriptCbor}`, 'hex'), 28)]
    ];
    const network = (process.env.NETWORK?.toLowerCase() ?? 'preview');
    const apiKey = process.env.BLOCKFROST_API_KEY ?? '';
    if (!apiKey) return null;
    const baseUrl = `https://cardano-${network}.blockfrost.io/api/v0`;
    for (const [version, hash] of hashes) {
        try {
            const r = await fetch(`${baseUrl}/scripts/${hash}`, { headers: { project_id: apiKey } });
            if (r.ok) {
                const j = await r.json() as { type?: string };
                if (j.type === version) return version;
            }
        } catch { /* ignore */ }
    }
    return null;
};

const buildScriptEntry = async (
    handle: StoredHandle,
    type: ScriptType,
    latest: boolean,
    unoptimizedCbor: string | undefined,
    scriptSourceHandle: StoredHandle = handle,
    responseType: string = type
): Promise<[string, ScriptDetails] | null> => {
    const refScriptAddress = scriptSourceHandle.resolved_addresses?.ada;
    const cbor = scriptSourceHandle.script?.cbor;
    if (!cbor) return null;
    // Always probe Blockfrost for the actual on-chain plutus version.
    // We can't trust scriptSourceHandle.script.type because the
    // historical koios-fallback indexing path hardcoded PlutusScriptV2
    // for every reference script, regardless of its actual on-chain type.
    // Only fall back to the stored type if the probe fails (no API key,
    // network error). Cached in memory at the module level for the request
    // lifetime so we don't hammer Blockfrost on every /scripts call.
    let scriptType = await resolveOnChainScriptVersion(cbor)
        ?? scriptSourceHandle.script?.type
        ?? 'plutusV2';
    const validatorHash = getValidatorHashFromScriptCbor(cbor, scriptType);
    if (!refScriptAddress || !validatorHash) {
        return null;
    }

    const scriptAddress = bech32AddressFromHashes(
        validatorHash,
        'script',
        '',
        'key',
        'addr',
        (process.env.NETWORK?.toLowerCase() ?? 'preview') !== 'mainnet'
    );

    return [
        scriptAddress,
        {
            handle: handle.name,
            handleHex: handle.hex,
            refScriptAddress,
            refScriptUtxo: scriptSourceHandle.utxo,
            cbor,
            unoptimizedCbor,
            validatorHash,
            latest,
            type: responseType as ScriptType
        }
    ];
};

const getCandidateHandles = (req: Request<any>, type?: ScriptType): StoredHandle[] => {
    const handleRepo = createRepo(req);
    if (!handleRepo) {
        return [];
    }

    const search = type ? SCRIPT_SOURCES[type].slug : undefined;

    return handleRepo.search(
        { handlesPerPage: Number(MAX_SCRIPT_RESULTS), sort: 'asc', page: 1 } as any,
        new HandleSearchModel({
            root_handle: SCRIPT_ROOT_HANDLE,
            search
        } as ConstructorParameters<typeof HandleSearchModel>[0] & { root_handle?: string })
    ).handles as StoredHandle[];
};

export const getScriptsIndex = async (req: Request<any>, type?: ScriptType): Promise<{ [scriptAddress: string]: ScriptDetails }> => {
    const handleRepo = createRepo(req);
    if (!handleRepo) {
        return {};
    }

    const matchesByType = new Map<ScriptType, { handle: StoredHandle; ordinal: number; responseType: string }[]>();

    for (const handle of getCandidateHandles(req, type)) {
        const match = parseScriptHandle(handle.name);
        if (!match || (type && match.type !== type)) {
            continue;
        }

        const matches = matchesByType.get(match.type) ?? [];
        matches.push({ handle, ordinal: match.ordinal, responseType: match.responseType });
        matchesByType.set(match.type, matches);
    }

    const scripts: { [scriptAddress: string]: ScriptDetails } = {};
    const unoptimizedCborCache = new Map<ScriptType, Promise<string | undefined>>();
    const assignedScriptHandlesCache = new Map<ScriptType, Promise<string[] | undefined>>();

    for (const [scriptType, matches] of matchesByType.entries()) {
        const matchesWithScript = matches.filter(({ handle }) => !!handle.script?.cbor);
        const latestOrdinal = matchesWithScript.length > 0
            ? Math.max(...matchesWithScript.map(({ ordinal }) => ordinal))
            : Math.max(...matches.map(({ ordinal }) => ordinal));
        const unoptimizedCbor = await fetchUnoptimizedCbor(scriptType, unoptimizedCborCache);
        const assignedScriptHandles = await fetchAssignedScriptHandles(scriptType, assignedScriptHandlesCache);
        const activeAssignedHandleName = assignedScriptHandles
            ?.map((handleName) => handleRepo.getHandle(handleName))
            .find((handle): handle is StoredHandle => !!handle?.script?.cbor)
            ?.name
            ?.toLowerCase();
        // For PZ V3 we have multiple sub-slug families (persprx, perspz,
        // perslfc, persdsg) all sharing scriptType=PZ_CONTRACT. Each
        // sub-family needs its own latest ordinal, otherwise persdsg2's
        // higher ordinal would shadow persprx2 etc. Group by responseType
        // for the latest-ordinal computation.
        const matchesByResponseType = new Map<string, typeof matches>();
        for (const m of matches) {
            const arr = matchesByResponseType.get(m.responseType) ?? [];
            arr.push(m);
            matchesByResponseType.set(m.responseType, arr);
        }
        const latestOrdinalByResponseType = new Map<string, number>();
        for (const [respType, arr] of matchesByResponseType.entries()) {
            const arrWithScript = arr.filter(({ handle }) => !!handle.script?.cbor);
            const latest = arrWithScript.length > 0
                ? Math.max(...arrWithScript.map(({ ordinal }) => ordinal))
                : Math.max(...arr.map(({ ordinal }) => ordinal));
            latestOrdinalByResponseType.set(respType, latest);
        }

        for (const { handle, ordinal, responseType } of matches) {
            const familyLatestOrdinal = latestOrdinalByResponseType.get(responseType) ?? latestOrdinal;
            const scriptEntry = await buildScriptEntry(
                handle,
                scriptType,
                activeAssignedHandleName
                    ? handle.name.toLowerCase() === activeAssignedHandleName
                    : ordinal === familyLatestOrdinal,
                unoptimizedCbor,
                handle,
                responseType
            );
            if (scriptEntry) {
                scripts[scriptEntry[0]] = scriptEntry[1];
            }
        }

        if (activeAssignedHandleName && !matches.some(({ handle }) => handle.name.toLowerCase() === activeAssignedHandleName)) {
            const activeAssignedHandle = handleRepo.getHandle(activeAssignedHandleName);
            if (activeAssignedHandle?.script?.cbor) {
                const activeMatch = parseScriptHandle(activeAssignedHandle.name);
                const scriptEntry = await buildScriptEntry(
                    activeAssignedHandle,
                    scriptType,
                    true,
                    unoptimizedCbor,
                    activeAssignedHandle,
                    activeMatch?.responseType ?? scriptType
                );
                if (scriptEntry) {
                    scripts[scriptEntry[0]] = scriptEntry[1];
                }
            }
        }
    }

    return scripts;
};

export const getScriptByRefAddress = async (
    req: Request<any>,
    refScriptAddress?: string,
    type?: ScriptType
): Promise<ScriptDetails | undefined> => {
    if (!refScriptAddress) {
        return;
    }

    const matches = Object.values(await getScriptsIndex(req, type)).filter((script) => script.refScriptAddress === refScriptAddress);
    return matches.find((script) => script.latest) ?? matches[0];
};
