import { Application, NextFunction, Request, Response } from 'express';
import { ApiError } from './apiError';

interface RouteEntry {
    regexp: RegExp;
    methods: Set<string>;
}

// Walk the entire Express middleware stack — including the inner stacks of
// `app.use(path, router)` mounts — and gather a flat (regexp, methods) map.
// Without descending into nested routers, the 405 fall-through would only see
// top-level `app.get(...)` registrations and would 404 routes mounted via
// `app.use('/', router)`.
const collectRouteLayers = (stack: any[]): RouteEntry[] => {
    const out: RouteEntry[] = [];
    for (const layer of stack) {
        if (layer?.route) {
            const methods = new Set<string>();
            for (const method of Object.keys(layer.route.methods ?? {})) {
                if (layer.route.methods[method]) methods.add(method.toUpperCase());
            }
            // GET implies HEAD per RFC 9110 §9.3.2; OPTIONS always allowed for
            // capability discovery / CORS preflight.
            if (methods.has('GET')) methods.add('HEAD');
            methods.add('OPTIONS');
            out.push({ regexp: layer.regexp as RegExp, methods });
        } else if (layer?.name === 'router' && layer?.handle?.stack) {
            out.push(...collectRouteLayers(layer.handle.stack));
        }
    }
    return out;
};

const buildRouteIndex = (app: Application): RouteEntry[] => {
    const stack = (app as any)?._router?.stack ?? [];
    return collectRouteLayers(stack);
};

const notFoundMiddleware = (app: Application) => {
    // Rebuild on every fall-through (rather than caching at startup) because
    // routes can be registered AFTER `app.initialize()` returns — for example
    // by tests that register a probe route on top of an already-initialized
    // app. A stale cache would spuriously 404 those routes.
    return (req: Request, _res: Response, next: NextFunction) => {
        const routes = buildRouteIndex(app);
        const path = req.path;
        const method = req.method.toUpperCase();
        const allMethodsForPath = new Set<string>();
        for (const entry of routes) {
            if (entry.regexp.test(path)) {
                for (const m of entry.methods) allMethodsForPath.add(m);
            }
        }
        // A handler exists for this exact method+path — must be downstream of
        // this middleware in the chain (e.g. test-added route). Pass through
        // so Express keeps walking and finds it.
        if (allMethodsForPath.has(method)) {
            return next();
        }
        // Path matched at least one registered route but not the request's method.
        if (allMethodsForPath.size > 0) {
            return next(ApiError.methodNotAllowed([...allMethodsForPath].sort()));
        }
        // Nothing in the route table matches this path at all.
        return next(ApiError.routeNotFound(path));
    };
};

export default notFoundMiddleware;
