import { Router } from 'express';
import TxController from '../controllers/tx.controller';
import BaseRoute from './base';

class TxRoute extends BaseRoute {
    public path = '/tx';
    public router = Router();
    public txController = new TxController();

    constructor() {
        super();
        this.initializeRoutes();
    }

    private initializeRoutes() {
        this.router.post(`${this.path}/evaluate`, this.txController.evaluate);
    }
}

export default TxRoute;
