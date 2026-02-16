import { Router } from 'express';
import RootHandlesController from '../controllers/rootHandles.controller';
import BaseRoute from './base';

class RootHandlesRoute extends BaseRoute {
    public path = '/root-handles';
    public router = Router();
    public rootHandlesController = new RootHandlesController();

    constructor() {
        super();
        this.initializeRoutes();
    }

    private initializeRoutes() {
        this.router.get(`${this.path}`, this.rootHandlesController.index);
    }
}

export default RootHandlesRoute;