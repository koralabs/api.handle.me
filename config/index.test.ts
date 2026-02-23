const ORIGINAL_ENV = { ...process.env };

const loadConfig = async () => {
    jest.resetModules();
    return import('./index');
};

describe('config/index', () => {
    afterEach(() => {
        process.env = { ...ORIGINAL_ENV };
        jest.resetModules();
    });

    it('reads booleans and gateway values from env', async () => {
        process.env.CREDENTIALS = 'true';
        process.env.ENABLE_DATUM_ENDPOINT = 'true';
        process.env.CORS_ORIGIN = 'https://cors.example';
        process.env.IPFS_GATEWAY = 'https://ipfs.primary/';
        process.env.IPFS_GATEWAY_BACKUP = 'https://ipfs.backup/';

        const config = await loadConfig();

        expect(config.CREDENTIALS).toBe(true);
        expect(config.isDatumEndpointEnabled()).toBe(true);
        expect(config.ORIGIN).toBe('https://cors.example');
        expect(config.getIpfsGateway()).toBe('https://ipfs.primary/');
        expect(config.getIpfsGateway(true)).toBe('https://ipfs.backup/');
    });

    it('uses direct env overrides for exported scalar config values', async () => {
        process.env.NODE_ENV = 'production';
        process.env.PORT = '8080';
        process.env.SECRET_KEY = 'secret';
        process.env.LOG_FORMAT = 'json';
        process.env.LOG_DIR = '/tmp/logs';
        process.env.ORIGIN = 'https://origin.example';
        process.env.CORS_ORIGIN = 'https://ignored-cors.example';
        process.env.OGMIOS_HOST = 'https://ogmios.example';
        process.env.NETWORK = 'mainnet';
        process.env.DISABLE_HANDLES_SNAPSHOT = 'true';
        process.env.WHITELISTED_API_KEYS = 'a,b';

        const config = await loadConfig();

        expect(config.NODE_ENV).toBe('production');
        expect(config.PORT).toBe('8080');
        expect(config.SECRET_KEY).toBe('secret');
        expect(config.LOG_FORMAT).toBe('json');
        expect(config.LOG_DIR).toBe('/tmp/logs');
        expect(config.ORIGIN).toBe('https://origin.example');
        expect(config.OGMIOS_HOST).toBe('https://ogmios.example');
        expect(config.NETWORK).toBe('mainnet');
        expect(config.DISABLE_HANDLES_SNAPSHOT).toBe('true');
        expect(config.WHITELISTED_API_KEYS).toBe('a,b');
    });

    it('falls back to defaults when env is missing', async () => {
        delete process.env.CREDENTIALS;
        delete process.env.ENABLE_DATUM_ENDPOINT;
        delete process.env.NODE_ENV;
        delete process.env.NETWORK;
        delete process.env.ORIGIN;
        delete process.env.CORS_ORIGIN;
        delete process.env.IPFS_GATEWAY;
        delete process.env.IPFS_GATEWAY_BACKUP;

        const config = await loadConfig();

        expect(config.CREDENTIALS).toBe(false);
        expect(config.isDatumEndpointEnabled()).toBe(false);
        expect(config.ORIGIN).toBe('');
        expect(config.OGMIOS_HOST).toBe('http://localhost:1337');
        expect(config.getIpfsGateway()).toBe('https://ipfs.io/ipfs/');
        expect(config.getIpfsGateway(true)).toBe('https://ipfs.io/ipfs/');
    });
});
