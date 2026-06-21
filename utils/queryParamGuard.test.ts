import { Request, Response } from 'express';
import { ApiError, DEFAULT_DOCS_URL } from './apiError';
import { allowQueryParams } from './queryParamGuard';

const makeReq = (query: Record<string, unknown>) => ({ query } as unknown as Request);

describe('allowQueryParams', () => {
    it('calls next() with no error when every key is allowed', () => {
        const next = jest.fn();
        const guard = allowQueryParams('a', 'b', 'c');

        guard(makeReq({ a: '1', c: '3' }), {} as Response, next);

        expect(next).toHaveBeenCalledTimes(1);
        expect(next).toHaveBeenCalledWith();
    });

    it('calls next() with no error when the request has no query at all', () => {
        const next = jest.fn();
        const guard = allowQueryParams('a', 'b');

        guard(makeReq({}), {} as Response, next);

        expect(next).toHaveBeenCalledWith();
    });

    it('rejects an unknown key with a 400 ApiError carrying the standard docs URL', () => {
        const next = jest.fn();
        const guard = allowQueryParams('holder_address');

        guard(makeReq({ holder: 'stake1abc' }), {} as Response, next);

        expect(next).toHaveBeenCalledTimes(1);
        const err = next.mock.calls[0][0] as ApiError;
        expect(err).toBeInstanceOf(ApiError);
        expect(err.status).toBe(400);
        expect(err.code).toBe('unknown_query_params');
        // Singular form for one unknown key — wording is part of the contract.
        expect(err.message).toBe("Unknown query parameter: 'holder'");
        // Inherits DEFAULT_DOCS_URL the same way 404s do.
        expect(err.docs).toBe(DEFAULT_DOCS_URL);
    });

    it('lists every unknown key, in order, with plural wording', () => {
        const next = jest.fn();
        const guard = allowQueryParams('a');

        guard(makeReq({ a: '1', x: '2', y: '3' }), {} as Response, next);

        const err = next.mock.calls[0][0] as ApiError;
        expect(err.message).toBe("Unknown query parameters: 'x', 'y'");
    });

    it('rejects any key when the allow-list is empty', () => {
        const next = jest.fn();
        const guard = allowQueryParams();

        guard(makeReq({ anything: 'goes' }), {} as Response, next);

        const err = next.mock.calls[0][0] as ApiError;
        expect(err.status).toBe(400);
        expect(err.code).toBe('unknown_query_params');
    });
});
