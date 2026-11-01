import HandlesController from './handles.controller';
import { HandlesRepository } from '../repositories/handlesRepository';

jest.mock('../repositories/handlesRepository');

const mockReq = (headers: Record<string, string> = {}) =>
    ({ app: { get: jest.fn().mockReturnValue({ handlesStore: jest.fn() }) }, query: {}, params: { handle: 'h' }, headers, get: (n: string) => headers[n.toLowerCase()] }) as any;
const mockRes = () => {
    const res: any = {};
    for (const m of ['set', 'status', 'json', 'send', 'contentType']) res[m] = jest.fn().mockReturnValue(res);
    return res;
};
const withRepo = (repo: Record<string, unknown>) => (HandlesRepository as unknown as jest.Mock).mockImplementation(() => repo);
const settingsHandle = { name: 'h', subhandle_settings: { utxo_id: 'tx#0' } };
const call = async (fn: (...a: any[]) => Promise<void>, headers?: Record<string, string>) => {
    const res = mockRes();
    const next = jest.fn();
    await fn.call(new HandlesController(), mockReq(headers), res, next);
    return { res, next };
};

describe('HandlesController error paths', () => {
    beforeEach(() => {
        jest.spyOn(HandlesController as any, 'getHandleFromRepo').mockResolvedValue({ code: 200, handle: settingsHandle });
    });
    afterEach(() => jest.restoreAllMocks());

    it('forwards a lookup failure to next instead of responding (personalization utxo)', async () => {
        const boom = new Error('lookup failed');
        (HandlesController as any).getHandleFromRepo.mockRejectedValue(boom);
        const { res, next } = await call(new HandlesController().getPersonalizationUTxO);
        expect(next).toHaveBeenCalledWith(boom);
        expect(res.json).not.toHaveBeenCalled();
    });

    it('reports a missing datum as an error, not an empty body', async () => {
        withRepo({ getHandleDatumByName: jest.fn().mockReturnValue(undefined) });
        const { res, next } = await call(new HandlesController().getHandleDatum);
        expect(next.mock.calls[0][0].message).toMatch(/datum/i);
        expect(res.send).not.toHaveBeenCalled();
    });

    it('text/plain subhandle settings without a datum is an error; with one it returns the raw datum', async () => {
        withRepo({ getUTxO: jest.fn().mockReturnValue({ tx_id: 'tx', index: 0 }) });
        let r = await call(new HandlesController().getSubHandleSettings, { accept: 'text/plain' });
        expect(r.next).toHaveBeenCalledTimes(1);
        expect(r.res.send).not.toHaveBeenCalled();

        withRepo({ getUTxO: jest.fn().mockReturnValue({ tx_id: 'tx', index: 0, datum: 'a1' }) });
        r = await call(new HandlesController().getSubHandleSettings, { accept: 'text/plain' });
        expect(r.res.send).toHaveBeenCalledWith('a1');
        expect(r.next).not.toHaveBeenCalled();
    });

    it('undecodable datums become an error in both subhandle settings endpoints', async () => {
        withRepo({ getUTxO: jest.fn().mockReturnValue({ tx_id: 'tx', index: 0, datum: 'ff' }) });
        for (const fn of [new HandlesController().getSubHandleSettings, new HandlesController().getSubHandleSettingsUTxO]) {
            const { res, next } = await call(fn);
            expect(next).toHaveBeenCalledTimes(1);
            expect(res.json).not.toHaveBeenCalled();
        }
    });
});
