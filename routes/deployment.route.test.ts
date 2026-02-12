import DeploymentRoute from './deployment.route';

describe('DeploymentRoute tests', () => {
    it('should initialize GET /deployment route', () => {
        const route = new DeploymentRoute();
        const deploymentLayer = (route.router as any).stack.find((layer: any) => layer.route?.path === '/deployment');

        expect(route.path).toEqual('/deployment');
        expect(deploymentLayer).toBeDefined();
        expect(deploymentLayer.route.methods.get).toBe(true);
    });
});
