import { NextFunction, Request, Response } from 'express';

// Per RFC 9745 + RFC 8288: signal that an endpoint is deprecated and (optionally)
// link to its successor so agents can detect the deprecation at runtime instead
// of waiting to re-read the spec.
const deprecated = (replacementPath?: (req: Request) => string) => (req: Request, res: Response, next: NextFunction) => {
    res.set('Deprecation', 'true');
    if (replacementPath) {
        const url = `<${replacementPath(req)}>; rel="successor-version"`;
        const existing = res.get('Link');
        res.set('Link', existing ? `${existing}, ${url}` : url);
    }
    next();
};

export default deprecated;
