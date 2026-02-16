import HoldersController from '../controllers/holders.controller';
import BaseRoute from './base';

class HoldersRoute extends BaseRoute {
    public path = '/holders';
    public holdersController = new HoldersController();

    constructor() {
        super();
        this.initializeRoutes();
    }

    private initializeRoutes() {
        this.router.get(`${this.path}`, this.holdersController.getAll);
        this.router.get(`${this.path}/:address`, this.holdersController.getHolderAddressDetails);
    }
}

export default HoldersRoute;
