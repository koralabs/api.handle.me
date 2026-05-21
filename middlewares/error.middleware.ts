import { HttpException, LogCategory, Logger, ModelException } from '@koralabs/kora-labs-common';
import { NextFunction, Request, Response } from 'express';
import { ApiError, DEFAULT_DOCS_URL, statusCodeToErrorCode } from '../utils/apiError';

const errorMiddleware = (error: Error | HttpException | ApiError, req: Request, res: Response, next: NextFunction) => {
    try {
        let status = 500;
        let code = 'internal_error';
        let docs = DEFAULT_DOCS_URL;
        const message: string = error.message || 'Something went wrong';

        if (error instanceof ApiError) {
            status = error.status;
            code = error.code;
            docs = error.docs;
            if (error.headers) {
                for (const [key, value] of Object.entries(error.headers)) {
                    res.set(key, value);
                }
            }
        } else if (error instanceof ModelException) {
            status = 400;
            code = 'bad_request';
        } else if (error instanceof HttpException) {
            status = error.status;
            code = statusCodeToErrorCode(status);
        } else {
            // body-parser (and similar middleware) tag client-fault errors with
            // a numeric .status / .statusCode in the 4xx range — e.g. malformed
            // JSON bodies raise SyntaxError with status=400, type=entity.parse.failed.
            // Honor that instead of defaulting to 500.
            const tagged = (error as any).status ?? (error as any).statusCode;
            if (typeof tagged === 'number' && tagged >= 400 && tagged < 500) {
                status = tagged;
                code = statusCodeToErrorCode(status);
            }
        }

        if (status >= 500) {
            Logger.log({
                message: `[${req.method}] ${req.path} >> StatusCode:: ${status}, Message:: ${message}, Stack: ${error.stack}`,
                category: LogCategory.ERROR,
                event: 'http.exception'
            });
        }
        res.status(status).json({ error: code, message, docs });
    } catch (err) {
        next(err);
    }
};

export default errorMiddleware;
