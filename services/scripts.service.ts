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

// PZ V3 splits the `pers` family into a spend proxy + three observer
// validators (persprx + perspz/perslfc/persdsg). Each is exposed in
// /scripts as its own slug — the BFF picks the right validator by name.
// Only `persprx` is the spend script (migration target); observers are
// withdraw-zero validators delegated to from the proxy.
type ScriptRole = 'proxy' | 'observer';

const PERS_V3_ROLE_KIND: Record<string, ScriptRole> = {
    persprx: 'proxy',
    perspz: 'observer',
    perslfc: 'observer',
    persdsg: 'observer'
};

const parseScriptHandle = (
    handleName: string
): { type: ScriptType; responseType: string; ordinal: number; role?: ScriptRole } | null => {
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
            ordinal: Number.parseInt(ordinal, 10),
            role: PERS_V3_ROLE_KIND[slug]
        };
    }

    return null;
};

const getNetwork = () => {
    const network = process.env.NETWORK?.toLowerCase();
    return network === 'mainnet' || network === 'preprod' ? network : DEFAULT_NETWORK;
};

const getUnoptimizedCborUrl = (type: ScriptType, slugOverride?: string) => {
    const source = SCRIPT_SOURCES[type];
    if (!source) {
        return null;
    }

    // For families that split one ScriptType across multiple validators
    // (notably PZ V3 — persprx + perspz + perslfc + persdsg all map to
    // PZ_CONTRACT), each validator publishes its own unoptimized cbor at
    // `deploy/<network>/<role-slug>.unoptimized.cbor`. The caller passes
    // the role slug parsed from the handle name. Without an override we
    // fall back to the family-level `<type-slug>.unoptimized.cbor`.
    const slug = slugOverride ?? source.slug;
    return `${GITHUB_RAW_BASE_URL}/${source.repo}/master/deploy/${getNetwork()}/${slug}.unoptimized.cbor`;
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

const fetchUnoptimizedCbor = async (
    type: ScriptType,
    cache: Map<string, Promise<string | undefined>>,
    slugOverride?: string
) => {
    const cacheKey = `${type}::${slugOverride ?? ''}`;
    const cached = cache.get(cacheKey);
    if (cached) {
        return cached;
    }

    const url = getUnoptimizedCborUrl(type, slugOverride);
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

    cache.set(cacheKey, request);
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

// Plutus validator hash = blake2b-224(<lang-tag> || cbor). The leading byte
// tags the language so a script's hash differs across versions even when
// the bytes are identical. The api stores `script.type` from upstream data
// sources, each of which uses a different casing/punctuation:
//   - ogmios scanner: `script.language.replace(':', '_')` → `plutus_v1` /
//     `plutus_v2` / `plutus_v3` (snake_case)
//   - koios `reference_script.type`, blockfrost `scripts/{hash}.type`:
//     `plutusV1` / `plutusV2` / `plutusV3` (camelCase)
//   - legacy older scans: `PlutusScriptV1` / `PlutusScriptV2` / `PlutusScriptV3`
//   - raw ogmios (pre-normalization): `plutus:v1` / `plutus:v2` / `plutus:v3`
// Anything we don't recognize falls back to V2 — historically the only
// Plutus version the api ingested.
const PLUTUS_LANGUAGE_TAGS: Record<string, string> = {
    plutus_v1: '01',
    plutus_v2: '02',
    plutus_v3: '03',
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
    // Probe Blockfrost for the actual on-chain plutus version when possible.
    // The stored script.type is unreliable on legacy entries — the historical
    // koios-fallback indexing path hardcoded PlutusScriptV2 for every
    // reference script regardless of its actual on-chain type. Only fall
    // back to the stored type if the probe fails (no API key, network error).
    const scriptType = await resolveOnChainScriptVersion(cbor)
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
    const unoptimizedCborCache = new Map<string, Promise<string | undefined>>();
    const assignedScriptHandlesCache = new Map<ScriptType, Promise<string[] | undefined>>();

    // Extract the per-validator role slug from a SubHandle name when one is
    // present. e.g., `persprx1@handlecontract` → `persprx`. Returns undefined
    // for monolithic-validator handles like `pers6@handlecontract` so the
    // family-level `<type-slug>.unoptimized.cbor` is used.
    const HANDLECONTRACT_SUFFIX = '@handlecontract';
    const getRoleSlug = (handleName: string): string | undefined => {
        const lower = handleName.toLowerCase();
        if (!lower.endsWith(HANDLECONTRACT_SUFFIX)) return undefined;
        const stem = lower.slice(0, -HANDLECONTRACT_SUFFIX.length);
        // Match `<slug-with-letters><digits>` — the digit suffix is the
        // ordinal. The role slug is the letter prefix when it has letters
        // beyond the family slug.
        const m = stem.match(/^([a-z]+)\d+$/);
        if (!m) return undefined;
        return m[1];
    };

    for (const [scriptType, matches] of matchesByType.entries()) {
        const matchesWithScript = matches.filter(({ handle }) => !!handle.script?.cbor);
        const latestOrdinal = matchesWithScript.length > 0
            ? Math.max(...matchesWithScript.map(({ ordinal }) => ordinal))
            : Math.max(...matches.map(({ ordinal }) => ordinal));
        const familyUnoptimizedCbor = await fetchUnoptimizedCbor(scriptType, unoptimizedCborCache);
        const familySlug = SCRIPT_SOURCES[scriptType]?.slug;
        const assignedScriptHandles = await fetchAssignedScriptHandles(scriptType, assignedScriptHandlesCache);
        // Per-response-type active assigned-handle name. PZ V3 splits one
        // ScriptType (PZ_CONTRACT) into four sub-families (persprx/perspz/
        // perslfc/persdsg), so each sub-family must mark its OWN deployment
        // head as `latest` — a single shared name would let one family's
        // head shadow another's.
        const activeAssignedHandleByResponseType = new Map<string, string>();
        for (const assignedName of assignedScriptHandles ?? []) {
            const assigned = handleRepo.getHandle(assignedName);
            if (!assigned?.script?.cbor) continue;
            const parsed = parseScriptHandle(assigned.name);
            if (!parsed) continue;
            if (!activeAssignedHandleByResponseType.has(parsed.responseType)) {
                activeAssignedHandleByResponseType.set(parsed.responseType, assigned.name.toLowerCase());
            }
        }
        // Per-response-type latest ordinal — otherwise persdsg2's higher
        // ordinal would shadow persprx2, etc.
        const latestOrdinalByResponseType = new Map<string, number>();
        const matchesByResponseType = new Map<string, typeof matches>();
        for (const m of matches) {
            const arr = matchesByResponseType.get(m.responseType) ?? [];
            arr.push(m);
            matchesByResponseType.set(m.responseType, arr);
        }
        for (const [respType, arr] of matchesByResponseType.entries()) {
            const arrWithScript = arr.filter(({ handle }) => !!handle.script?.cbor);
            const latest = arrWithScript.length > 0
                ? Math.max(...arrWithScript.map(({ ordinal }) => ordinal))
                : Math.max(...arr.map(({ ordinal }) => ordinal));
            latestOrdinalByResponseType.set(respType, latest);
        }
        // Resolve per-handle unoptimized cbor (used for split-validator
        // families like PZ V3). When the role slug differs from the family
        // slug we fetch a separate file; otherwise reuse the family-level cbor.
        const unoptimizedCborFor = async (handleName: string): Promise<string | undefined> => {
            const role = getRoleSlug(handleName);
            if (!role || role === familySlug) {
                return familyUnoptimizedCbor;
            }
            return fetchUnoptimizedCbor(scriptType, unoptimizedCborCache, role);
        };

        for (const { handle, ordinal, responseType } of matches) {
            const familyLatestOrdinal = latestOrdinalByResponseType.get(responseType) ?? latestOrdinal;
            const familyActive = activeAssignedHandleByResponseType.get(responseType);
            const isLatest = familyActive
                ? handle.name.toLowerCase() === familyActive
                : ordinal === familyLatestOrdinal;
            const unoptimizedCbor = await unoptimizedCborFor(handle.name);
            const scriptEntry = await buildScriptEntry(
                handle,
                scriptType,
                isLatest,
                unoptimizedCbor,
                handle,
                responseType
            );
            if (scriptEntry) {
                scripts[scriptEntry[0]] = scriptEntry[1];
            }
        }

        // For each response-type family with an active assigned handle that
        // wasn't included in the search matches, load and add it explicitly.
        for (const [familyResponseType, familyActiveName] of activeAssignedHandleByResponseType.entries()) {
            if (matches.some(({ handle, responseType }) =>
                responseType === familyResponseType && handle.name.toLowerCase() === familyActiveName
            )) {
                continue;
            }
            const activeAssignedHandle = handleRepo.getHandle(familyActiveName);
            if (activeAssignedHandle?.script?.cbor) {
                const unoptimizedCbor = await unoptimizedCborFor(activeAssignedHandle.name);
                const scriptEntry = await buildScriptEntry(
                    activeAssignedHandle,
                    scriptType,
                    true,
                    unoptimizedCbor,
                    activeAssignedHandle,
                    familyResponseType
                );
                if (scriptEntry) {
                    scripts[scriptEntry[0]] = scriptEntry[1];
                }
            }
        }
    }

    return scripts;
};

// `latest=true&type=X` answers "what is the canonical spend script of type X?"
// For legacy single-validator types (no role), the only latest entry is the
// answer. For V3 split types, every role is `latest: true` (so consumers like
// the BFF can discover the full quartet by name pattern), but only the proxy
// is the migration target — observers have no spend side.
export const findPrimaryLatestScript = (
    scripts: [string, ScriptDetails][]
): [string, ScriptDetails] | undefined => {
    const latestEntries = scripts.filter(([, value]) => value.latest);
    const proxy = latestEntries.find(([, value]) => parseScriptHandle(value.handle ?? '')?.role === 'proxy');
    if (proxy) return proxy;
    const legacy = latestEntries.find(([, value]) => parseScriptHandle(value.handle ?? '')?.role === undefined);
    return legacy ?? latestEntries[0];
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
