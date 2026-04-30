import { NextFunction, Request, Response } from 'express';
import packageJson from '../package.json';

const LINK_HEADER = [
    '</>; rel="service-doc"; type="application/json"',
    '</swagger>; rel="service-doc"; type="text/html"',
    '</swagger/swagger.yml>; rel="service-doc"; type="application/yaml"',
    '</openapi.json>; rel="service-doc"; type="application/json"',
    '</mcp>; rel="service-meta"; type="application/json"'
].join(', ');

const discoveryMiddleware = (_req: Request, res: Response, next: NextFunction) => {
    res.set('Link', LINK_HEADER);
    res.set('X-API-Version', packageJson.version);
    next();
};

export default discoveryMiddleware;
