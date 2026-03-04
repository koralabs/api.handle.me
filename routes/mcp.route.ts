import MCPController from '../controllers/mcp.controller';
import BaseRoute from './base';

class MCPRoute extends BaseRoute {
    public path = '/mcp';
    public mcpController = new MCPController();

    constructor() {
        super();
        this.initializeRoutes();
    }

    private initializeRoutes() {
        this.router.post(`${this.path}`, this.mcpController.post);
        this.router.get(`${this.path}`, this.mcpController.get);
    }
}

export default MCPRoute;
