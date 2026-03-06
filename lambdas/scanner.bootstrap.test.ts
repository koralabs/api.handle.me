describe('Scanner lambda bootstrap', () => {
    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
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

        jest.doMock('@koralabs/kora-labs-common', () => ({ hydrateKmsEnvironment }));
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
});
