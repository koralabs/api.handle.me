import { ScriptDetails, ScriptType } from '@koralabs/kora-labs-common';
import { NextFunction, Request, Response } from 'express';
import { scripts } from '../config/scripts';

class ScriptsController {
    public index = async (req: Request<Request>, res: Response, next: NextFunction): Promise<void> => {
        try {
            const { latest = false, type = null } = req.query;

            const network = process.env.NETWORK?.toLowerCase() ?? 'preview';
            const allScripts = type
                ? Object.entries(scripts[network]).filter(([_, value]) => value.type === type)
                : Object.entries(scripts[network]);

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
