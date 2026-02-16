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

        expect(process.env.ENABLE_OGMIOS_SCANNING).toBe('false');
        expect(AppMock).toHaveBeenCalledTimes(1);
        expect(appLambda).toHaveBeenCalledTimes(1);
        expect(serverlessExpress).toHaveBeenCalledWith({ app: appInstance.app });
        expect(lambdaModule.handler.length).toBe(2);
        expect(serverlessHandler).toHaveBeenCalledWith(event, context);
        expect(serverlessHandler.mock.calls[0]).toHaveLength(2);
        expect(result).toEqual(lambdaResponse);
    });
});
