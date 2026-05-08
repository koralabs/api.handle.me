import { bech32AddressFromHashes, blake2b, HandleSearchModel, ScriptDetails, ScriptType, StoredHandle } from '@koralabs/kora-labs-common';
import { Request } from 'express';
import { IRegistry } from '../interfaces/registry.interface';
import { HandlesRepository } from '../repositories/handlesRepository';

const SCRIPT_ROOT_HANDLE = 'handlecontract';
const HANDLE_SUFFIX = `@${SCRIPT_ROOT_HANDLE}`;
const MAX_SCRIPT_RESULTS = '50000';

const createRepo = (req: Request<any>): HandlesRepository | null => {
    const registry = req.app?.get?.('registry') as IRegistry | undefined;
    if (!registry?.handlesStore) {
        return null;
    }

    return new HandlesRepository(new registry.handlesStore());
};

interface ParsedScriptHandle {
    family: string;
    ordinal: number;
    slug: string;
}

// `<family><ordinal>@handlecontract` — `family` is the leading non-digit slug,
// `ordinal` is the trailing run of digits (0 if absent so name-only handles
// still get catalogued).
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
    if (match) {
        return { family: match[1], ordinal: Number.parseInt(match[2], 10), slug };
    }
    return { family: slug, ordinal: 0, slug };
};

const getValidatorHashFromScriptCbor = (scriptCbor?: string): string | null => {
    if (!scriptCbor || !/^[0-9a-f]+$/i.test(scriptCbor) || scriptCbor.length % 2 !== 0) {
        return null;
    }
    return blake2b(Buffer.from(`02${scriptCbor}`, 'hex'), 28);
};

const getCandidateHandles = (req: Request<any>): StoredHandle[] => {
    const handleRepo = createRepo(req);
    if (!handleRepo) {
        return [];
    }

    return handleRepo.search(
        { handlesPerPage: Number(MAX_SCRIPT_RESULTS), sort: 'asc', page: 1 } as any,
        new HandleSearchModel({
            root_handle: SCRIPT_ROOT_HANDLE
        } as ConstructorParameters<typeof HandleSearchModel>[0] & { root_handle?: string })
    ).handles as StoredHandle[];
};

const buildScriptEntry = (handle: StoredHandle, family: string, latest: boolean): [string, ScriptDetails] | null => {
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
            validatorHash,
            latest,
            type: family as ScriptType
        }
    ];
};

// Every `*@handlecontract` subhandle with inline script CBOR ends up in the
// catalog. The optional `type` filter is a startsWith match on the slug —
// e.g. `pers` matches `pers1`, `persprx1`, `persdsg1`; `persprx` matches
// `persprx1` but not `persdsg1`. Within each family, the highest ordinal
// that has a script is marked `latest`. Latest entries are emitted first
// so dict iteration order surfaces the active deployments up front.
export const getScriptsIndex = (req: Request<any>, type?: string): { [scriptAddress: string]: ScriptDetails } => {
    const handles = getCandidateHandles(req);
    const typeFilter = type ? `${type}`.toLowerCase() : null;

    const families = new Map<string, { handle: StoredHandle; ordinal: number }[]>();

    for (const handle of handles) {
        const parsed = parseScriptHandle(handle.name);
        if (!parsed) {
            continue;
        }
        if (typeFilter && !parsed.slug.startsWith(typeFilter)) {
            continue;
        }
        const list = families.get(parsed.family) ?? [];
        list.push({ handle, ordinal: parsed.ordinal });
        families.set(parsed.family, list);
    }

    const ordered: { handle: StoredHandle; family: string; latest: boolean }[] = [];
    for (const [family, list] of families.entries()) {
        list.sort((a, b) => b.ordinal - a.ordinal);
        // The latest is the highest-ordinal handle that actually has script
        // CBOR — so a placeholder mint of the next-version subhandle that
        // hasn't been deployed yet doesn't displace the live deployment.
        const latestOrdinalWithScript = list.find(({ handle }) => !!handle.script?.cbor)?.ordinal;
        for (const { handle, ordinal } of list) {
            ordered.push({ handle, family, latest: latestOrdinalWithScript !== undefined && ordinal === latestOrdinalWithScript });
        }
    }

    // Latest first so the response object's iteration order surfaces them up front.
    ordered.sort((a, b) => Number(b.latest) - Number(a.latest));

    const scripts: { [scriptAddress: string]: ScriptDetails } = {};
    for (const { handle, family, latest } of ordered) {
        const entry = buildScriptEntry(handle, family, latest);
        if (entry) {
            scripts[entry[0]] = entry[1];
        }
    }
    return scripts;
};
