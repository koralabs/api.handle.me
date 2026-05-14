import { ScriptDetails } from '@koralabs/kora-labs-common';
import { NextFunction, Request, Response } from 'express';
import { getScriptSlug, getScriptsIndex, resolveScriptTypeQuery } from '../services/scripts.service';
import { ApiError } from '../utils/apiError';

class ScriptsController {
    public index = async (req: Request<Request>, res: Response, next: NextFunction): Promise<void> => {
        try {
            const { latest = false, type = null } = req.query;
            const requestedType = typeof type === 'string' ? resolveScriptTypeQuery(type) : undefined;

            const indexedScripts = await getScriptsIndex(req, requestedType);
            // `?type=X` is documented as a startsWith filter on the script
            // family slug, so `?type=pers` should match the V3 sub-slugs
            // (persprx, perspz, perslfc, persdsg) as well as the legacy
            // `pers` slug. When the query is a specific sub-slug like
            // `?type=persprx`, the same startsWith filter naturally
            // narrows to that single family.
            const querySlug = typeof type === 'string' ? type.toLowerCase() : null;
            const allScripts = type
                ? requestedType
                    ? Object.entries(indexedScripts).filter(([_, value]) => {
                        const valueType = typeof value.type === 'string' ? value.type.toLowerCase() : '';
                        // Documented startsWith semantics: `?type=pers` matches
                        // both 'pers' (V2) and the V3 sub-slugs (persprx,
                        // perspz, perslfc, persdsg). `?type=persprx` narrows
                        // strictly to that family.
                        if (querySlug) {
                            return valueType.startsWith(querySlug);
                        }
                        return valueType === getScriptSlug(requestedType);
                    })
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

                const latestScript = allScripts.find(([_, value]) => value.latest);

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
