describe('API lambda handler', () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        delete process.env.ENABLE_OGMIOS_SCANNING;
    });

    it('exports an async non-callback handler wrapper', async () => {
        const lambdaResponse = { statusCode: 200, body: 'ok' };
        const appInstance = { app: { use: jest.fn() } };
        const appLambda = jest.fn().mockResolvedValue(appInstance);
        const AppMock = jest.fn().mockImplementation(() => ({ lambda: appLambda }));
        const serverlessHandler = jest.fn().mockResolvedValue(lambdaResponse);
        const serverlessExpress = jest.fn().mockReturnValue(serverlessHandler);

        jest.doMock('../app', () => ({ __esModule: true, default: AppMock }));
        jest.doMock('@vendia/serverless-express', () => ({ __esModule: true, default: serverlessExpress }));

        let lambdaModule: any;
        await jest.isolateModulesAsync(async () => {
            lambdaModule = await import('./api');
        });

        const event = { requestContext: { elb: {} } } as any;
        const context = {} as any;
        const result = await lambdaModule.handler(event, context);

        expect(AppMock).toHaveBeenCalledTimes(1);
        expect(AppMock).toHaveBeenCalledWith({ disableOgmios: true });
        expect(appLambda).toHaveBeenCalledTimes(1);
        expect(serverlessExpress).toHaveBeenCalledWith({ app: appInstance.app });
        expect(lambdaModule.handler.length).toBe(2);
        expect(serverlessHandler).toHaveBeenCalledWith(event, context);
        expect(serverlessHandler.mock.calls[0]).toHaveLength(2);
        expect(result).toEqual(lambdaResponse);
    });

    it('hydrates before loading the API app module', async () => {
        const lambdaResponse = { statusCode: 200, body: 'ok' };
        const event = { requestContext: { elb: {} } } as any;
        const context = {} as any;
        let appLoaded = false;
        let hydrated = false;
        const appHandler = jest.fn().mockImplementation(async () => {
            if (!hydrated) {
                throw new Error('api app loaded before hydration');
            }
            return lambdaResponse;
        });
        const hydrateKmsEnvironment = jest.fn().mockImplementation(async () => {
            hydrated = true;
        });

        jest.doMock('@koralabs/kora-labs-common', () => ({ hydrateKmsEnvironment }));
        jest.doMock('./api.app', () => {
            appLoaded = true;
            return { handler: appHandler };
        });

        let lambdaModule: any;
        await jest.isolateModulesAsync(async () => {
            lambdaModule = await import('./api');
        });

        expect(appLoaded).toBe(false);
        await expect(lambdaModule.handler(event, context)).resolves.toEqual(lambdaResponse);
        expect(appLoaded).toBe(true);
        expect(hydrateKmsEnvironment).toHaveBeenCalledTimes(1);
        expect(appHandler).toHaveBeenCalledWith(event, context);
    });
});
