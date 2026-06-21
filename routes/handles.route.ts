import HandlesController from '../controllers/handles.controller';
import deprecated from '../utils/deprecated';
import { allowQueryParams } from '../utils/queryParamGuard';
import BaseRoute from './base';

// SEARCH_PARAMS mirrors the destructuring in
// HandlesController.parseQueryAndSearchHandles. Keep them in sync — adding
// a filter on the controller requires adding it here, or callers will get
// a 400 unknown_query_params for the new key.
const SEARCH_PARAMS = [
    'records_per_page',
    'page',
    'characters',
    'length',
    'rarity',
    'numeric_modifiers',
    'slot_number',
    'search',
    'holder_address',
    'og',
    'handle_type',
    'sort',
    'personalized',
    'root_handle'
] as const;

// `hex` toggles asset-name lookups in HandlesController.getHandleFromRepo,
// so every per-handle route accepts it. Datum/UTXO/subhandle-settings
// endpoints additionally accept `default_key_type` for CBOR decoding.
const PER_HANDLE = ['hex'] as const;
const PER_HANDLE_WITH_DATUM = [...PER_HANDLE, 'default_key_type'] as const;

// Controller methods declare custom `Request<...>` shapes (e.g.
// `Request<IGetHandleRequest, ...>`). Inserting any middleware before the
// handler defeats Express's overload inference and TS falls back to a
// generic RequestHandler signature that won't unify with the custom shape.
// Cast `as any` to match the project convention already used with the
// deprecated() middleware below.

class HandlesRoute extends BaseRoute {
    public path = '/handles';
    public handlesController = new HandlesController();

    constructor() {
        super();
        this.initializeRoutes();
    }

    private initializeRoutes() {
        this.router.get(`${this.path}`, allowQueryParams(...SEARCH_PARAMS), this.handlesController.getAll as any);
        this.router.post(`${this.path}/list`, allowQueryParams(...SEARCH_PARAMS, 'type'), this.handlesController.list as any);
        this.router.get(`${this.path}/:handle`, allowQueryParams(...PER_HANDLE), this.handlesController.getHandle as any);
        this.router.get(`${this.path}/:handle/utxo`, allowQueryParams(...PER_HANDLE_WITH_DATUM), this.handlesController.getHandleUTxO as any);
        this.router.get(`${this.path}/:handle/personalized`, allowQueryParams(...PER_HANDLE), this.handlesController.getPersonalizedHandle as any);
        this.router.get(`${this.path}/:handle/personalized/utxo`, allowQueryParams(...PER_HANDLE), this.handlesController.getPersonalizationUTxO as any);
        this.router.get(`${this.path}/:handle/subhandle-settings`, allowQueryParams(...PER_HANDLE_WITH_DATUM), this.handlesController.getSubHandleSettings as any);
        this.router.get(`${this.path}/:handle/subhandle-settings/utxo`, allowQueryParams(...PER_HANDLE_WITH_DATUM), this.handlesController.getSubHandleSettingsUTxO as any);
        this.router.get(`${this.path}/:handle/subhandles`, allowQueryParams(...PER_HANDLE, 'type'), this.handlesController.getSubHandles as any);

        // *** OBSOLETE ** //
        // DON'T USE UNDERSCORES IN REST PATHS. ONLY IN QUERY PARAMS & FIELDS
        // Runtime Deprecation + Link rel=successor-version per RFC 9745 / RFC 8288.
        this.router.get(
            `${this.path}/:handle/subhandle_settings`,
            allowQueryParams(...PER_HANDLE_WITH_DATUM),
            deprecated((req) => `/handles/${req.params.handle}/subhandle-settings`),
            this.handlesController.getSubHandleSettings as any
        );
        this.router.get(
            `${this.path}/:handle/subhandle_settings/utxo`,
            allowQueryParams(...PER_HANDLE_WITH_DATUM),
            deprecated((req) => `/handles/${req.params.handle}/subhandle-settings/utxo`),
            this.handlesController.getSubHandleSettingsUTxO as any
        );
        this.router.get(
            `${this.path}/:handle/reference_token`,
            allowQueryParams(...PER_HANDLE),
            deprecated((req) => `/handles/${req.params.handle}/personalized/utxo`),
            this.handlesController.getPersonalizationUTxO as any
        );
        this.router.get(
            `${this.path}/:handle/datum`,
            allowQueryParams(...PER_HANDLE_WITH_DATUM),
            deprecated((req) => `/handles/${req.params.handle}/utxo`),
            this.handlesController.getHandleDatum as any
        );
        this.router.get(
            `${this.path}/:handle/script`,
            allowQueryParams(...PER_HANDLE),
            deprecated((req) => `/handles/${req.params.handle}/utxo`),
            this.handlesController.getHandleScript as any
        );
    }
}

export default HandlesRoute;
