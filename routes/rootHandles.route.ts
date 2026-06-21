import { Router } from 'express';
import RootHandlesController from '../controllers/rootHandles.controller';
import { allowQueryParams } from '../utils/queryParamGuard';
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
        // Accepts the full HandlesController.parseQueryAndSearchHandles set plus
        // `minting_type` (RootHandlesController.index further filters by it).
        this.router.get(
            `${this.path}`,
            allowQueryParams(
                'records_per_page', 'page', 'characters', 'length', 'rarity',
                'numeric_modifiers', 'slot_number', 'search', 'holder_address',
                'og', 'handle_type', 'sort', 'personalized', 'root_handle',
                'minting_type'
            ),
            this.rootHandlesController.index as any
        );
    }
}

export default RootHandlesRoute;