import RootHandlesRoute from './rootHandles.route';

describe('RootHandlesRoute tests', () => {
    it('should initialize GET /root-handles route', () => {
        const route = new RootHandlesRoute();
        const rootHandlesLayer = (route.router as any).stack.find((layer: any) => layer.route?.path === '/root-handles');

        expect(route.path).toEqual('/root-handles');
        expect(rootHandlesLayer).toBeDefined();
        expect(rootHandlesLayer.route.methods.get).toBe(true);
    });
});
