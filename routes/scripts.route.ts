import { Router } from 'express';
import ScriptsController from '../controllers/scripts.controller';
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
        this.router.get(`${this.path}`, this.scriptsController.index);
    }
}

export default ScriptsRoute;
