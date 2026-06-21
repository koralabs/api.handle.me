import { Router } from 'express';
import ScriptsController from '../controllers/scripts.controller';
import { allowQueryParams } from '../utils/queryParamGuard';
import BaseRoute from './base';

class ScriptsRoute extends BaseRoute {
    public path = '/scripts';
    public router = Router();
    public scriptsController = new ScriptsController();

    constructor() {
        super();
        this.initializeRoutes();
    }

    private initializeRoutes() {
        this.router.get(`${this.path}`, allowQueryParams('latest', 'type'), this.scriptsController.index as any);
    }
}

export default ScriptsRoute;
