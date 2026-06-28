import MptRootRoute from './mptRoot.route';

const findRouteLayer = (route: MptRootRoute, path: string) =>
    (route.router as any).stack.find((layer: any) => layer.route?.path === path);

describe('MptRootRoute tests', () => {
    it('initializes all MPT root GET endpoints with their query guards', () => {
        const route = new MptRootRoute();

        expect(route.path).toEqual('/mpt-root');

        const indexLayer = findRouteLayer(route, '/mpt-root');
        const proofLayer = findRouteLayer(route, '/mpt-root/proof');
        const registryLabelsLayer = findRouteLayer(route, '/mpt-root/registry-labels');

        expect(indexLayer.route.methods.get).toBe(true);
        expect(proofLayer.route.methods.get).toBe(true);
        expect(registryLabelsLayer.route.methods.get).toBe(true);
        expect(indexLayer.route.stack).toHaveLength(2);
        expect(proofLayer.route.stack).toHaveLength(2);
        expect(registryLabelsLayer.route.stack).toHaveLength(2);
    });

    it('only allows proof-specific query parameters on the proof endpoint', () => {
        const route = new MptRootRoute();
        const proofLayer = findRouteLayer(route, '/mpt-root/proof');
        const guard = proofLayer.route.stack[0].handle;
        const next = jest.fn();

        guard({ query: { handle: 'alice', label: '00001070', amount: '1' } }, {}, next);

        expect(next).toHaveBeenCalledWith();
    });

    it('rejects query parameters on endpoints that do not accept them', () => {
        const route = new MptRootRoute();
        const indexLayer = findRouteLayer(route, '/mpt-root');
        const guard = indexLayer.route.stack[0].handle;
        const next = jest.fn();

        guard({ query: { handle: 'alice' } }, {}, next);

        const err = next.mock.calls[0][0];
        expect(err.status).toBe(400);
        expect(err.code).toBe('unknown_query_params');
    });
});
