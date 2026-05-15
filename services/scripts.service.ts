import { bech32AddressFromHashes, blake2b, HandleSearchModel, ScriptDetails, ScriptType, StoredHandle } from '@koralabs/kora-labs-common';
import { Request } from 'express';
import { IRegistry } from '../interfaces/registry.interface';
import { HandlesRepository } from '../repositories/handlesRepository';

const SCRIPT_ROOT_HANDLE = 'handlecontract';
const HANDLE_SUFFIX = `@${SCRIPT_ROOT_HANDLE}`;
const MAX_SCRIPT_RESULTS = '50000';
const DEFAULT_NETWORK = 'preview';
const GITHUB_RAW_BASE_URL = 'https://raw.githubusercontent.com/koralabs';

// Per-family GitHub repo for unoptimized CBOR lookup. NOT an allowlist —
// /scripts catalogs every `*@handlecontract` subhandle with inline CBOR.
// Families absent from this map simply have no unoptimizedCbor set.
const FAMILY_REPO: Record<string, string> = {
    pers: 'handles-personalization',
    persprx: 'handles-personalization',
    perspz: 'handles-personalization',
    perslfc: 'handles-personalization',
    persdsg: 'handles-personalization',
    subh: 'handles-subhandle-settings',
    mkpl: 'handles-marketplace-contracts',
    demimntprx: 'decentralized-minting',
    demimnt: 'decentralized-minting',
    demimntmpt: 'decentralized-minting',
    demiord: 'decentralized-minting',
    halmntprx: 'hal-minting-contracts',
    halmnt: 'hal-minting-contracts',
    halmntmpt: 'hal-minting-contracts',
    halord: 'hal-minting-contracts',
    halrefprx: 'hal-minting-contracts',
    halref: 'hal-minting-contracts',
    halroy: 'hal-minting-contracts'
};

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

interface ParsedScriptHandle {
    family: string;
    ordinal: number;
    slug: string;
}

// `<family><ordinal>@handlecontract` — `family` is the leading non-digit slug,
// `ordinal` is the trailing run of digits.
const parseScriptHandle = (handleName: string): ParsedScriptHandle | null => {
    const lower = `${handleName}`.toLowerCase();
    if (!lower.endsWith(HANDLE_SUFFIX)) {
        return null;
    }
    const slug = lower.slice(0, -HANDLE_SUFFIX.length);
    if (!slug) {
        return null;
    }
    const match = /^(.+?)(\d+)$/.exec(slug);
    if (!match) {
        return null;
    }
    return { family: match[1], ordinal: Number.parseInt(match[2], 10), slug };
};

const createRepo = (req: Request<any>): HandlesRepository | null => {
    const registry = req.app?.get?.('registry') as IRegistry | undefined;
    if (!registry?.handlesStore) {
        return null;
    }
    return new HandlesRepository(new registry.handlesStore());
};

const getNetwork = () => {
    const network = process.env.NETWORK?.toLowerCase();
    return network === 'mainnet' || network === 'preprod' ? network : DEFAULT_NETWORK;
};

const getUnoptimizedCborUrl = (family: string): string | null => {
    const repo = FAMILY_REPO[family];
    if (!repo) return null;
    return `${GITHUB_RAW_BASE_URL}/${repo}/master/deploy/${getNetwork()}/${family}.unoptimized.cbor`;
};

const fetchUnoptimizedCbor = async (
    family: string,
    cache: Map<string, Promise<string | undefined>>
): Promise<string | undefined> => {
    const cached = cache.get(family);
    if (cached) return cached;

    const url = getUnoptimizedCborUrl(family);
    const request = (async () => {
        if (!url) return undefined;
        try {
            const response = await fetch(url);
            if (!response.ok) return undefined;
            const body = (await response.text()).trim();
            return body || undefined;
        } catch {
            return undefined;
        }
    })();

    cache.set(family, request);
    return request;
};

const getValidatorHashFromScriptCbor = (scriptCbor?: string, scriptType?: string): string | null => {
    if (!scriptCbor || !/^[0-9a-f]+$/i.test(scriptCbor) || scriptCbor.length % 2 !== 0) {
        return null;
    }
    const tag = (scriptType && PLUTUS_LANGUAGE_TAGS[scriptType]) || '02';
    return blake2b(Buffer.from(`${tag}${scriptCbor}`, 'hex'), 28);
};

const getCandidateHandles = (req: Request<any>): StoredHandle[] => {
    const handleRepo = createRepo(req);
    if (!handleRepo) return [];

    return handleRepo.search(
        { handlesPerPage: Number(MAX_SCRIPT_RESULTS), sort: 'asc', page: 1 } as any,
        new HandleSearchModel({
            root_handle: SCRIPT_ROOT_HANDLE
        } as ConstructorParameters<typeof HandleSearchModel>[0] & { root_handle?: string })
    ).handles as StoredHandle[];
};

const buildScriptEntry = (
    handle: StoredHandle,
    family: string,
    latest: boolean,
    unoptimizedCbor: string | undefined
): [string, ScriptDetails] | null => {
    const refScriptAddress = handle.resolved_addresses?.ada;
    const cbor = handle.script?.cbor;
    if (!cbor || !refScriptAddress) return null;

    const validatorHash = getValidatorHashFromScriptCbor(cbor, handle.script?.type);
    if (!validatorHash) return null;

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
            cbor,
            unoptimizedCbor,
            validatorHash,
            latest,
            type: family as ScriptType
        }
    ];
};

// Catalogs every `*@handlecontract` subhandle with inline script CBOR.
// `type` (optional) is a startsWith match on the family slug — `pers`
// matches `pers`, `persprx`, `perspz`, etc.; `persprx` narrows to that
// family only. Within each family, the highest ordinal with inline CBOR
// is marked `latest: true` — so a placeholder mint of the next-version
// subhandle that hasn't been deployed yet doesn't displace the live one.
export const getScriptsIndex = async (
    req: Request<any>,
    type?: string
): Promise<{ [scriptAddress: string]: ScriptDetails }> => {
    const handles = getCandidateHandles(req);
    const typeFilter = type ? type.toLowerCase() : null;

    const families = new Map<string, { handle: StoredHandle; ordinal: number }[]>();
    for (const handle of handles) {
        const parsed = parseScriptHandle(handle.name);
        if (!parsed) continue;
        if (typeFilter && !parsed.family.startsWith(typeFilter)) continue;
        if (!handle.script?.cbor) continue;

        const list = families.get(parsed.family) ?? [];
        list.push({ handle, ordinal: parsed.ordinal });
        families.set(parsed.family, list);
    }

    const ordered: { handle: StoredHandle; family: string; latest: boolean }[] = [];
    for (const [family, list] of families.entries()) {
        list.sort((a, b) => b.ordinal - a.ordinal);
        const latestOrdinal = list[0]?.ordinal;
        for (const { handle, ordinal } of list) {
            ordered.push({ handle, family, latest: ordinal === latestOrdinal });
        }
    }
    // Surface latest first so dict iteration order puts active deployments up front.
    ordered.sort((a, b) => Number(b.latest) - Number(a.latest));

    const unoptimizedCborCache = new Map<string, Promise<string | undefined>>();
    const scripts: { [scriptAddress: string]: ScriptDetails } = {};
    for (const { handle, family, latest } of ordered) {
        const unoptimizedCbor = await fetchUnoptimizedCbor(family, unoptimizedCborCache);
        const entry = buildScriptEntry(handle, family, latest, unoptimizedCbor);
        if (entry) {
            scripts[entry[0]] = entry[1];
        }
    }
    return scripts;
};
