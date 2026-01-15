import { rateLimit } from 'express-rate-limit';
import { WHITELISTED_API_KEYS } from '../config';

const rateLimiterMiddleware = rateLimit({
    windowMs: 1000,
    max: 5, // Limit to x requests per `windowMs`
    skip: (req, res) => {
        const apiHeader = req.header('api-key');
        return !!apiHeader && WHITELISTED_API_KEYS.includes(apiHeader);
    }
});

export default rateLimiterMiddleware;
