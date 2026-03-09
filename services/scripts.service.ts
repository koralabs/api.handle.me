import { bech32AddressFromHashes, blake2b, HandleSearchModel, ScriptDetails, ScriptType, StoredHandle } from '@koralabs/kora-labs-common';
import { Request } from 'express';
import { IRegistry } from '../interfaces/registry.interface';
import { HandlesRepository } from '../repositories/handlesRepository';

const SCRIPT_ROOT_HANDLE = 'handlecontract';
const MAX_SCRIPT_RESULTS = '50000';
const HANDLE_SUFFIX = `@${SCRIPT_ROOT_HANDLE}`;
const DEFAULT_NETWORK = 'preview';
const GITHUB_RAW_BASE_URL = 'https://raw.githubusercontent.com/koralabs';
const SCRIPT_SOURCES: Record<ScriptType, { slug: string; repo: string }> = {
    [ScriptType.PZ_CONTRACT]: { slug: 'pers', repo: 'handles-personalization' },
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
const SCRIPT_TYPE_BY_QUERY = Object.fromEntries(
    Object.entries(SCRIPT_SOURCES).flatMap(([type, source]) => [
        [type, type as ScriptType],
        [source.slug, type as ScriptType]
    ])
) as Record<string, ScriptType>;

const createRepo = (req: Request<any>): HandlesRepository | null => {
    const registry = req.app?.get?.('registry') as IRegistry | undefined;
    if (!registry?.handlesStore) {
        return null;
    }

    return new HandlesRepository(new registry.handlesStore());
};

const parseScriptHandle = (handleName: string): { type: ScriptType; ordinal: number } | null => {
    const normalizedName = `${handleName}`.toLowerCase();
    if (!normalizedName.endsWith(HANDLE_SUFFIX)) {
        return null;
    }

    const slugWithOrdinal = normalizedName.slice(0, -HANDLE_SUFFIX.length);
    for (const [slug, type] of SCRIPT_TYPES_BY_SLUG) {
        if (!slugWithOrdinal.startsWith(slug)) {
            continue;
        }

        const ordinal = slugWithOrdinal.slice(slug.length);
        if (!/^\d+$/.test(ordinal)) {
            return null;
        }

        return {
            type,
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

export const resolveScriptTypeQuery = (type?: string): ScriptType | undefined => {
    if (!type) {
        return;
    }

    return SCRIPT_TYPE_BY_QUERY[type.toLowerCase()];
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

const getValidatorHashFromScriptCbor = (scriptCbor?: string) => {
    if (!scriptCbor || !/^[0-9a-f]+$/i.test(scriptCbor) || scriptCbor.length % 2 !== 0) {
        return null;
    }

    return blake2b(Buffer.from(`02${scriptCbor}`, 'hex'), 28);
};

const buildScriptEntry = async (handle: StoredHandle, type: ScriptType, latest: boolean, unoptimizedCbor?: string): Promise<[string, ScriptDetails] | null> => {
    const refScriptAddress = handle.resolved_addresses?.ada;
    const validatorHash = getValidatorHashFromScriptCbor(handle.script?.cbor);
    if (!refScriptAddress || !validatorHash || !handle.script?.cbor) {
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
            refScriptUtxo: handle.utxo,
            cbor: handle.script.cbor,
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
    const unoptimizedCborCache = new Map<ScriptType, Promise<string | undefined>>();

    for (const [scriptType, matches] of matchesByType.entries()) {
        const latestOrdinal = Math.max(...matches.map(({ ordinal }) => ordinal));
        const unoptimizedCbor = await fetchUnoptimizedCbor(scriptType, unoptimizedCborCache);
        for (const { handle, ordinal } of matches) {
            const scriptEntry = await buildScriptEntry(handle, scriptType, ordinal === latestOrdinal, unoptimizedCbor);
            if (scriptEntry) {
                scripts[scriptEntry[0]] = scriptEntry[1];
            }
        }
    }

    return scripts;
};

export const getScriptByRefAddress = async (req: Request<any>, refScriptAddress?: string): Promise<ScriptDetails | undefined> => {
    if (!refScriptAddress) {
        return;
    }

    return Object.values(await getScriptsIndex(req)).find((script) => script.refScriptAddress === refScriptAddress);
};
