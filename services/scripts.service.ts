import { bech32AddressFromHashes, blake2b, HandleSearchModel, ScriptDetails, ScriptType, StoredHandle } from '@koralabs/kora-labs-common';
import { Request } from 'express';
import { LEGACY_SCRIPT_TYPE_ALIASES, resolveScriptArtifactNetwork, SCRIPT_SOURCES, SCRIPT_TYPES_BY_SLUG, SCRIPT_TYPE_BY_QUERY } from '../config/script-sources';
import { IRegistry } from '../interfaces/registry.interface';
import { HandlesRepository } from '../repositories/handlesRepository';
import { getBundledScriptArtifact } from './scriptArtifacts.service';

const SCRIPT_ROOT_HANDLE = 'handlecontract';
const MAX_SCRIPT_RESULTS = '50000';
const HANDLE_SUFFIX = `@${SCRIPT_ROOT_HANDLE}`;

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

export const getScriptSlug = (type: ScriptType) => SCRIPT_SOURCES[type]?.slug ?? type;

const getValidatorHashFromScriptCbor = (scriptCbor?: string) => {
    if (!scriptCbor || !/^[0-9a-f]+$/i.test(scriptCbor) || scriptCbor.length % 2 !== 0) {
        return null;
    }

    return blake2b(Buffer.from(`02${scriptCbor}`, 'hex'), 28);
};

const buildScriptEntry = async (
    handle: StoredHandle,
    type: ScriptType,
    latest: boolean,
    unoptimizedCbor: string | undefined,
    scriptSourceHandle: StoredHandle = handle
): Promise<[string, ScriptDetails] | null> => {
    const refScriptAddress = scriptSourceHandle.resolved_addresses?.ada;
    const validatorHash = getValidatorHashFromScriptCbor(scriptSourceHandle.script?.cbor);
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
    const artifactNetwork = resolveScriptArtifactNetwork();

    for (const [scriptType, matches] of matchesByType.entries()) {
        const matchesWithScript = matches.filter(({ handle }) => !!handle.script?.cbor);
        const latestOrdinal = matchesWithScript.length > 0
            ? Math.max(...matchesWithScript.map(({ ordinal }) => ordinal))
            : Math.max(...matches.map(({ ordinal }) => ordinal));
        const { unoptimizedCbor, assignedHandles: assignedScriptHandles } = getBundledScriptArtifact(scriptType, artifactNetwork);
        const activeAssignedHandleName = assignedScriptHandles
            ?.map((handleName) => handleRepo.getHandle(handleName))
            .find((handle): handle is StoredHandle => !!handle?.script?.cbor)
            ?.name
            ?.toLowerCase();
        for (const { handle, ordinal } of matches) {
            const scriptEntry = await buildScriptEntry(
                handle,
                scriptType,
                activeAssignedHandleName
                    ? handle.name.toLowerCase() === activeAssignedHandleName
                    : ordinal === latestOrdinal,
                unoptimizedCbor
            );
            if (scriptEntry) {
                scripts[scriptEntry[0]] = scriptEntry[1];
            }
        }

        if (activeAssignedHandleName && !matches.some(({ handle }) => handle.name.toLowerCase() === activeAssignedHandleName)) {
            const activeAssignedHandle = handleRepo.getHandle(activeAssignedHandleName);
            if (activeAssignedHandle?.script?.cbor) {
                const scriptEntry = await buildScriptEntry(activeAssignedHandle, scriptType, true, unoptimizedCbor);
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
