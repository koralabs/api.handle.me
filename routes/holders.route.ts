import HoldersController from '../controllers/holders.controller';
import { allowQueryParams } from '../utils/queryParamGuard';
import BaseRoute from './base';

class HoldersRoute extends BaseRoute {
    public path = '/holders';
    public holdersController = new HoldersController();

    constructor() {
        super();
        this.initializeRoutes();
    }

    private initializeRoutes() {
        // `as any` casts: see handles.route.ts — Express overload inference
        // doesn't reconcile the controller methods' custom Request<...>
        // shapes when a middleware sits between path and handler.
        this.router.get(`${this.path}`, allowQueryParams('records_per_page', 'sort', 'page'), this.holdersController.getAll as any);
        this.router.get(`${this.path}/:address`, allowQueryParams(), this.holdersController.getHolderAddressDetails as any);
    }
}

export default HoldersRoute;
