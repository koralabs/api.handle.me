import packageJson from '../package.json';
import discoveryMiddleware from './discovery.middleware';

const makeResponse = () => ({
    set: jest.fn()
} as any);

describe('discoveryMiddleware', () => {
    it('adds service discovery links and the current API version header', () => {
        const res = makeResponse();
        const next = jest.fn();

        discoveryMiddleware({} as any, res, next);

        expect(res.set).toHaveBeenCalledWith('Link', expect.stringContaining('</swagger/swagger.yml>; rel="service-doc"; type="application/yaml"'));
        expect(res.set).toHaveBeenCalledWith('Link', expect.stringContaining('</mcp>; rel="service-meta"; type="application/json"'));
        expect(res.set).toHaveBeenCalledWith('X-API-Version', packageJson.version);
        expect(next).toHaveBeenCalledTimes(1);
    });
});
