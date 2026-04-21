import request from 'supertest';
import App from '../app';
import { parse as parseYaml } from 'yaml';
import fs from 'fs';

jest.mock('../services/ogmios/ogmios.service');

const SWAGGER_YAML = fs.readFileSync('./docs/swagger.yml').toString();
const SWAGGER_JSON = parseYaml(SWAGGER_YAML);

describe('[GET] /', () => {
    let app: App | null;
    beforeEach(async () => {
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

    it('returns plain-text link list with absolute URLs when Accept: text/plain', async () => {
        const response = await request(app!.getServer()).get('/').set('Accept', 'text/plain');
        expect(response.status).toEqual(200);
        expect(response.headers['content-type']).toMatch(/text\/plain/);
        expect(response.text).toMatch(/^Swagger UI: http:\/\/[^/]+\/swagger$/m);
        expect(response.text).toMatch(/^OpenAPI spec \(YAML\): http:\/\/[^/]+\/swagger\/swagger\.yml$/m);
        expect(response.text).toMatch(/^MCP endpoint: http:\/\/[^/]+\/mcp$/m);
    });

    it('returns HTML link list when Accept: text/html', async () => {
        const response = await request(app!.getServer()).get('/').set('Accept', 'text/html');
        expect(response.status).toEqual(200);
        expect(response.headers['content-type']).toMatch(/text\/html/);
        expect(response.text).toContain('<a href="/swagger">Swagger UI</a>');
        expect(response.text).toContain('<a href="/swagger/swagger.yml">OpenAPI spec (YAML)</a>');
        expect(response.text).toContain('<a href="/mcp">MCP endpoint</a>');
    });

    it('defaults to HTML when Accept is */*', async () => {
        const response = await request(app!.getServer()).get('/').set('Accept', '*/*');
        expect(response.status).toEqual(200);
        expect(response.headers['content-type']).toMatch(/text\/html/);
        expect(response.text).toContain('<a href="/swagger">Swagger UI</a>');
    });

    it('returns 406 when Accept is a media type we do not serve', async () => {
        const response = await request(app!.getServer()).get('/').set('Accept', 'image/png');
        expect(response.status).toEqual(406);
    });
});
