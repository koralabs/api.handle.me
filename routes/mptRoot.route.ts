import { Router } from 'express';
import MptRootController from '../controllers/mptRoot.controller';
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
        this.router.get(`${this.path}`, this.mptRootController.index);
        this.router.get(`${this.path}/proof`, this.mptRootController.proof);
    }
}

export default MptRootRoute;
