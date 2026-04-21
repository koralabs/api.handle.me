import { IS_LOCAL } from '@koralabs/kora-labs-common';
import { NextFunction, Request, Response } from 'express';
import fs from 'fs';
import { parse as parseYaml } from 'yaml';

const SWAGGER_FILE = IS_LOCAL ? './docs/swagger.yml' : './swagger.yml';

const LINKS: { label: string; path: string }[] = [
    { label: 'Swagger UI', path: '/swagger' },
    { label: 'OpenAPI spec (YAML)', path: '/swagger/swagger.yml' },
    { label: 'MCP endpoint', path: '/mcp' }
];

let cached: { yaml: string; json: unknown } | undefined;

const loadSwagger = () => {
    if (!cached) {
        const yaml = fs.readFileSync(SWAGGER_FILE).toString();
        cached = { yaml, json: parseYaml(yaml) };
    }
    return cached;
};

const renderTextLinks = (baseUrl: string) =>
    LINKS.map((link) => `${link.label}: ${baseUrl}${link.path}`).join('\n') + '\n';

const renderHtmlLinks = () => {
    const items = LINKS.map(
        (link) => `<li><a href="${link.path}">${link.label}</a></li>`
    ).join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>api.handle.me</title></head><body><h1>api.handle.me</h1><ul>${items}</ul></body></html>`;
};

class HomeController {
    public async index(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const acceptHeader = String(req.headers.accept ?? '');
            if (/yaml/i.test(acceptHeader)) {
                res.type('application/yaml').send(loadSwagger().yaml);
                return;
            }

            const accepted = req.accepts([
                'text/html',
                'application/json',
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

            res.status(406).type('text/plain').send('Not Acceptable');
        } catch (error) {
            next(error);
        }
    }
}

export default HomeController;
