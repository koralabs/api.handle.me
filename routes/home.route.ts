import { Router } from 'express';
import HomeController from '../controllers/home.controller';
import BaseRoute from './base';

class IndexRoute extends BaseRoute {
    public path = '/';
    public router = Router();
    public homeController = new HomeController();

    constructor() {
        super();
        this.initializeRoutes();
    }

    private initializeRoutes() {
        this.router.get(`${this.path}`, this.homeController.index);
        // Conventional spec aliases — agents probe these paths first.
        this.router.get('/openapi.json', this.homeController.openapiJson);
        this.router.get('/swagger.json', this.homeController.swaggerJson);
        // Well-known paths.
        this.router.get('/.well-known/api-catalog', this.homeController.apiCatalog);
        this.router.get('/.well-known/security.txt', this.homeController.securityTxt);
    }
}

export default IndexRoute;
