import { Router } from 'express';
import MptRootController from '../controllers/mptRoot.controller';
import { allowQueryParams } from '../utils/queryParamGuard';
import BaseRoute from './base';

class MptRootRoute extends BaseRoute {
    public path = '/mpt-root';
    public router = Router();
    public mptRootController = new MptRootController();

    constructor() {
        super();
        this.initializeRoutes();
    }

    private initializeRoutes() {
        this.router.get(`${this.path}`, allowQueryParams(), this.mptRootController.index);
        this.router.get(`${this.path}/proof`, allowQueryParams('handle', 'label', 'amount'), this.mptRootController.proof);
        this.router.get(`${this.path}/registry-labels`, allowQueryParams(), this.mptRootController.registryLabels);
    }
}

export default MptRootRoute;
