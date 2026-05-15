import { ScriptDetails } from '@koralabs/kora-labs-common';
import { NextFunction, Request, Response } from 'express';
import { getScriptsIndex } from '../services/scripts.service';

const isTrue = (value: unknown): boolean => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.toLowerCase() === 'true' || value === '1';
    return false;
};

class ScriptsController {
    public index = async (req: Request<Request>, res: Response, next: NextFunction): Promise<void> => {
        try {
            const { latest, type } = req.query;
            const typeFilter = typeof type === 'string' && type.length > 0 ? type : undefined;

            const indexedScripts = await getScriptsIndex(req, typeFilter);

            if (isTrue(latest)) {
                const filtered: { [scriptAddress: string]: ScriptDetails } = {};
                for (const [address, script] of Object.entries(indexedScripts)) {
                    if (script.latest) {
                        filtered[address] = script;
                    }
                }
                res.json(filtered);
                return;
            }

            res.json(indexedScripts);
        } catch (error) {
            next(error);
        }
    };
}

export default ScriptsController;
