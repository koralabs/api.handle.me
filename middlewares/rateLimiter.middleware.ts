import { rateLimit } from 'express-rate-limit';
import { WHITELISTED_API_KEYS } from '../config';
import { RATE_LIMITER_ENABLED } from '../config/constants';
import { ApiError } from '../utils/apiError';

const rateLimiterMiddleware = rateLimit({
    windowMs: 1000,
    max: 5, // Limit to x requests per `windowMs`
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skip: (req) => {
        if (!RATE_LIMITER_ENABLED) return true;
        const apiHeader = req.header('api-key');
        return !!apiHeader && WHITELISTED_API_KEYS.includes(apiHeader);
    },
    handler: (_req, _res, next) => next(ApiError.rateLimited())
});

export default rateLimiterMiddleware;
