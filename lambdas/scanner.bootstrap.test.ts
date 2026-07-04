const ORIGINAL_ENV = { ...process.env };

describe('Scanner lambda bootstrap', () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        process.env = { ...ORIGINAL_ENV };
    });

    afterAll(() => {
        process.env = ORIGINAL_ENV;
    });

    it('hydrates before loading scanner app exports', async () => {
        let appLoaded = false;
        let hydrated = false;
        const lambdaResult = { statusCode: 200 };
        const rollbackResult = { ok: true };
        const hydrateKmsEnvironment = jest.fn().mockImplementation(async () => {
            hydrated = true;
        });
        const lambdaHandler = jest.fn().mockImplementation(async () => {
            if (!hydrated) {
                throw new Error('scanner app loaded before hydration');
            }
            return lambdaResult;
        });
        const checkRollback = jest.fn().mockImplementation(async () => {
            if (!hydrated) {
                throw new Error('scanner internals loaded before hydration');
            }
            return rollbackResult;
        });

        jest.doMock('@koralabs/kora-labs-common/aws', () => ({ hydrateKmsEnvironment }));
        jest.doMock('./scanner.app', () => {
            appLoaded = true;
            return {
                lambdaHandler,
                Internal: {
                    checkRollback,
                    processRollback: jest.fn(),
                    processReindex: jest.fn(),
                    scan: jest.fn()
                }
            };
        });

        let scannerModule: any;
        await jest.isolateModulesAsync(async () => {
            scannerModule = await import('./scanner');
        });

        expect(appLoaded).toBe(false);
        await expect(scannerModule.lambdaHandler({} as any, {} as any)).resolves.toEqual(lambdaResult);
        await expect(scannerModule.Internal.checkRollback({ currentSlot: 1 } as any)).resolves.toEqual(rollbackResult);
        expect(appLoaded).toBe(true);
        expect(hydrateKmsEnvironment).toHaveBeenCalledTimes(2);
    });

    it('turns self-hosted function-url bootstrap failures into 500 responses', async () => {
        process.env.KORA_SCANNER_DEFER_IMPORTS = 'true';
        const hydrateKmsEnvironment = jest.fn().mockResolvedValue([]);
        const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

        jest.doMock('@koralabs/kora-labs-common/aws', () => ({ hydrateKmsEnvironment }));
        jest.doMock('./scanner.app', () => {
            throw new Error('scanner import boom');
        });

        let scannerModule: any;
        await jest.isolateModulesAsync(async () => {
            scannerModule = await import('./scanner');
        });

        try {
            await expect(scannerModule.lambdaHandler({ requestContext: { http: {} } } as any, {} as any)).resolves.toEqual({
                isBase64Encoded: false,
                statusCode: 500,
                headers: {
                    'content-type': 'application/json'
                },
                body: JSON.stringify({ message: 'Scanner bootstrap failed' })
            });
            expect(hydrateKmsEnvironment).toHaveBeenCalledTimes(1);
            expect(consoleError).toHaveBeenCalledTimes(1);
            expect(consoleError.mock.calls[0][0]).toContain('scannerLambda.bootstrapFailure');
            expect(consoleError.mock.calls[0][0]).toContain('scanner import boom');
        } finally {
            consoleError.mockRestore();
        }
    });

    it('keeps throwing bootstrap failures outside self-hosted scanner runtime', async () => {
        const hydrateKmsEnvironment = jest.fn().mockResolvedValue([]);

        jest.doMock('@koralabs/kora-labs-common/aws', () => ({ hydrateKmsEnvironment }));
        jest.doMock('./scanner.app', () => {
            throw new Error('scanner import boom');
        });

        let scannerModule: any;
        await jest.isolateModulesAsync(async () => {
            scannerModule = await import('./scanner');
        });

        await expect(scannerModule.lambdaHandler({ requestContext: { http: {} } } as any, {} as any)).rejects.toThrow('scanner import boom');
        expect(hydrateKmsEnvironment).toHaveBeenCalledTimes(1);
    });
});
