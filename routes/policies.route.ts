import PoliciesController from '../controllers/policies.controller';
import BaseRoute from './base';

class PoliciesRoute extends BaseRoute {
    public path = '/policies';
    public policiesController = new PoliciesController();

    constructor() {
        super();
        this.initializeRoutes();
    }

    private initializeRoutes() {
        this.router.get(`${this.path}`, this.policiesController.index);
    }
}

export default PoliciesRoute;
