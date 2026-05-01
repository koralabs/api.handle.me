import { ScriptDetails, ScriptType } from '@koralabs/kora-labs-common';
import { NextFunction, Request, Response } from 'express';
import { getScriptSlug, getScriptsIndex, resolveScriptTypeQuery } from '../services/scripts.service';
import { ApiError } from '../utils/apiError';

// PZ V3 split: four validators (proxy + three withdraw observers) are all
// `latest: true`, but the migration target — what `latest=true&type=pers`
// must return — is unambiguously the proxy spend script. Observers don't
// have a spend side. Match handle names like `persprx1@handlecontract`.
const PERS_SPEND_PROXY_RE = /^persprx\d+@handlecontract$/i;

const pickPrimaryLatest = (
    candidates: [string, ScriptDetails][],
    type: ScriptType
): [string, ScriptDetails] | undefined => {
    if (type === ScriptType.PZ_CONTRACT) {
        const proxy = candidates.find(([, value]) => PERS_SPEND_PROXY_RE.test(value.handle ?? ''));
        if (proxy) return proxy;
    }
    return candidates[0];
};

class ScriptsController {
    public index = async (req: Request<Request>, res: Response, next: NextFunction): Promise<void> => {
        try {
            const { latest = false, type = null } = req.query;
            const requestedType = typeof type === 'string' ? resolveScriptTypeQuery(type) : undefined;

            const indexedScripts = await getScriptsIndex(req, requestedType);
            const allScripts = type
                ? requestedType
                    ? Object.entries(indexedScripts).filter(([_, value]) => value.type === getScriptSlug(requestedType))
                    : []
                : Object.entries(indexedScripts);

            if (latest) {
                if (!type) {
                    res.json(
                        allScripts.reduce<{ [scriptAddress: string]: ScriptDetails }>((acc, [key, value]) => {
                            if (value.latest) {
                                acc[key] = value;
                            }
                            return acc;
                        }, {})
                    );
                    return;
                }

                const latestCandidates = allScripts.filter(([_, value]) => value.latest);
                const latestScript = requestedType
                    ? pickPrimaryLatest(latestCandidates, requestedType)
                    : latestCandidates[0];

                if (!latestScript) {
                    throw ApiError.latestScriptNotFound();
                }

                const [scriptAddress, scriptData] = latestScript;
                res.json({
                    ...scriptData,
                    scriptAddress
                });
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
