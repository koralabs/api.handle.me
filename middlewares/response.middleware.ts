import { NextFunction, Request, Response } from 'express';
import { getScript } from '../config/scripts';

const responseMiddleware = (req: Request, res: Response, next: NextFunction) => {
    if (req.url.startsWith('/handles') && (req.url.endsWith('/reference_token') || req.url.endsWith('/utxo'))) {
        const originalJson = res.json;

        // Override the json function
        // @ts-expect-error
        res.json = function (body: any) {
            const scriptData = getScript(body.address);
            if (scriptData) {
                // add to the reference_token the script data
                body.script = scriptData;
            }
            originalJson.call(this, body);
        }
    }

    next();
};

export default responseMiddleware;
