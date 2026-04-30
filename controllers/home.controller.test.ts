import request from 'supertest';
import App from '../app';
import { parse as parseYaml } from 'yaml';
import fs from 'fs';
import packageJson from '../package.json';
import { __resetSwaggerCacheForTests } from './home.controller';

jest.mock('../services/ogmios/ogmios.service');

// Substitute {{version}} the same way the controller does so the test matches
// what the API actually serves.
const SWAGGER_YAML = fs.readFileSync('./docs/swagger.yml').toString().replace(/\{\{version\}\}/g, packageJson.version);
const SWAGGER_JSON = parseYaml(SWAGGER_YAML);

describe('[GET] /', () => {
    let app: App | null;
    beforeEach(async () => {
        __resetSwaggerCacheForTests();
        app = await new App().initialize();
    });

    afterEach(() => {
        jest.clearAllMocks();
        jest.restoreAllMocks();
    });

    it('returns full OpenAPI YAML when Accept: application/yaml', async () => {
        const response = await request(app!.getServer()).get('/').set('Accept', 'application/yaml');
        expect(response.status).toEqual(200);
        expect(response.headers['content-type']).toMatch(/application\/yaml/);
        expect(response.text).toEqual(SWAGGER_YAML);
    });

    it('returns full OpenAPI YAML when Accept: text/yaml', async () => {
        const response = await request(app!.getServer()).get('/').set('Accept', 'text/yaml');
        expect(response.status).toEqual(200);
        expect(response.headers['content-type']).toMatch(/application\/yaml/);
        expect(response.text).toEqual(SWAGGER_YAML);
    });

    it('returns full OpenAPI YAML when Accept: application/x-yaml (Postman variant)', async () => {
        const response = await request(app!.getServer()).get('/').set('Accept', 'application/x-yaml');
        expect(response.status).toEqual(200);
        expect(response.headers['content-type']).toMatch(/application\/yaml/);
        expect(response.text).toEqual(SWAGGER_YAML);
    });

    it('returns YAML when Accept contains the substring "yaml" alongside other types', async () => {
        const response = await request(app!.getServer())
            .get('/')
            .set('Accept', 'text/html, application/x-yaml;q=0.1');
        expect(response.status).toEqual(200);
        expect(response.headers['content-type']).toMatch(/application\/yaml/);
        expect(response.text).toEqual(SWAGGER_YAML);
    });

    it('returns parsed OpenAPI JSON when Accept: application/json', async () => {
        const response = await request(app!.getServer()).get('/').set('Accept', 'application/json');
        expect(response.status).toEqual(200);
        expect(response.headers['content-type']).toMatch(/application\/json/);
        expect(response.body).toEqual(SWAGGER_JSON);
    });

    it('substitutes {{version}} placeholder with the real package version', async () => {
        const response = await request(app!.getServer()).get('/').set('Accept', 'application/json');
        expect(response.status).toEqual(200);
        expect(response.body.info.version).toEqual(packageJson.version);
        expect(JSON.stringify(response.body)).not.toContain('{{version}}');
    });

    it('returns plain-text link list with absolute URLs when Accept: text/plain', async () => {
        const response = await request(app!.getServer()).get('/').set('Accept', 'text/plain');
        expect(response.status).toEqual(200);
        expect(response.headers['content-type']).toMatch(/text\/plain/);
        expect(response.text).toMatch(/^Swagger UI: http:\/\/[^/]+\/swagger$/m);
        expect(response.text).toMatch(/^OpenAPI spec \(YAML\): http:\/\/[^/]+\/swagger\/swagger\.yml$/m);
        expect(response.text).toMatch(/^OpenAPI spec \(JSON\): http:\/\/[^/]+\/openapi\.json$/m);
        expect(response.text).toMatch(/^MCP endpoint: http:\/\/[^/]+\/mcp$/m);
    });

    it('returns HTML link list when Accept: text/html', async () => {
        const response = await request(app!.getServer()).get('/').set('Accept', 'text/html');
        expect(response.status).toEqual(200);
        expect(response.headers['content-type']).toMatch(/text\/html/);
        expect(response.text).toContain('<a href="/swagger">Swagger UI</a>');
        expect(response.text).toContain('<a href="/swagger/swagger.yml">OpenAPI spec (YAML)</a>');
        expect(response.text).toContain('<a href="/openapi.json">OpenAPI spec (JSON)</a>');
        expect(response.text).toContain('<a href="/mcp">MCP endpoint</a>');
    });

    it('defaults to JSON when Accept is */*', async () => {
        const response = await request(app!.getServer()).get('/').set('Accept', '*/*');
        expect(response.status).toEqual(200);
        expect(response.headers['content-type']).toMatch(/application\/json/);
        expect(response.body).toEqual(SWAGGER_JSON);
    });

    it('defaults to JSON when no Accept header is sent', async () => {
        // Some HTTP clients (and supertest by default) send no Accept; the API
        // must not 406 these — that was the original symptom.
        const response = await request(app!.getServer()).get('/');
        expect(response.status).toEqual(200);
        expect(response.headers['content-type']).toMatch(/application\/json/);
        expect(response.body).toEqual(SWAGGER_JSON);
    });

    it('returns 406 with the canonical error envelope when Accept is a media type we cannot serve', async () => {
        const response = await request(app!.getServer()).get('/').set('Accept', 'image/png');
        expect(response.status).toEqual(406);
        expect(response.headers['content-type']).toMatch(/application\/json/);
        expect(response.body).toEqual(expect.objectContaining({
            error: 'not_acceptable',
            message: expect.any(String),
            docs: expect.any(String)
        }));
    });
});

