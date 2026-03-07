import { getApiMetricsKey } from '../stores/redis/keys';

jest.mock('@valkey/valkey-glide', () => ({
    GlideClient: {
        createClient: jest.fn()
    }
}));

const getCreateClientMock = () =>
    ((jest.requireMock('@valkey/valkey-glide') as { GlideClient: { createClient: jest.Mock } }).GlideClient.createClient);

const loadLambda = async () => {
    let moduleRef: any;
    await jest.isolateModulesAsync(async () => {
        moduleRef = await import('./valkeyutility');
    });
    return moduleRef;
};

const resetEnv = () => {
    delete process.env.AWS_REGION;
    delete process.env.REDIS_HOST_US_WEST_2;
    delete process.env.REDIS_HOST;
    delete process.env.REDIS_PORT;
    delete process.env.REDIS_USE_TLS;
};

describe('lambdas/valkeyutility', () => {
    beforeEach(() => {
        resetEnv();
        jest.resetModules();
        jest.clearAllMocks();
    });

    it('uses regional host, integer port, and stringifies bigint output', async () => {
        process.env.AWS_REGION = 'us-west-2';
        process.env.REDIS_HOST_US_WEST_2 = 'redis.regional';
        process.env.REDIS_PORT = '6381';
        process.env.REDIS_USE_TLS = 'false';

        const hgetall = jest.fn().mockResolvedValue({ count: 1n });
        getCreateClientMock().mockResolvedValue({ hgetall });

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const lambda = await loadLambda();
        await lambda.handler();

        expect(getCreateClientMock()).toHaveBeenCalledWith(
            expect.objectContaining({
                addresses: [{ host: 'redis.regional', port: 6381 }],
                useTLS: false
            })
        );
        expect(hgetall).toHaveBeenCalledWith(getApiMetricsKey());
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"count":"1"'));
    });

    it('falls back to REDIS_HOST and default port when REDIS_PORT is invalid', async () => {
        process.env.REDIS_HOST = 'redis.fallback';
        process.env.REDIS_PORT = 'not-a-number';

        const hgetall = jest.fn().mockResolvedValue({});
        getCreateClientMock().mockResolvedValue({ hgetall });

        const lambda = await loadLambda();
        await lambda.handler();

        expect(getCreateClientMock()).toHaveBeenCalledWith(
            expect.objectContaining({
                addresses: [{ host: 'redis.fallback', port: 6379 }]
            })
        );
    });

    it('logs unknown-command errors when the client does not expose the command', async () => {
        getCreateClientMock().mockResolvedValue({});

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const lambda = await loadLambda();
        await lambda.handler();

        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown Valkey command: hgetall'));
    });

    it('logs raw thrown values when the redis call rejects with a non-Error value', async () => {
        getCreateClientMock().mockResolvedValue({
            hgetall: jest.fn().mockRejectedValue('plain-string-error')
        });

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const lambda = await loadLambda();
        await lambda.handler();

        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('plain-string-error'));
    });
});
