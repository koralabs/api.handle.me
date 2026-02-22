import { HttpException, Logger, ModelException } from '@koralabs/kora-labs-common';
import errorMiddleware from './error.middleware';

const makeRes = () => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    return { json, status } as any;
};

describe('error middleware', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('returns 400 for ModelException', () => {
        const req = { method: 'GET', path: '/v1/handles' } as any;
        const res = makeRes();
        const next = jest.fn();

        errorMiddleware(new ModelException('invalid model') as any, req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ message: 'invalid model' });
        expect(next).not.toHaveBeenCalled();
    });

    it('returns the provided HttpException status', () => {
        const req = { method: 'GET', path: '/v1/handles' } as any;
        const res = makeRes();

        errorMiddleware(new HttpException(404, 'missing') as any, req, res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith({ message: 'missing' });
    });

    it('logs and returns 500 for generic errors', () => {
        const req = { method: 'POST', path: '/v1/mint' } as any;
        const res = makeRes();
        const logSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());

        errorMiddleware(new Error('unexpected') as any, req, res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ message: 'unexpected' });
        expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({ event: 'http.exception' }));
    });

    it('uses fallback message when error.message is empty', () => {
        const req = { method: 'GET', path: '/v1/health' } as any;
        const res = makeRes();
        const error = new Error('');
        const logSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());

        errorMiddleware(error as any, req, res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ message: 'Something went wrong' });
        expect(logSpy).toHaveBeenCalled();
    });

    it('forwards errors to next when writing the response fails', () => {
        const req = { method: 'GET', path: '/v1/handles' } as any;
        const next = jest.fn();
        const thrown = new Error('response failure');
        const res = {
            status: jest.fn(() => {
                throw thrown;
            })
        } as any;

        errorMiddleware(new HttpException(400, 'bad request') as any, req, res, next);

        expect(next).toHaveBeenCalledWith(thrown);
    });
});
