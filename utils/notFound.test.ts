import express from 'express';
import notFoundMiddleware from './notFound';
import { ApiError } from './apiError';

// Invariant: a request whose path has routes but not for its method gets 405 + Allow; unknown paths get 404; matching method passes through.
const run = (app: express.Application, method: string, path: string): { err?: ApiError; passed: boolean } => {
    let err: ApiError | undefined;
    let passed = false;
    notFoundMiddleware(app)({ path, method } as any, {} as any, ((e?: any) => {
        if (e) err = e;
        else passed = true;
    }) as any);
    return { err, passed };
};

describe('notFoundMiddleware', () => {
    const app = express();
    app.get('/handles/:name', (_q, r) => r.end());
    const router = express.Router();
    router.post('/mint', (_q, r) => r.end());
    app.use('/', router);

    it('passes through when the method has a handler (GET also covers HEAD)', () => {
        expect(run(app, 'GET', '/handles/foo').passed).toBe(true);
        expect(run(app, 'HEAD', '/handles/foo').passed).toBe(true);
    });

    it('finds routes mounted through nested routers', () => {
        expect(run(app, 'POST', '/mint').passed).toBe(true);
    });

    it('returns 405 with a sorted Allow list when the path exists for other methods', () => {
        const { err } = run(app, 'DELETE', '/handles/foo');
        expect(err?.message).toContain('Allowed methods: GET, HEAD, OPTIONS');
        expect(err).toMatchObject({ status: 405 });
    });

    it('returns 404 route_not_found for an unknown path', () => {
        const { err, passed } = run(app, 'GET', '/nope');
        expect(passed).toBe(false);
        expect(err?.message).toBe('Route not found: /nope');
    });
});
