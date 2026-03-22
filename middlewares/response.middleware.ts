import { NextFunction, Request, Response } from 'express';
import { getScriptByRefAddress, resolvePreferredScriptTypeForHandleName } from '../services/scripts.service';

const getHandleNameFromRequest = (req: Request) => {
    if (typeof req.params?.handle === 'string' && req.params.handle.length > 0) {
        return req.params.handle;
    }

    const match = req.url.match(/^\/handles\/([^/]+)\/(?:reference_token|utxo)(?:\?|$)/);
    return match ? decodeURIComponent(match[1]) : undefined;
};

const responseMiddleware = (req: Request, res: Response, next: NextFunction) => {
    if (req.url.startsWith('/handles') && (req.url.endsWith('/reference_token') || req.url.endsWith('/utxo'))) {
        const originalJson = res.json;

        // Override the json function
        // @ts-expect-error
        res.json = async function (body: any) {
            const scriptData = await getScriptByRefAddress(
                req,
                body.address,
                resolvePreferredScriptTypeForHandleName(getHandleNameFromRequest(req))
            );
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
