import * as scriptsConfig from '../config/scripts';
import responseMiddleware from './response.middleware';

describe('response middleware', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('adds script payload when endpoint and script lookup match', () => {
        const getScriptSpy = jest.spyOn(scriptsConfig, 'getScript').mockReturnValue({ validatorHash: 'abc' } as any);
        const originalJson = jest.fn();
        const req = {
            url: '/handles/example/reference_token'
        } as any;
        const res = { json: originalJson } as any;
        const next = jest.fn();

        responseMiddleware(req, res, next);
        res.json({ address: 'addr', value: 1 });

        expect(getScriptSpy).toHaveBeenCalledWith('addr');
        expect(originalJson).toHaveBeenCalledWith({ address: 'addr', value: 1, script: { validatorHash: 'abc' } });
        expect(next).toHaveBeenCalled();
    });

    it('keeps payload unchanged when script lookup returns nothing', () => {
        jest.spyOn(scriptsConfig, 'getScript').mockReturnValue(undefined as any);
        const originalJson = jest.fn();
        const req = {
            url: '/handles/example/utxo'
        } as any;
        const res = { json: originalJson } as any;

        responseMiddleware(req, res, jest.fn());
        res.json({ address: 'addr', value: 1 });

        expect(originalJson).toHaveBeenCalledWith({ address: 'addr', value: 1 });
    });
});
