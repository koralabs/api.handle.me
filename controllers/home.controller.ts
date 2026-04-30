import { IS_LOCAL } from '@koralabs/kora-labs-common';
import { NextFunction, Request, Response } from 'express';
import fs from 'fs';
import { parse as parseYaml } from 'yaml';
import packageJson from '../package.json';
import { ApiError } from '../utils/apiError';

const SWAGGER_FILE = IS_LOCAL ? './docs/swagger.yml' : './swagger.yml';

const LINKS: { label: string; path: string }[] = [
    { label: 'Swagger UI', path: '/swagger' },
    { label: 'OpenAPI spec (YAML)', path: '/swagger/swagger.yml' },
    { label: 'OpenAPI spec (JSON)', path: '/openapi.json' },
    { label: 'MCP endpoint', path: '/mcp' }
];

let cached: { yaml: string; json: unknown } | undefined;

const loadSwagger = () => {
    if (!cached) {
        const yaml = fs.readFileSync(SWAGGER_FILE).toString().replace(/\{\{version\}\}/g, packageJson.version);
        cached = { yaml, json: parseYaml(yaml) };
    }
    return cached;
};

// Allow tests to reset the in-memory swagger cache between runs.
export const __resetSwaggerCacheForTests = () => {
    cached = undefined;
};

const renderTextLinks = (baseUrl: string) =>
    LINKS.map((link) => `${link.label}: ${baseUrl}${link.path}`).join('\n') + '\n';

const renderHtmlLinks = () => {
    const items = LINKS.map(
        (link) => `<li><a href="${link.path}">${link.label}</a></li>`
    ).join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>api.handle.me</title></head><body><h1>api.handle.me</h1><ul>${items}</ul></body></html>`;
};

const SECURITY_TXT = [
    'Contact: mailto:hello@koralabs.io',
    'Expires: 2027-01-01T00:00:00Z',
    'Preferred-Languages: en',
    'Canonical: https://api.handle.me/.well-known/security.txt',
    ''
].join('\n');

const apiCatalog = (baseUrl: string) => ({
    // RFC 9727 Linkset for API discovery.
    linkset: [
        {
            anchor: `${baseUrl}/`,
            'service-doc': [
                { href: `${baseUrl}/openapi.json`, type: 'application/json' },
                { href: `${baseUrl}/swagger/swagger.yml`, type: 'application/yaml' },
                { href: `${baseUrl}/swagger`, type: 'text/html' }
            ],
            'service-meta': [
                { href: `${baseUrl}/mcp`, type: 'application/json' }
            ]
        }
    ]
});

class HomeController {
    public async index(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const acceptHeader = String(req.headers.accept ?? '');
            if (/yaml/i.test(acceptHeader)) {
                res.type('application/yaml').send(loadSwagger().yaml);
                return;
            }

            // Default to JSON when Accept is missing or */* — agents pinned to "the API"
            // shouldn't have to set Accept correctly to get a usable representation.
            const accepted = req.accepts([
                'application/json',
                'text/html',
                'text/plain'
            ]);

            if (accepted === 'application/json') {
                res.json(loadSwagger().json);
                return;
            }

            if (accepted === 'text/plain') {
                const baseUrl = `${req.protocol}://${req.get('host')}`;
                res.type('text/plain').send(renderTextLinks(baseUrl));
                return;
            }

            if (accepted === 'text/html') {
                res.type('text/html').send(renderHtmlLinks());
                return;
            }

            throw ApiError.notAcceptable(['application/json', 'application/yaml', 'text/html', 'text/plain']);
        } catch (error) {
            next(error);
        }
    }

    // /openapi.json — conventional alias for the spec.
    public async openapiJson(_req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            res.json(loadSwagger().json);
        } catch (error) {
            next(error);
        }
    }

    // /swagger.json — alternate conventional alias used by some toolchains.
    public async swaggerJson(_req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            res.json(loadSwagger().json);
        } catch (error) {
            next(error);
        }
    }

    // /.well-known/api-catalog — RFC 9727 Linkset.
    public async apiCatalog(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            res.set('Content-Type', 'application/linkset+json').send(JSON.stringify(apiCatalog(baseUrl)));
        } catch (error) {
            next(error);
        }
    }

    // /.well-known/security.txt — RFC 9116.
    public async securityTxt(_req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            res.set('Content-Type', 'text/plain; charset=utf-8').send(SECURITY_TXT);
        } catch (error) {
            next(error);
        }
    }
}

export default HomeController;
