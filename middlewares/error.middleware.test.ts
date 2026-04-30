import { HttpException, Logger, ModelException } from '@koralabs/kora-labs-common';
import { ApiError, DEFAULT_DOCS_URL, HANDLE_HELP_URL } from '../utils/apiError';
import errorMiddleware from './error.middleware';

const makeRes = () => {
    const json = jest.fn();
    const set = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    return { json, set, status } as any;
};

describe('error middleware', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('returns 400 + bad_request error code for ModelException', () => {
        const req = { method: 'GET', path: '/v1/handles' } as any;
        const res = makeRes();
        const next = jest.fn();

        errorMiddleware(new ModelException('invalid model') as any, req, res, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({
            error: 'bad_request',
            message: 'invalid model',
            docs: DEFAULT_DOCS_URL
        });
        expect(next).not.toHaveBeenCalled();
    });

    it('maps a generic HttpException status to a status-derived error code', () => {
        const req = { method: 'GET', path: '/v1/handles' } as any;
        const res = makeRes();

        errorMiddleware(new HttpException(404, 'missing') as any, req, res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith({
            error: 'not_found',
            message: 'missing',
            docs: DEFAULT_DOCS_URL
        });
    });

    it('preserves ApiError code, message, docs, and headers verbatim', () => {
        const req = { method: 'GET', path: '/v1/handles' } as any;
        const res = makeRes();

        const err = ApiError.handleNameInvalid();
        errorMiddleware(err, req, res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith({
            error: 'handle_not_found',
            message: 'Handle not found',
            docs: HANDLE_HELP_URL
        });
    });

    it('sets headers attached to an ApiError (Allow on 405)', () => {
        const req = { method: 'POST', path: '/handles/ada' } as any;
        const res = makeRes();

        errorMiddleware(ApiError.methodNotAllowed(['GET', 'HEAD', 'OPTIONS']), req, res, jest.fn());

        expect(res.set).toHaveBeenCalledWith('Allow', 'GET, HEAD, OPTIONS');
        expect(res.status).toHaveBeenCalledWith(405);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
            error: 'method_not_allowed'
        }));
    });

    it('logs and returns 500 + internal_error for generic Error', () => {
        const req = { method: 'POST', path: '/v1/mint' } as any;
        const res = makeRes();
        const logSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());

        errorMiddleware(new Error('unexpected') as any, req, res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
            error: 'internal_error',
            message: 'unexpected',
            docs: DEFAULT_DOCS_URL
        });
        expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({ event: 'http.exception' }));
    });

    it('uses fallback message when error.message is empty', () => {
        const req = { method: 'GET', path: '/v1/health' } as any;
        const res = makeRes();
        const error = new Error('');
        const logSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());

        errorMiddleware(error as any, req, res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({
            error: 'internal_error',
            message: 'Something went wrong',
            docs: DEFAULT_DOCS_URL
        });
        expect(logSpy).toHaveBeenCalled();
    });

    it('forwards errors to next when writing the response fails', () => {
        const req = { method: 'GET', path: '/v1/handles' } as any;
        const next = jest.fn();
        const thrown = new Error('response failure');
        const res = {
            set: jest.fn(),
            status: jest.fn(() => {
                throw thrown;
            })
        } as any;

        errorMiddleware(new HttpException(400, 'bad request') as any, req, res, next);

        expect(next).toHaveBeenCalledWith(thrown);
    });
});
