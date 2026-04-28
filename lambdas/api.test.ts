describe('API lambda handler', () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        delete process.env.ENABLE_OGMIOS_SCANNING;
        delete process.env.RATE_LIMITER_ENABLED;
        delete process.env.WHITELISTED_API_KEYS;
        delete process.env.WHITELISTED_API_KEYS_ENC;
    });

    it('exports an async non-callback handler wrapper for ALB and Function URL events', async () => {
        const albResponse = { statusCode: 200, body: 'alb' };
        const functionUrlResponse = { statusCode: 200, body: 'function-url' };
        const appInstance = { app: { use: jest.fn() } };
        const appLambda = jest.fn().mockResolvedValue(appInstance);
        const AppMock = jest.fn().mockImplementation(() => ({ lambda: appLambda }));
        const albHandler = jest.fn().mockResolvedValue(albResponse);
        const functionUrlHandler = jest.fn().mockResolvedValue(functionUrlResponse);
        const serverlessExpress = jest.fn()
            .mockReturnValueOnce(albHandler)
            .mockReturnValueOnce(functionUrlHandler);

        jest.doMock('../app', () => ({ __esModule: true, default: AppMock }));
        jest.doMock('@vendia/serverless-express', () => ({ __esModule: true, default: serverlessExpress }));

        let lambdaModule: any;
        await jest.isolateModulesAsync(async () => {
            lambdaModule = await import('./api');
        });

        const albEvent = { requestContext: { elb: {} } } as any;
        const functionUrlEvent = { requestContext: { http: { method: 'GET', path: '/stats' } }, rawPath: '/stats' } as any;
        const context = {} as any;
        const firstAlbResult = await lambdaModule.handler(albEvent, context);
        const secondAlbResult = await lambdaModule.handler(albEvent, context);
        const functionUrlResult = await lambdaModule.handler(functionUrlEvent, context);

        expect(process.env.ENABLE_OGMIOS_SCANNING).toBe('false');
        expect(AppMock).toHaveBeenCalledTimes(1);
        expect(appLambda).toHaveBeenCalledTimes(1);
        expect(serverlessExpress).toHaveBeenNthCalledWith(1, { app: appInstance.app, eventSourceName: 'AWS_ALB' });
        expect(serverlessExpress).toHaveBeenNthCalledWith(2, { app: appInstance.app, eventSourceName: 'AWS_API_GATEWAY_V2' });
        expect(lambdaModule.handler.length).toBe(2);
        expect(albHandler).toHaveBeenCalledTimes(2);
        expect(albHandler).toHaveBeenCalledWith(albEvent, context);
        expect(albHandler.mock.calls[0]).toHaveLength(2);
        expect(functionUrlHandler).toHaveBeenCalledWith(functionUrlEvent, context);
        expect(functionUrlHandler.mock.calls[0]).toHaveLength(2);
        expect(firstAlbResult).toEqual(albResponse);
        expect(secondAlbResult).toEqual(albResponse);
        expect(functionUrlResult).toEqual(functionUrlResponse);
    });

    it('hydrates whitelisted api keys before loading the API app module when rate limiting is enabled', async () => {
        const lambdaResponse = { statusCode: 200, body: 'ok' };
        const event = { requestContext: { elb: {} } } as any;
        const context = {} as any;
        process.env.RATE_LIMITER_ENABLED = 'true';
        process.env.WHITELISTED_API_KEYS_ENC = 'ciphertext';
        let appLoaded = false;
        let hydrated = false;
        const appHandler = jest.fn().mockImplementation(async () => {
            if (!hydrated) {
                throw new Error('api app loaded before hydration');
            }
            return lambdaResponse;
        });
        const hydrateKmsKeysIfNeeded = jest.fn().mockImplementation(async (keys: string[]) => {
            expect(keys).toEqual(['WHITELISTED_API_KEYS']);
            hydrated = true;
        });

        jest.doMock('../utils/kms', () => ({ hydrateKmsKeysIfNeeded }));
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
        expect(hydrateKmsKeysIfNeeded).toHaveBeenCalledTimes(1);
        expect(appHandler).toHaveBeenCalledWith(event, context, { eventSourceName: 'AWS_ALB' });
    });

    it('returns a 400 response for unsupported event sources without loading the app', async () => {
        const context = {} as any;
        let appLoaded = false;

        jest.doMock('./api.app', () => {
            appLoaded = true;
            return { handler: jest.fn() };
        });

        let lambdaModule: any;
        await jest.isolateModulesAsync(async () => {
            lambdaModule = await import('./api');
        });

        await expect(lambdaModule.handler({ source: 'manual-test' } as any, context)).resolves.toEqual({
            statusCode: 400,
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                message: 'Unsupported event source'
            })
        });
        expect(appLoaded).toBe(false);
    });
});
