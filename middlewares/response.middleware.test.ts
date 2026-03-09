import * as scriptsService from '../services/scripts.service';
import responseMiddleware from './response.middleware';

describe('response middleware', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('adds script payload when endpoint and script lookup match', async () => {
        const getScriptSpy = jest.spyOn(scriptsService, 'getScriptByRefAddress').mockResolvedValue({ validatorHash: 'abc' } as any);
        const originalJson = jest.fn();
        const req = {
            url: '/handles/example/reference_token',
            app: {}
        } as any;
        const res = { json: originalJson } as any;
        const next = jest.fn();

        responseMiddleware(req, res, next);
        await res.json({ address: 'addr', value: 1 });

        expect(getScriptSpy).toHaveBeenCalledWith(req, 'addr');
        expect(originalJson).toHaveBeenCalledWith({ address: 'addr', value: 1, script: { validatorHash: 'abc' } });
        expect(next).toHaveBeenCalled();
    });

    it('keeps payload unchanged when script lookup returns nothing', async () => {
        jest.spyOn(scriptsService, 'getScriptByRefAddress').mockResolvedValue(undefined as any);
        const originalJson = jest.fn();
        const req = {
            url: '/handles/example/utxo',
            app: {}
        } as any;
        const res = { json: originalJson } as any;

        responseMiddleware(req, res, jest.fn());
        await res.json({ address: 'addr', value: 1 });

        expect(originalJson).toHaveBeenCalledWith({ address: 'addr', value: 1 });
    });
});
