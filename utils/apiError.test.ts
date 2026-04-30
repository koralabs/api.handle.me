import { HttpException } from '@koralabs/kora-labs-common';
import { ApiError, DEFAULT_DOCS_URL, HANDLE_HELP_URL, statusCodeToErrorCode } from './apiError';

describe('ApiError', () => {
    it('extends HttpException so existing instanceof checks keep working', () => {
        const err = ApiError.handleNotFound();
        expect(err).toBeInstanceOf(HttpException);
        expect(err).toBeInstanceOf(ApiError);
    });

    it('only the "this name is not a known handle" 404s point at the handle FAQ URL', () => {
        // The FAQ explains handle naming + how to mint, which is the right
        // landing page when the agent's question is "why didn't this name resolve?".
        for (const err of [ApiError.handleNotFound(), ApiError.handleNameInvalid()]) {
            expect(err.status).toEqual(404);
            expect(err.docs).toEqual(HANDLE_HELP_URL);
        }
    });

    it('404s on adjacent artifacts (datum / script / subhandle settings) use the generic API root URL', () => {
        // These errors aren't about whether the name itself is valid — they're
        // about whether the API has the requested artifact for an existing handle.
        // The FAQ wouldn't help, so route them to the API docs instead.
        const helpers = [
            ApiError.datumNotFound(),
            ApiError.scriptNotFound(),
            ApiError.latestScriptNotFound(),
            ApiError.subhandleSettingsNotFound(),
            ApiError.subhandleSettingsUtxoNotFound()
        ];
        for (const err of helpers) {
            expect(err.status).toEqual(404);
            expect(err.docs).toEqual(DEFAULT_DOCS_URL);
        }
    });

    it('non-handle 404s stay on the generic API root URL', () => {
        const route = ApiError.routeNotFound('/foo');
        expect(route.docs).toEqual(DEFAULT_DOCS_URL);
        const policies = ApiError.policiesNotFound();
        expect(policies.docs).toEqual(DEFAULT_DOCS_URL);
    });

    it('methodNotAllowed attaches an Allow header for the global error middleware to surface', () => {
        const err = ApiError.methodNotAllowed(['GET', 'HEAD']);
        expect(err.status).toEqual(405);
        expect(err.code).toEqual('method_not_allowed');
        expect(err.headers).toEqual({ Allow: 'GET, HEAD' });
    });

    it('rateLimited carries machine code "rate_limited" so agents can branch on it', () => {
        const err = ApiError.rateLimited();
        expect(err.status).toEqual(429);
        expect(err.code).toEqual('rate_limited');
    });

    it('statusCodeToErrorCode maps the HTTP statuses we use to stable machine strings', () => {
        expect(statusCodeToErrorCode(400)).toEqual('bad_request');
        expect(statusCodeToErrorCode(404)).toEqual('not_found');
        expect(statusCodeToErrorCode(405)).toEqual('method_not_allowed');
        expect(statusCodeToErrorCode(406)).toEqual('not_acceptable');
        expect(statusCodeToErrorCode(429)).toEqual('rate_limited');
        expect(statusCodeToErrorCode(451)).toEqual('unavailable_for_legal_reasons');
        expect(statusCodeToErrorCode(500)).toEqual('internal_error');
        expect(statusCodeToErrorCode(503)).toEqual('internal_error');
    });
});
