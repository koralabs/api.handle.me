describe('rateLimiter middleware config', () => {
    afterEach(() => {
        jest.resetModules();
    });

    const loadOptions = async (enabled: boolean, keys = 'key-1,key-2') => {
        const rateLimitMock = jest.fn((options) => options);
        jest.doMock('express-rate-limit', () => ({ rateLimit: rateLimitMock }));
        jest.doMock('../config/constants', () => ({ RATE_LIMITER_ENABLED: enabled }));
        jest.doMock('../config', () => ({ WHITELISTED_API_KEYS: keys }));

        const moduleRef: any = await import('./rateLimiter.middleware');
        return moduleRef.default;
    };

    const loadSkip = async (enabled: boolean, keys = 'key-1,key-2') => {
        const opts = await loadOptions(enabled, keys);
        return opts.skip as (req: any, res: any) => boolean;
    };

    it('uses standardHeaders draft-7 so RateLimit-* headers (RFC 9239) ship on every limited response', async () => {
        const opts = await loadOptions(true);
        expect(opts.standardHeaders).toEqual('draft-7');
        expect(opts.legacyHeaders).toEqual(false);
    });

    it('routes 429 through the global error middleware so it gets the canonical {error, message, docs} shape', async () => {
        const opts = await loadOptions(true);
        const next = jest.fn();
        opts.handler({}, {}, next);
        expect(next).toHaveBeenCalledTimes(1);
        const arg = next.mock.calls[0][0];
        expect(arg).toEqual(expect.objectContaining({
            status: 429,
            code: 'rate_limited'
        }));
    });

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