describe('Discovery routes', () => {
    let app: App | null;
    beforeEach(async () => {
        __resetSwaggerCacheForTests();
        app = await new App().initialize();
    });

    it('serves the spec at /openapi.json (conventional alias)', async () => {
        const response = await request(app!.getServer()).get('/openapi.json');
        expect(response.status).toEqual(200);
        expect(response.headers['content-type']).toMatch(/application\/json/);
        expect(response.body).toEqual(SWAGGER_JSON);
    });

    it('serves the spec at /swagger.json', async () => {
        const response = await request(app!.getServer()).get('/swagger.json');
        expect(response.status).toEqual(200);
        expect(response.body).toEqual(SWAGGER_JSON);
    });

    it('serves /.well-known/security.txt as text/plain (RFC 9116)', async () => {
        const response = await request(app!.getServer()).get('/.well-known/security.txt');
        expect(response.status).toEqual(200);
        expect(response.headers['content-type']).toMatch(/text\/plain/);
        expect(response.text).toMatch(/^Contact: mailto:hello@koralabs\.io$/m);
        expect(response.text).toMatch(/^Expires: /m);
    });

    it('serves /.well-known/api-catalog as a Linkset (RFC 9727)', async () => {
        const response = await request(app!.getServer()).get('/.well-known/api-catalog');
        expect(response.status).toEqual(200);
        expect(response.headers['content-type']).toMatch(/application\/linkset\+json/);
        const body = JSON.parse(response.text);
        expect(body).toEqual(expect.objectContaining({
            linkset: expect.arrayContaining([
                expect.objectContaining({
                    'service-doc': expect.any(Array),
                    'service-meta': expect.any(Array)
                })
            ])
        }));
    });
});

describe('Discovery middleware', () => {
    let app: App | null;
    beforeEach(async () => {
        __resetSwaggerCacheForTests();
        app = await new App().initialize();
    });

    it('emits Link rel="service-doc" pointing at the OpenAPI spec on every response', async () => {
        const response = await request(app!.getServer()).get('/').set('Accept', 'application/json');
        expect(response.headers.link).toBeDefined();
        expect(response.headers.link).toContain('rel="service-doc"');
        expect(response.headers.link).toContain('rel="service-meta"');
    });

    it('emits Link header even on 4xx error responses', async () => {
        const response = await request(app!.getServer()).get('/totally-not-a-route');
        expect(response.status).toEqual(404);
        expect(response.headers.link).toBeDefined();
        expect(response.headers.link).toContain('rel="service-doc"');
    });

    it('emits X-API-Version matching package.json on every response', async () => {
        const response = await request(app!.getServer()).get('/').set('Accept', 'application/json');
        expect(response.headers['x-api-version']).toEqual(packageJson.version);
    });
});

describe('Route fall-through', () => {
    let app: App | null;
    beforeEach(async () => {
        __resetSwaggerCacheForTests();
        app = await new App().initialize();
    });

    it('returns 404 with the canonical Error envelope on an unknown route (not Express text/html default)', async () => {
        const response = await request(app!.getServer()).get('/totally-not-a-route');
        expect(response.status).toEqual(404);
        expect(response.headers['content-type']).toMatch(/application\/json/);
        expect(response.body).toEqual(expect.objectContaining({
            error: 'route_not_found',
            message: expect.stringContaining('/totally-not-a-route'),
            docs: expect.any(String)
        }));
    });

    it('returns 405 with Allow header when method does not match a registered path', async () => {
        const response = await request(app!.getServer()).post('/').send({});
        expect(response.status).toEqual(405);
        expect(response.headers.allow).toBeDefined();
        expect(response.headers.allow).toContain('GET');
        expect(response.body).toEqual(expect.objectContaining({
            error: 'method_not_allowed',
            message: expect.any(String),
            docs: expect.any(String)
        }));
    });
});
