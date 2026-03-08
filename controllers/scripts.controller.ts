import { ScriptDetails, ScriptType } from '@koralabs/kora-labs-common';
import { NextFunction, Request, Response } from 'express';
import { getScriptsIndex } from '../services/scripts.service';

class ScriptsController {
    public index = async (req: Request<Request>, res: Response, next: NextFunction): Promise<void> => {
        try {
            const { latest = false, type = null } = req.query;

            const indexedScripts = await getScriptsIndex(req, typeof type === 'string' ? type : undefined);
            const allScripts = type
                ? Object.entries(indexedScripts).filter(([_, value]) => value.type === type)
                : Object.entries(indexedScripts);

            if (latest) {
                const latestScript = allScripts.find(
                    ([_, value]) => value.latest && (type ? value.type === type : value.type === ScriptType.PZ_CONTRACT)
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
