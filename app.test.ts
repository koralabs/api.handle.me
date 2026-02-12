import { Logger } from '@koralabs/kora-labs-common';
import fs from 'fs';
import App from './app';
import { DynamicLoadType } from './interfaces/util.interface';
import { HandlesRepository } from './repositories/handlesRepository';
import OgmiosService from './services/ogmios/ogmios.service';
import { dynamicallyLoad } from './utils/util';

jest.mock('./repositories/handlesRepository');
jest.mock('./services/ogmios/ogmios.service');
jest.mock('./utils/util');
jest.mock('./lambdas/scanner', () => ({ lambdaHandler: jest.fn() }));
jest.mock('./lambdas/rollback', () => ({ lambdaHandler: jest.fn() }));

const mockedRepoClass = HandlesRepository as unknown as jest.Mock;
const mockedOgmiosClass = OgmiosService as unknown as jest.Mock;
const mockedDynamicallyLoad = dynamicallyLoad as jest.MockedFunction<typeof dynamicallyLoad>;

describe('App lifecycle', () => {
    const originalReadOnlyStore = process.env.READ_ONLY_STORE;
    const originalUseLambdaScanner = process.env.USE_LAMBDA_SCANNER;
    const originalDynamicLoadDir = process.env.DYNAMIC_LOAD_DIR;

    beforeEach(() => {
        process.env.READ_ONLY_STORE = '';
        process.env.USE_LAMBDA_SCANNER = '';
        delete process.env.DYNAMIC_LOAD_DIR;

        jest.clearAllMocks();

        mockedRepoClass.mockImplementation(() => ({
            initialize: jest.fn().mockResolvedValue(undefined)
        }));
        mockedOgmiosClass.mockImplementation(() => ({
            initialize: jest.fn().mockResolvedValue(undefined)
        }));
        mockedDynamicallyLoad.mockImplementation(async (_path: string, type: DynamicLoadType) => {
            if (type === DynamicLoadType.MIDDLEWARE) return [((_req: any, _res: any, next: any) => next()) as any];
            if (type === DynamicLoadType.ROUTE) return [{ router: ((_req: any, _res: any, next: any) => next()) as any }];
            if (type === DynamicLoadType.REGISTRY) return [{ handlesStore: jest.fn(), testService: { enabled: true } }];
            return [];
        });
        jest.spyOn(fs, 'readFileSync').mockReturnValue(
            Buffer.from('openapi: 3.0.0\ninfo:\n  title: test\n  version: 1.0.0\npaths: {}\n')
        );
    });

    afterEach(() => {
        process.env.READ_ONLY_STORE = originalReadOnlyStore;
        process.env.USE_LAMBDA_SCANNER = originalUseLambdaScanner;
        process.env.DYNAMIC_LOAD_DIR = originalDynamicLoadDir;
        jest.restoreAllMocks();
    });

    it('returns dynamic load directories only in development/test env', () => {
        process.env.DYNAMIC_LOAD_DIR = './custom-one;./custom-two';
        const app = new App();

        (app as any).env = 'test';
        expect((app as any)._getDynamicLoadDirectories()).toEqual(['./', './custom-one', './custom-two']);

        (app as any).env = 'production';
        expect((app as any)._getDynamicLoadDirectories()).toEqual(['./']);
    });

    it('initializes registry from dynamically loaded modules', async () => {
        const app = new App();
        await app.initialize();

        expect(mockedDynamicallyLoad).toHaveBeenCalledWith(expect.stringContaining('/middlewares'), DynamicLoadType.MIDDLEWARE);
        expect(mockedDynamicallyLoad).toHaveBeenCalledWith(expect.stringContaining('/routes'), DynamicLoadType.ROUTE);
        expect(mockedDynamicallyLoad).toHaveBeenCalledWith(expect.stringContaining('/ioc'), DynamicLoadType.REGISTRY);
        expect(app.getServer().get('registry')).toEqual(
            expect.objectContaining({
                handlesStore: expect.any(Function),
                testService: { enabled: true }
            })
        );
    });

    it('listen initializes app, sets trust proxy, and configures keepAlive', async () => {
        const app = new App();
        const server = { keepAliveTimeout: 0 };
        const initializeSpy = jest.spyOn(app, 'initialize').mockResolvedValue(app);
        const initializeOgmiosSpy = jest.spyOn(app as any, 'initializeOgmios').mockResolvedValue(undefined);
        jest.spyOn(app.app, 'listen').mockImplementation(((_port: any, cb?: () => void) => {
            cb?.();
            return server as any;
        }) as any);

        await app.listen();

        expect(initializeSpy).toHaveBeenCalled();
        expect(initializeOgmiosSpy).toHaveBeenCalled();
        expect(app.app.get('trust proxy')).toBe(1);
        expect(server.keepAliveTimeout).toBe(61 * 1000);
    });

    it('lambda initializes app and ogmios then returns app instance', async () => {
        const app = new App();
        jest.spyOn(app, 'initialize').mockResolvedValue(app);
        jest.spyOn(app as any, 'initializeOgmios').mockResolvedValue(undefined);

        const result = await app.lambda();

        expect(result).toBe(app);
    });

    it('initializeOgmios runs readonly path with optional local lambda scanner', async () => {
        const repoInitialize = jest.fn().mockResolvedValue(undefined);
        mockedRepoClass.mockImplementation(() => ({ initialize: repoInitialize }));
        const ogmiosInitialize = jest.fn().mockResolvedValue(undefined);
        mockedOgmiosClass.mockImplementation(() => ({ initialize: ogmiosInitialize }));
        const intervalSpy = jest.spyOn(global, 'setInterval').mockReturnValue(1 as any);

        process.env.READ_ONLY_STORE = 'true';
        process.env.USE_LAMBDA_SCANNER = 'true';

        const app = new App();
        (app as any).registry = { handlesStore: jest.fn() };
        await (app as any).initializeOgmios();

        expect(repoInitialize).toHaveBeenCalled();
        expect(intervalSpy).toHaveBeenCalledTimes(2);
        expect(ogmiosInitialize).not.toHaveBeenCalled();
    });

    it('initializeOgmios runs service path when store is writable', async () => {
        const ogmiosInitialize = jest.fn().mockResolvedValue(undefined);
        mockedOgmiosClass.mockImplementation(() => ({ initialize: ogmiosInitialize }));

        process.env.READ_ONLY_STORE = 'false';

        const app = new App();
        (app as any).env = 'production';
        (app as any).registry = { handlesStore: jest.fn() };
        await (app as any).initializeOgmios();

        expect(ogmiosInitialize).toHaveBeenCalled();
    });

    it('logs swagger load errors', () => {
        const app = new App();
        const loggerSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());
        jest.spyOn(fs, 'readFileSync').mockImplementation(() => {
            throw new Error('unable to read');
        });

        (app as any).initializeSwagger();

        expect(loggerSpy).toHaveBeenCalledWith(expect.stringContaining('Unable to load swagger with error'));
    });
});
