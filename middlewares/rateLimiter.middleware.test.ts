describe('rateLimiter middleware config', () => {
    afterEach(() => {
        jest.resetModules();
    });

    const loadSkip = async (enabled: boolean, keys = 'key-1,key-2') => {
        const rateLimitMock = jest.fn((options) => options);
        jest.doMock('express-rate-limit', () => ({ rateLimit: rateLimitMock }));
        jest.doMock('../config/constants', () => ({ RATE_LIMITER_ENABLED: enabled }));
        jest.doMock('../config', () => ({ WHITELISTED_API_KEYS: keys }));

        const moduleRef: any = await import('./rateLimiter.middleware');
        return moduleRef.default.skip as (req: any, res: any) => boolean;
    };

    it('skips when rate limiter is disabled', async () => {
        const skip = await loadSkip(false);
        expect(skip({ header: jest.fn() }, {})).toBe(true);
    });

    it('skips when api-key is whitelisted', async () => {
        const skip = await loadSkip(true, 'allowed-key,other-key');
        const req = {
            header: jest.fn().mockReturnValue('allowed-key')
        };

        expect(skip(req, {})).toBe(true);
        expect(req.header).toHaveBeenCalledWith('api-key');
    });

    it('does not skip when enabled and api-key is absent or not whitelisted', async () => {
        const skip = await loadSkip(true, 'allowed-key');
        expect(skip({ header: jest.fn().mockReturnValue(undefined) }, {})).toBe(false);
        expect(skip({ header: jest.fn().mockReturnValue('blocked-key') }, {})).toBe(false);
    });
});
