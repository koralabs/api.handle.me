import { getApiMetricsKey } from '../stores/redis/keys';

const mockRedisClients: any[] = [];
const mockConstructedClients: any[] = [];

jest.mock('ioredis', () => ({
    __esModule: true,
    default: jest.fn().mockImplementation((options: any) => {
        const client = mockRedisClients.shift() ?? {};
        client.options = options;
        client.connect ??= jest.fn().mockResolvedValue(undefined);
        client.disconnect ??= jest.fn();
        client.hgetall ??= jest.fn().mockResolvedValue({});
        client.scan ??= jest.fn().mockResolvedValue(['0', []]);
        client.exists ??= jest.fn().mockResolvedValue(0);
        client.type ??= jest.fn().mockResolvedValue('none');
        client.callBuffer ??= jest.fn().mockResolvedValue(Buffer.from(''));
        client.call ??= jest.fn().mockResolvedValue(1);
        client.eval ??= jest.fn().mockResolvedValue(['0', '0']);
        client.pttl ??= jest.fn().mockResolvedValue(0);
        client.restore ??= jest.fn().mockResolvedValue('OK');
        mockConstructedClients.push(client);
        return client;
    })
}));

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
        mockRedisClients.length = 0;
        mockConstructedClients.length = 0;
        jest.resetModules();
        jest.clearAllMocks();
    });

    it('reads metrics from the region-scoped cache config by default', async () => {
        process.env.AWS_REGION = 'us-west-2';
        process.env.REDIS_HOST_US_WEST_2 = 'redis.regional';
        process.env.REDIS_PORT = '6381';
        process.env.REDIS_USE_TLS = 'false';

        const hgetall = jest.fn().mockResolvedValue({ count: '1' });
        mockRedisClients.push({ hgetall });

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const lambda = await loadLambda();
        await lambda.handler();

        expect(mockConstructedClients[0].options).toEqual(
            expect.objectContaining({
                host: 'redis.regional',
                port: 6381,
                tls: undefined
            })
        );
        expect(mockConstructedClients[0].connect).toHaveBeenCalled();
        expect(hgetall).toHaveBeenCalledWith(getApiMetricsKey());
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"command":"hgetall"'));
        expect(mockConstructedClients[0].disconnect).toHaveBeenCalled();
    });

    it('copies legacy and global cache keys into the env namespace', async () => {
        const source = {
            scan: jest
                .fn()
                .mockResolvedValueOnce(['0', ['{root}:handles:alice']])
                .mockResolvedValueOnce(['0', ['{api:preview}:metrics-cache']]),
            exists: jest
                .fn()
                .mockResolvedValueOnce(1)
                .mockResolvedValueOnce(0)
                .mockResolvedValueOnce(1),
            type: jest
                .fn()
                .mockResolvedValueOnce('string')
                .mockResolvedValueOnce('hash')
                .mockResolvedValueOnce('hash'),
            callBuffer: jest
                .fn()
                .mockResolvedValueOnce(Buffer.from('alice'))
                .mockResolvedValueOnce(Buffer.from('metrics'))
                .mockResolvedValueOnce(Buffer.from('recovery'))
                .mockResolvedValue(undefined),
            pttl: jest.fn().mockResolvedValue(1200)
        };
        const target: any = {
            eval: jest.fn().mockResolvedValue(['4', '0', 'string', '1', 'hash', '3']),
            restore: jest.fn().mockResolvedValue('OK')
        };
        mockRedisClients.push(source, target);

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const lambda = await loadLambda();
        await lambda.handler({
            action: 'copy_namespace',
            network: 'preview',
            sourceHost: 'source.cache',
            targetHost: 'source.cache',
            sourceTls: false,
            targetTls: false
        });

        expect(mockConstructedClients[0].options).toEqual(expect.objectContaining({ host: 'source.cache', tls: undefined }));
        expect(mockConstructedClients[1].options).toEqual(expect.objectContaining({ host: 'source.cache', tls: undefined }));
        expect(target.eval).toHaveBeenCalledTimes(1);
        expect(target.eval.mock.calls[0][1]).toBe(0);
        expect(target.eval.mock.calls[0].slice(2).sort()).toEqual([
            'metrics',
            'scanner:recovery',
            '{api:preview}:handles:alice',
            '{api:preview}:metrics',
            '{api:preview}:metrics-cache',
            '{api:preview}:metrics-cache',
            '{api:preview}:scanner:recovery',
            '{root}:handles:alice'
        ]);
        expect(target.restore).not.toHaveBeenCalled();
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"copied":4'));
    });

    it('can skip already-namespaced keys when rerunning a same-cache seed', async () => {
        const source = {
            scan: jest.fn().mockResolvedValueOnce(['0', ['{root}:handles:alice']]),
            exists: jest.fn().mockResolvedValue(0),
            type: jest.fn().mockResolvedValue('string'),
            callBuffer: jest.fn().mockResolvedValue(Buffer.from('alice')),
            pttl: jest.fn().mockResolvedValue(1200)
        };
        const target: any = {
            eval: jest.fn().mockResolvedValue(['1', '0', 'string', '1']),
            restore: jest.fn().mockResolvedValue('OK')
        };
        mockRedisClients.push(source, target);

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const lambda = await loadLambda();
        await lambda.handler({
            action: 'copy_namespace',
            network: 'preview',
            sourceHost: 'source.cache',
            targetHost: 'source.cache',
            sourceTls: false,
            targetTls: false,
            includeTargetKeys: false
        });

        expect(source.scan).toHaveBeenCalledTimes(1);
        expect(target.eval).toHaveBeenCalledTimes(1);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"includeTargetKeys":false'));
    });

    it('uses dump and restore when copying across different cache hosts', async () => {
        const source = {
            scan: jest
                .fn()
                .mockResolvedValueOnce(['0', ['{root}:handles:alice']])
                .mockResolvedValueOnce(['0', []]),
            exists: jest.fn().mockResolvedValue(0),
            type: jest.fn().mockResolvedValue('string'),
            callBuffer: jest.fn().mockResolvedValue(Buffer.from('alice')),
            pttl: jest.fn().mockResolvedValue(1200)
        };
        const target: any = {
            restore: jest.fn().mockResolvedValue('OK')
        };
        mockRedisClients.push(source, target);

        const lambda = await loadLambda();
        await lambda.handler({
            action: 'copy_namespace',
            network: 'preview',
            sourceHost: 'source.cache',
            targetHost: 'target.cache',
            sourceTls: false,
            targetTls: false
        });

        expect(target.restore).toHaveBeenCalledWith('{api:preview}:handles:alice', 1200, expect.any(Buffer), 'REPLACE');
        expect(target.call).not.toHaveBeenCalled();
    });

    it('can copy only namespaced keys from a cache that already ran the new code', async () => {
        const source = {
            scan: jest.fn().mockResolvedValueOnce(['0', ['{api:preview}:handles:alice']]),
            exists: jest.fn().mockResolvedValue(0),
            type: jest.fn().mockResolvedValue('string'),
            callBuffer: jest.fn().mockResolvedValue(Buffer.from('alice')),
            pttl: jest.fn().mockResolvedValue(1200)
        };
        const target: any = {
            restore: jest.fn().mockResolvedValue('OK')
        };
        mockRedisClients.push(source, target);

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const lambda = await loadLambda();
        await lambda.handler({
            action: 'copy_namespace',
            network: 'preview',
            sourceHost: 'source.cache',
            targetHost: 'target.cache',
            sourceTls: false,
            targetTls: false,
            sourceMode: 'namespaced_only'
        });

        expect(source.scan).toHaveBeenCalledTimes(1);
        expect(source.scan).toHaveBeenCalledWith('0', 'MATCH', '{api:preview}:*', 'COUNT', '1000');
        expect(target.restore).toHaveBeenCalledWith('{api:preview}:handles:alice', 1200, expect.any(Buffer), 'REPLACE');
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"sourceMode":"namespaced_only"'));
    });

    it('can rename legacy keys in place on a shared cache before cutover', async () => {
        const target: any = {
            scan: jest.fn().mockResolvedValueOnce(['0', ['{root}:handles:alice']]),
            exists: jest
                .fn()
                .mockResolvedValueOnce(1)
                .mockResolvedValueOnce(0)
                .mockResolvedValueOnce(1),
            eval: jest.fn().mockResolvedValue(['3', '0', 'string', '1', 'hash', '2'])
        };
        mockRedisClients.push(target);

        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const lambda = await loadLambda();
        await lambda.handler({
            action: 'rename_namespace',
            network: 'mainnet',
            sourceHost: 'shared.cache',
            targetHost: 'shared.cache',
            sourceTls: false,
            targetTls: false
        });

        expect(mockConstructedClients).toHaveLength(1);
        expect(target.eval).toHaveBeenCalledTimes(1);
        expect(target.eval.mock.calls[0][1]).toBe(0);
        expect(target.eval.mock.calls[0].slice(2).sort()).toEqual([
            'metrics',
            'scanner:recovery',
            '{api:mainnet}:handles:alice',
            '{api:mainnet}:metrics',
            '{api:mainnet}:scanner:recovery',
            '{root}:handles:alice'
        ]);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"renamed":3'));
    });

    it('rejects rename requests that span different cache hosts', async () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const lambda = await loadLambda();
        await lambda.handler({
            action: 'rename_namespace',
            network: 'mainnet',
            sourceHost: 'source.cache',
            targetHost: 'target.cache',
            sourceTls: false,
            targetTls: false
        });

        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('rename_namespace requires sourceHost and targetHost to resolve to the same redis target'));
    });

    it('reports invalid copy requests instead of touching redis', async () => {
        const logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
        const lambda = await loadLambda();
        await lambda.handler({ action: 'copy_namespace', sourceHost: 'source.cache' });

        expect(mockConstructedClients).toHaveLength(0);
        expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('network is required'));
    });
});
