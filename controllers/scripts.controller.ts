import { ScriptDetails, ScriptType } from '@koralabs/kora-labs-common';
import { NextFunction, Request, Response } from 'express';
import { getScriptSlug, getScriptsIndex, resolveScriptTypeQuery } from '../services/scripts.service';

class ScriptsController {
    public index = async (req: Request<Request>, res: Response, next: NextFunction): Promise<void> => {
        try {
            const { latest = false, type = null } = req.query;
            const requestedType = typeof type === 'string' ? resolveScriptTypeQuery(type) : undefined;
            const requestedTypeSlug = getScriptSlug(requestedType ?? ScriptType.PZ_CONTRACT);

            const indexedScripts = await getScriptsIndex(req, requestedType);
            const allScripts = type
                ? requestedType
                    ? Object.entries(indexedScripts).filter(([_, value]) => value.type === getScriptSlug(requestedType))
                    : []
                : Object.entries(indexedScripts);

            if (latest) {
                const latestScript = allScripts.find(
                    ([_, value]) => value.latest && value.type === requestedTypeSlug
                );

                if (!latestScript) {
                    res.status(404).send({ message: 'Latest script not found' });
                    return;
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
