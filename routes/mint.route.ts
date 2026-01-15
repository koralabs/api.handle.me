import MintController from '../controllers/mint.controller';
import BaseRoute from './base';

/*********************************************
 * Used by api.handle.me for SubHandle mints
 * Not intended to work elsewhere
 *********************************************/
class MintRoute extends BaseRoute {
    public path = '/mint';
    public mintController = new MintController();

    constructor() {
        super();
        this.initializeRoutes();
    }

    private initializeRoutes() {
        this.router.post(this.path, this.mintController.mint);
    }
}

export default MintRoute;
