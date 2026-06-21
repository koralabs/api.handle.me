import { NextFunction, Request, Response } from 'express';
import { ApiError } from './apiError';

// Returns an Express middleware that rejects requests carrying query params
// outside the supplied allow-list with 400 unknown_query_params. Use one
// per route registration so the spec lives next to the route definition.
// Passing no args means the route accepts no query parameters at all.
//
// Returns an untyped middleware (no `RequestHandler` annotation) so that
// adding it before a controller method doesn't widen the chain's inferred
// `Request<...>` generic — Express's overloaded `.get()` can't reconcile
// a custom param shape (e.g. `Request<IGetHandleRequest, ...>`) once a
// generic `RequestHandler` is in the middle. Matches the deprecated()
// helper's untyped pattern.
export const allowQueryParams = (...allowed: string[]) => {
    const allowedSet = new Set(allowed);
    return (req: Request, _res: Response, next: NextFunction) => {
        const unknown = Object.keys(req.query).filter((key) => !allowedSet.has(key));
        if (unknown.length) {
            return next(ApiError.unknownQueryParams(unknown));
        }
        return next();
    };
};
