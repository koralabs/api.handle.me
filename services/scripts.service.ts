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
const SCRIPT_TYPES_BY_SLUG = Object.entries(SCRIPT_SOURCES)
    .sort(([, left], [, right]) => right.slug.length - left.slug.length)
    .map(([type, source]) => [source.slug, type as ScriptType] as const);
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
const SCRIPT_TYPE_BY_QUERY = Object.fromEntries(
    Object.entries(SCRIPT_SOURCES).flatMap(([type, source]) => [[source.slug, type as ScriptType]])
) as Record<string, ScriptType>;

const createRepo = (req: Request<any>): HandlesRepository | null => {
    const registry = req.app?.get?.('registry') as IRegistry | undefined;
    if (!registry?.handlesStore) {
        return null;
    }

    return new HandlesRepository(new registry.handlesStore());
};

// Some app slugs (notably PZ V3 — `pers`) split the validator across multiple
// roles and use a `<slug><role><ordinal>` SubHandle naming scheme:
//   pers6@handlecontract                  → V2 monolith (no role)
//   persprx1 / perspz1 / perslfc1 /
//     persdsg1 @handlecontract              → V3 split (proxy / personalize /
//                                                       lifecycle / designer-
//                                                       settings observers)
// All four V3 SubHandles map to ScriptType.PZ_CONTRACT and are exposed
// individually in /scripts (the BFF picks per-validator by handle name).
//
// `proxy` is the spend script — the address callers migrate to. Observers
// are withdraw-zero validators delegated to from the proxy; they have no
// spend side and must never be returned as a migration target.
type ScriptRole = 'proxy' | 'observer';

const PERS_V3_ROLE_KIND: Record<string, ScriptRole> = {
    prx: 'proxy',
    pz: 'observer',
    lfc: 'observer',
    dsg: 'observer'
};

type ParsedScriptHandle = {
    type: ScriptType;
    ordinal: number;
    role?: ScriptRole;
};

const parseScriptHandle = (handleName: string): ParsedScriptHandle | null => {
    const normalizedName = `${handleName}`.toLowerCase();
    if (!normalizedName.endsWith(HANDLE_SUFFIX)) {
        return null;
    }

    const slugWithOrdinal = normalizedName.slice(0, -HANDLE_SUFFIX.length);
    for (const [slug, type] of SCRIPT_TYPES_BY_SLUG) {
        if (!slugWithOrdinal.startsWith(slug)) {
            continue;
        }

        let ordinal = slugWithOrdinal.slice(slug.length);
        let role: ScriptRole | undefined;
        if (slug === 'pers' && !/^\d+$/.test(ordinal)) {
            const roleMatch = ordinal.match(/^(prx|pz|lfc|dsg)(\d+)$/);
            if (roleMatch) {
                role = PERS_V3_ROLE_KIND[roleMatch[1]];
                ordinal = roleMatch[2];
            }
        }
        if (!/^\d+$/.test(ordinal)) {
            return null;
        }

        return {
            type,
            ordinal: Number.parseInt(ordinal, 10),
            role
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
// sources:
//   - ogmios scanner: `script.language.replace(':', '_')` → `plutus_v1` /
//     `plutus_v2` / `plutus_v3` (snake_case)
//   - koios `reference_script.type`, blockfrost `scripts/{hash}.type`:
//     `plutusV1` / `plutusV2` / `plutusV3` (camelCase)
//   - legacy older scans: `PlutusScriptV1` / `PlutusScriptV2`
// Anything we don't recognize falls back to V2 — historically the only
// Plutus version the api ingested.
const PLUTUS_LANGUAGE_PREFIX: Record<string, string> = {
    plutus_v1: '01',
    plutus_v2: '02',
    plutus_v3: '03',
    plutusV1: '01',
    plutusV2: '02',
    plutusV3: '03',
    PlutusScriptV1: '01',
    PlutusScriptV2: '02',
    PlutusScriptV3: '03'
};

const getValidatorHashFromScript = (script?: { cbor?: string; type?: string }) => {
    const cbor = script?.cbor;
    if (!cbor || !/^[0-9a-f]+$/i.test(cbor) || cbor.length % 2 !== 0) {
        return null;
    }

    const prefix = PLUTUS_LANGUAGE_PREFIX[script?.type ?? ''] ?? '02';
    return blake2b(Buffer.from(`${prefix}${cbor}`, 'hex'), 28);
};

const buildScriptEntry = async (
    handle: StoredHandle,
    type: ScriptType,
    latest: boolean,
    unoptimizedCbor: string | undefined,
    scriptSourceHandle: StoredHandle = handle
): Promise<[string, ScriptDetails] | null> => {
    const refScriptAddress = scriptSourceHandle.resolved_addresses?.ada;
    const validatorHash = getValidatorHashFromScript(scriptSourceHandle.script);
    if (!refScriptAddress || !validatorHash || !scriptSourceHandle.script?.cbor) {
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
            cbor: scriptSourceHandle.script.cbor,
            unoptimizedCbor,
            validatorHash,
            latest,
            type
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

    const matchesByType = new Map<ScriptType, { handle: StoredHandle; ordinal: number }[]>();

    for (const handle of getCandidateHandles(req, type)) {
        const match = parseScriptHandle(handle.name);
        if (!match || (type && match.type !== type)) {
            continue;
        }

        const matches = matchesByType.get(match.type) ?? [];
        matches.push({ handle, ordinal: match.ordinal });
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
        const activeAssignedHandleNames = new Set<string>(
            (assignedScriptHandles ?? [])
                .map((handleName) => handleRepo.getHandle(handleName))
                .filter((handle): handle is StoredHandle => !!handle?.script?.cbor)
                .map((handle) => handle.name.toLowerCase())
        );
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

        for (const { handle, ordinal } of matches) {
            const unoptimizedCbor = await unoptimizedCborFor(handle.name);
            const scriptEntry = await buildScriptEntry(
                handle,
                scriptType,
                activeAssignedHandleNames.size > 0
                    ? activeAssignedHandleNames.has(handle.name.toLowerCase())
                    : ordinal === latestOrdinal,
                unoptimizedCbor
            );
            if (scriptEntry) {
                scripts[scriptEntry[0]] = scriptEntry[1];
            }
        }

        const matchedNames = new Set(matches.map(({ handle }) => handle.name.toLowerCase()));
        for (const assignedName of activeAssignedHandleNames) {
            if (matchedNames.has(assignedName)) continue;
            const assignedHandle = handleRepo.getHandle(assignedName);
            if (assignedHandle?.script?.cbor) {
                const unoptimizedCbor = await unoptimizedCborFor(assignedHandle.name);
                const scriptEntry = await buildScriptEntry(assignedHandle, scriptType, true, unoptimizedCbor);
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
