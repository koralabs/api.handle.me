import { Router } from 'express';
import DatumController from '../controllers/datum.controller';
import { allowQueryParams } from '../utils/queryParamGuard';
import BaseRoute from './base';

class DatumRoute extends BaseRoute {
    public path = '/datum';
    public router = Router();
    public datumController = new DatumController();

    constructor() {
        super();
        this.initializeRoutes();
    }

    private initializeRoutes() {
        this.router.post(
            `${this.path}`,
            allowQueryParams('from', 'to', 'numeric_keys', 'chunk_size', 'indefinite_arrays', 'default_to_text', 'default_key_type'),
            this.datumController.index as any
        );
    }
}

export default DatumRoute;
