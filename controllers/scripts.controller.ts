import { ScriptDetails } from '@koralabs/kora-labs-common';
import { NextFunction, Request, Response } from 'express';
import { findPrimaryLatestScript, getScriptSlug, getScriptsIndex, resolveScriptTypeQuery } from '../services/scripts.service';
import { ApiError } from '../utils/apiError';

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

                const latestScript = findPrimaryLatestScript(allScripts);

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
