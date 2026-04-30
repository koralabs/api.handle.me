import HandlesController from '../controllers/handles.controller';
import deprecated from '../utils/deprecated';
import BaseRoute from './base';

class HandlesRoute extends BaseRoute {
    public path = '/handles';
    public handlesController = new HandlesController();

    constructor() {
        super();
        this.initializeRoutes();
    }

    private initializeRoutes() {
        this.router.get(`${this.path}`, this.handlesController.getAll);
        this.router.post(`${this.path}/list`, this.handlesController.list);
        this.router.get(`${this.path}/:handle`, this.handlesController.getHandle);
        this.router.get(`${this.path}/:handle/utxo`, this.handlesController.getHandleUTxO);
        this.router.get(`${this.path}/:handle/personalized`, this.handlesController.getPersonalizedHandle);
        this.router.get(`${this.path}/:handle/personalized/utxo`, this.handlesController.getPersonalizationUTxO);
        this.router.get(`${this.path}/:handle/subhandle-settings`, this.handlesController.getSubHandleSettings);
        this.router.get(`${this.path}/:handle/subhandle-settings/utxo`, this.handlesController.getSubHandleSettingsUTxO);
        this.router.get(`${this.path}/:handle/subhandles`, this.handlesController.getSubHandles);

        // *** OBSOLETE ** //
        // DON'T USE UNDERSCORES IN REST PATHS. ONLY IN QUERY PARAMS & FIELDS
        // Runtime Deprecation + Link rel=successor-version per RFC 9745 / RFC 8288.
        // Casts to `any` because Express's overloaded `.get()` signature can't
        // narrow the controller method's `Request<IGetHandleRequest, …>` shape
        // through the prefixed deprecation middleware.
        this.router.get(
            `${this.path}/:handle/subhandle_settings`,
            deprecated((req) => `/handles/${req.params.handle}/subhandle-settings`),
            this.handlesController.getSubHandleSettings as any
        );
        this.router.get(
            `${this.path}/:handle/subhandle_settings/utxo`,
            deprecated((req) => `/handles/${req.params.handle}/subhandle-settings/utxo`),
            this.handlesController.getSubHandleSettingsUTxO as any
        );
        this.router.get(
            `${this.path}/:handle/reference_token`,
            deprecated((req) => `/handles/${req.params.handle}/personalized/utxo`),
            this.handlesController.getPersonalizationUTxO as any
        );
        this.router.get(
            `${this.path}/:handle/datum`,
            deprecated((req) => `/handles/${req.params.handle}/utxo`),
            this.handlesController.getHandleDatum as any
        );
        this.router.get(
            `${this.path}/:handle/script`,
            deprecated((req) => `/handles/${req.params.handle}/utxo`),
            this.handlesController.getHandleScript as any
        );
    }
}

export default HandlesRoute;
