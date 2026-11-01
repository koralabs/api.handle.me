import MarketplaceController from '../controllers/marketplace.controller';
import { allowQueryParams } from '../utils/queryParamGuard';
import BaseRoute from './base';

class MarketplaceRoute extends BaseRoute {
    public path = '/marketplace';
    public marketplaceController = new MarketplaceController();

    constructor() {
        super();
        this.router.get(`${this.path}/listings`, allowQueryParams('holder_address', 'search'), this.marketplaceController.getListings);
    }
}

export default MarketplaceRoute;
