import { rateLimit } from 'express-rate-limit';
import { WHITELISTED_API_KEYS } from '../config';
import { RATE_LIMITER_ENABLED } from '../config/constants';

const rateLimiterMiddleware = rateLimit({
    windowMs: 1000,
    max: 5, // Limit to x requests per `windowMs`
    skip: (req, res) => {
        if (!RATE_LIMITER_ENABLED) return true;
        const apiHeader = req.header('api-key');
        return !!apiHeader && WHITELISTED_API_KEYS.includes(apiHeader);
    }
});

export default rateLimiterMiddleware;
