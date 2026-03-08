import { NextFunction, Request, Response } from 'express';
import { getScriptByRefAddress } from '../services/scripts.service';

const responseMiddleware = (req: Request, res: Response, next: NextFunction) => {
    if (req.url.startsWith('/handles') && (req.url.endsWith('/reference_token') || req.url.endsWith('/utxo'))) {
        const originalJson = res.json;

        // Override the json function
        // @ts-expect-error
        res.json = async function (body: any) {
            const scriptData = await getScriptByRefAddress(req, body.address);
            if (scriptData) {
                // add to the reference_token the script data
                body.script = scriptData;
            }
            return originalJson.call(this, body);
        }
    }

    next();
};

export default responseMiddleware;
