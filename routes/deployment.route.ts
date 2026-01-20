import { Router } from 'express';
import DeploymentController from '../controllers/deployment.controller';
import BaseRoute from './base';

class StatsRoute extends BaseRoute {
    public path = '/deployment';
    public router = Router();
    public deploymentController = new DeploymentController();

    constructor() {
        super();
        this.initializeRoutes();
    }

    private initializeRoutes() {
        this.router.get(`${this.path}`, this.deploymentController.index);
    }
}

export default StatsRoute;