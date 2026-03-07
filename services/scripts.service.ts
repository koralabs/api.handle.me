import { bech32AddressFromHashes, decodeAddress, HandleSearchModel, ScriptDetails, ScriptType, StoredHandle } from '@koralabs/kora-labs-common';
import { Request } from 'express';
import { IRegistry } from '../interfaces/registry.interface';
import { HandlesRepository } from '../repositories/handlesRepository';

const SCRIPT_ROOT_HANDLE = 'handlecontract';
const MAX_SCRIPT_RESULTS = '50000';
const HANDLE_SUFFIX = `@${SCRIPT_ROOT_HANDLE}`;
const SCRIPT_TYPES = Object.values(ScriptType).sort((left, right) => right.length - left.length);

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
    for (const type of SCRIPT_TYPES) {
        if (!slugWithOrdinal.startsWith(type)) {
            continue;
        }

        const ordinal = slugWithOrdinal.slice(type.length);
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

const buildScriptEntry = (handle: StoredHandle, type: ScriptType, latest: boolean): [string, ScriptDetails] | null => {
    const refScriptAddress = handle.resolved_addresses?.ada;
    const validatorHash = refScriptAddress ? decodeAddress(refScriptAddress)?.slice(2, 58) : null;
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
            type
        }
    ];
};

const getCandidateHandles = (req: Request<any>, type?: string): StoredHandle[] => {
    const handleRepo = createRepo(req);
    if (!handleRepo) {
        return [];
    }

    return handleRepo.search(
        { handlesPerPage: Number(MAX_SCRIPT_RESULTS), sort: 'asc', page: 1 } as any,
        new HandleSearchModel({
            root_handle: SCRIPT_ROOT_HANDLE,
            search: type
        } as ConstructorParameters<typeof HandleSearchModel>[0] & { root_handle?: string })
    ).handles as StoredHandle[];
};

export const getScriptsIndex = (req: Request<any>, type?: string): { [scriptAddress: string]: ScriptDetails } => {
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
    for (const [scriptType, matches] of matchesByType.entries()) {
        const latestOrdinal = Math.max(...matches.map(({ ordinal }) => ordinal));
        for (const { handle, ordinal } of matches) {
            const scriptEntry = buildScriptEntry(handle, scriptType, ordinal === latestOrdinal);
            if (scriptEntry) {
                scripts[scriptEntry[0]] = scriptEntry[1];
            }
        }
    }

    return scripts;
};

export const getScriptByRefAddress = (req: Request<any>, refScriptAddress?: string): ScriptDetails | undefined => {
    if (!refScriptAddress) {
        return;
    }

    return Object.values(getScriptsIndex(req)).find((script) => script.refScriptAddress === refScriptAddress);
};
