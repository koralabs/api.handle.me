import { decodeAddress, IndexNames, ScriptDetails, ScriptType, StoredHandle } from '@koralabs/kora-labs-common';
import { NextFunction, Request, Response } from 'express';
import { getScript, scripts } from '../config/scripts';
import { IRegistry } from '../interfaces/registry.interface';
import { HandlesRepository } from '../repositories/handlesRepository';

const HAL_HANDLE_MATCHERS: {
    type: ScriptType;
    legacyHandles: string[];
    futurePattern: RegExp;
}[] = [
    // Canonical repo-owned contract slugs now follow <app><[ord|mnt|ref|roy]><[mpt]>,
    // but this controller still maps handle-backed discovery onto legacy ScriptType values
    // so the public /scripts API remains backward compatible during migration.
    {
        type: ScriptType.HAL_MINT_PROXY,
        legacyHandles: ['hal_mnt_prxy@handle_contract'],
        futurePattern: /^hal[-_]?mint[-_]?proxy(\d+)@handlecontract$/i
    },
    {
        type: ScriptType.HAL_MINTING_DATA,
        legacyHandles: ['hal_mnt_data@handle_contract'],
        futurePattern: /^hal[-_]?minting[-_]?data(\d+)@handlecontract$/i
    },
    {
        type: ScriptType.HAL_ORDERS_SPEND,
        legacyHandles: ['hal_ord_spnd@handle_contract'],
        futurePattern: /^hal[-_]?orders[-_]?spend(\d+)@handlecontract$/i
    },
    {
        type: ScriptType.HAL_REF_SPEND_PROXY,
        legacyHandles: ['hal_rf_sd_px@handle_contract'],
        futurePattern: /^hal[-_]?ref[-_]?spend[-_]?proxy(\d+)@handlecontract$/i
    },
    {
        type: ScriptType.HAL_REF_SPEND,
        legacyHandles: ['hal_ref_spnd@handle_contract'],
        futurePattern: /^hal[-_]?ref[-_]?spend(\d+)@handlecontract$/i
    },
    {
        type: ScriptType.HAL_ROYALTY_SPEND,
        legacyHandles: ['hal_roy_spnd@handle_contract'],
        futurePattern: /^hal[-_]?royalty[-_]?spend(\d+)@handlecontract$/i
    },
    {
        type: ScriptType.HAL_MINT,
        legacyHandles: ['hal_mnt@handle_contract'],
        futurePattern: /^hal[-_]?mint(\d+)@handlecontract$/i
    }
];

type HandleScriptMatch = {
    type: ScriptType;
    ordinal: number;
};

const matchHalHandle = (handleName: string): HandleScriptMatch | null => {
    for (const matcher of HAL_HANDLE_MATCHERS) {
        if (matcher.legacyHandles.includes(handleName)) {
            return { type: matcher.type, ordinal: 0 };
        }

        const futureMatch = handleName.match(matcher.futurePattern);
        if (futureMatch) {
            return {
                type: matcher.type,
                ordinal: Number.parseInt(futureMatch[1] || '0', 10) || 0
            };
        }
    }

    return null;
};

const buildHandleBackedScript = (
    handle: StoredHandle,
    type: ScriptType,
    latest: boolean
): [string, ScriptDetails] | null => {
    const scriptAddress = handle.resolved_addresses?.ada;
    const script = handle.script ?? (scriptAddress ? getScript(scriptAddress) : undefined);
    const decodedAddress = scriptAddress ? decodeAddress(scriptAddress) : null;
    const validatorHash = decodedAddress?.slice(2, 58);

    if (!scriptAddress || !script?.cbor || !validatorHash) {
        return null;
    }

    const existing = getScript(scriptAddress);
    return [
        scriptAddress,
        {
            ...existing,
            handle: handle.name,
            handleHex: handle.hex,
            refScriptAddress: scriptAddress,
            refScriptUtxo: handle.utxo || existing?.refScriptUtxo,
            cbor: script.cbor,
            validatorHash,
            latest,
            type,
            txBuildVersion: existing?.txBuildVersion ?? 1
        }
    ];
};

const loadHandleBackedScripts = (req: Request<any>): { [scriptAddress: string]: ScriptDetails } => {
    const registry = req.app?.get?.('registry') as IRegistry | undefined;
    if (!registry?.handlesStore) {
        return {};
    }

    const handleRepo = new HandlesRepository(new registry.handlesStore());
    const rawHandleNames = handleRepo['store']?.getKeysFromIndex?.(IndexNames.HANDLE);
    const handleNames = new Set(
        Array.from(rawHandleNames ?? [])
            .map((handleName) => `${handleName}`)
            .filter((handleName) => handleName.includes('@handle_contract') || handleName.includes('@handlecontract'))
    );

    const matchesByType = new Map<ScriptType, { handle: StoredHandle; ordinal: number }[]>();
    for (const handleName of handleNames) {
        const match = matchHalHandle(handleName);
        if (!match) {
            continue;
        }

        const handle = handleRepo.getHandle(handleName);
        if (!handle) {
            continue;
        }

        const matches = matchesByType.get(match.type) ?? [];
        matches.push({ handle, ordinal: match.ordinal });
        matchesByType.set(match.type, matches);
    }

    const resolvedScripts: { [scriptAddress: string]: ScriptDetails } = {};
    for (const [type, matches] of matchesByType.entries()) {
        const latestOrdinal = Math.max(...matches.map(({ ordinal }) => ordinal));
        for (const { handle, ordinal } of matches) {
            const scriptEntry = buildHandleBackedScript(handle, type, ordinal === latestOrdinal);
            if (scriptEntry) {
                resolvedScripts[scriptEntry[0]] = scriptEntry[1];
            }
        }
    }

    return resolvedScripts;
};

const loadScriptsIndex = (req: Request<any>, network: string): { [scriptAddress: string]: ScriptDetails } => ({
    ...scripts[network],
    ...loadHandleBackedScripts(req)
});

class ScriptsController {
    public index = async (req: Request<Request>, res: Response, next: NextFunction): Promise<void> => {
        try {
            const { latest = false, type = null } = req.query;

            const network = process.env.NETWORK?.toLowerCase() ?? 'preview';
            const indexedScripts = loadScriptsIndex(req, network);
            const allScripts = type
                ? Object.entries(indexedScripts).filter(([_, value]) => value.type === type)
                : Object.entries(indexedScripts);

            if (latest) {
                const latestScript = allScripts.find(
                    ([_, value]) => value.latest && (type ? value.type === type : value.type === ScriptType.PZ_CONTRACT)
                );

                if (!latestScript) {
                    // send a 404 if no latest script is found
                    res.status(404).send({ message: 'Latest script not found' });
                    return;
                }

                const [scriptAddress, scriptData] = latestScript;
                const result = {
                    ...scriptData,
                    scriptAddress
                };

                res.json(result);
                return;
            }

            res.json(
                allScripts.reduce<{ [scriptAddress: string]: ScriptDetails }>((acc, [key, value]) => {
                    acc[key] = value;
                    return acc;
                }, {})
            );
        } catch (error) {
            next(error);
        }
    };
}

export default ScriptsController;
