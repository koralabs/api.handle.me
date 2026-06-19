import {
    AvailabilityResponseCode,
    bech32FromHex,
    checkHandlePattern,
    HandlePaginationModel, HandleSearchModel,
    HandleType,
    IGetAllQueryParams, IGetHandleRequest,
    ISearchBody,
    isEmpty,
    isEmptyObject,
    parseAssetNameLabel,
    ProtectedWords,
    StoredHandle,
    UTxO
} from '@koralabs/kora-labs-common';
import { decodeCborToJson, DefaultTextFormat } from '@koralabs/kora-labs-common/utils/cbor';
import { NextFunction, Request, Response } from 'express';
import { isDatumEndpointEnabled } from '../config';
import { MAX_PAGINATED_RESULTS, MAX_TEXT_PLAIN_PAGINATED_RESULTS } from '../config/constants';
import { IRegistry } from '../interfaces/registry.interface';
import { HandleViewModel } from '../models/view/handle.view.model';
import { HandlesRepository } from '../repositories/handlesRepository';
import { ApiError, statusCodeToErrorCode } from '../utils/apiError';
import { wantsRawCbor, wantsTextPlain } from '../utils/contentNegotiation';

type HandleSearchQueryParams = IGetAllQueryParams & { root_handle?: string };

const setSearchTotal = (res: Response, total: number) => {
    const value = total.toString();
    res.set('X-Total-Count', value);
    res.set('x-handles-search-total', value);
};

class HandlesController {
    private static validateRecordsPerPage(recordsPerPage?: string, maxRecordsPerPage = MAX_PAGINATED_RESULTS): void {
        const count = Number(recordsPerPage);
        if (recordsPerPage && Number.isFinite(count) && count > maxRecordsPerPage) {
            throw ApiError.recordsPerPageTooLarge(maxRecordsPerPage);
        }
    }

    private static async getHandleFromRepo (req: Request<IGetHandleRequest, {}, {}>): Promise<{ code: number; handle: StoredHandle; }> {
        const handleName = req.params.handle;
        const handleRepo: HandlesRepository = new HandlesRepository(new (req.app.get('registry') as IRegistry).handlesStore());
        const asHex = req.query.hex == 'true';
        const handle: StoredHandle | null = asHex ? handleRepo.getHandleByHex(handleName) : handleRepo.getHandle(handleName);

        if (!handle) {
            const validHandle = checkHandlePattern(handleName, handleName.includes('@') ? handleName.split('@')[1] : undefined);
            if (!validHandle.valid) {
                // Invalid handle shape — treat as not found and point users at the handle FAQ
                // for the current rules rather than enumerating violations in the API surface.
                throw ApiError.handleNameInvalid();
            }
            const protectedWordsResult = await ProtectedWords.checkAvailability(handleName);

            if (!protectedWordsResult.available) {
                // Preserve the existing AvailabilityResponseCode → HTTP-status passthrough
                // (notably 451 for legally restricted names) — downstream consumers branch on it.
                const status = protectedWordsResult.code;
                const message = (status === AvailabilityResponseCode.NOT_AVAILABLE_FOR_LEGAL_REASONS
                    ? protectedWordsResult.reason
                    : protectedWordsResult.message) ?? 'Handle is not available';
                throw new ApiError(status, statusCodeToErrorCode(status), message);
            }
            throw ApiError.handleNotFound();
        }
        return { code: handleRepo.currentHttpStatus(), handle };
    }

    public static parseQueryAndSearchHandles(req: Request<Request, {}, {}, IGetAllQueryParams>, handleRepo: HandlesRepository, handles?: ISearchBody) {
        const { records_per_page, page, characters, length, rarity, numeric_modifiers, slot_number, search: searchQuery, holder_address, og, handle_type, sort, personalized, root_handle } = req.query as HandleSearchQueryParams;
        const namesOnly = wantsTextPlain(req);
        const maxRecordsPerPage = namesOnly ? MAX_TEXT_PLAIN_PAGINATED_RESULTS : MAX_PAGINATED_RESULTS;
        HandlesController.validateRecordsPerPage(records_per_page, maxRecordsPerPage);
        const effectiveRecordsPerPage = records_per_page ?? (namesOnly ? `${MAX_TEXT_PLAIN_PAGINATED_RESULTS}` : undefined);

        const search = new HandleSearchModel({
            characters,
            length,
            rarity,
            numeric_modifiers,
            search: searchQuery,
            holder_address,
            root_handle,
            personalized,
            handle_type,
            og,
            handles
        } as ConstructorParameters<typeof HandleSearchModel>[0] & { root_handle?: string });

        const recordsPerPageAsNumber = Number(effectiveRecordsPerPage);
        const bypassCommonLimitForTextResponses = namesOnly && Number.isFinite(recordsPerPageAsNumber) && recordsPerPageAsNumber > 1000;
        const pagination = new HandlePaginationModel({
            page,
            sort,
            handlesPerPage: bypassCommonLimitForTextResponses ? undefined : effectiveRecordsPerPage,
            slotNumber: slot_number
        });
        if (bypassCommonLimitForTextResponses) {
            pagination.handlesPerPage = recordsPerPageAsNumber;
        }

        return handleRepo.search(isEmptyObject(pagination) ? undefined : pagination, isEmptyObject(search) ? undefined : search, namesOnly);
    }

    public async getAll (req: Request<Request, {}, {}, IGetAllQueryParams>, res: Response, next: NextFunction): Promise<void> {
        try {
            const handleRepo: HandlesRepository = new HandlesRepository(new (req.app.get('registry') as IRegistry).handlesStore());

            const handles = HandlesController.parseQueryAndSearchHandles(req, handleRepo);

            if (wantsTextPlain(req)) {
                const handleNames = handles.handles as string[];
                res.set('Content-Type', 'text/plain; charset=utf-8');
                setSearchTotal(res, handles.searchTotal);
                res.status(handleRepo.currentHttpStatus()).send(handleNames.join('\n'));
                return;
            }

            setSearchTotal(res, handles.searchTotal);
            res.status(handleRepo.currentHttpStatus())
                .json((handles.handles as StoredHandle[]).filter((handle: StoredHandle) => !!handle.utxo).map((handle: StoredHandle) => new HandleViewModel(handle)));
        } catch (error) {
            next(error);
        }
    }

    private static validateStringListBody(body: unknown): string[] {
        if (isEmpty(body)) {
            return [];
        }
        if (!Array.isArray(body)) {
            throw ApiError.invalidListBody('expected array and received object');
        }
        const invalidEntry = body.find((handle) => typeof handle !== 'string');
        if (invalidEntry !== undefined) {
            throw ApiError.invalidListBody(`expected string entries and received ${Array.isArray(invalidEntry) ? 'array' : typeof invalidEntry}`);
        }
        return body;
    }

    private static async _searchFromList (req: Request<Request, {}, ISearchBody, IGetAllQueryParams>, res: Response, handles?: ISearchBody): Promise<void> {
        const handleRepo: HandlesRepository = new HandlesRepository(new (req.app.get('registry') as IRegistry).handlesStore());
        const handleSearchResults = HandlesController.parseQueryAndSearchHandles(req, handleRepo, handles)


        if (wantsTextPlain(req)) {
            const handles = handleSearchResults.handles;
            res.set('Content-Type', 'text/plain; charset=utf-8');
            setSearchTotal(res, handleSearchResults.searchTotal);
            res.status(handleRepo.currentHttpStatus()).send(handles.join('\n'));
            return;
        }

        const handlesViewModel = (handleSearchResults.handles as StoredHandle[]).filter((handle: StoredHandle) => !!handle.utxo).map((handle: StoredHandle) => new HandleViewModel(handle));

        setSearchTotal(res, handlesViewModel.length);
        res.status(handleRepo.currentHttpStatus()).json(handlesViewModel);
    }

    public async list (req: Request<Request, {}, ISearchBody, IGetAllQueryParams>, res: Response, next: NextFunction): Promise<void> {
        try {
            const handleRepo: HandlesRepository = new HandlesRepository(new (req.app.get('registry') as IRegistry).handlesStore());
            let handles = HandlesController.validateStringListBody(req.body);
            switch (req.query.type) {
                case 'bech32stake':
                case 'holder':
                    handles = handleRepo.getHandlesByHolderAddresses(handles)
                    break;
                case 'stakekeyhash':
                    handles = handleRepo.getHandlesByStakeKeyHashes(handles)
                    break;
                case 'assetname':
                    handles = handles.map(name => Buffer.from(parseAssetNameLabel(name) ? name.slice(8) : name, 'hex').toString('utf8'));
                    break;
                case 'handlehex':
                    handles = handles.map(hex => Buffer.from(hex, 'hex').toString('utf8'));
                    break;
                case 'paymentkeyhash':
                    handles = handleRepo.getHandlesByPaymentKeyHashes(handles)
                    break;
                case 'bech32address':
                    handles = await handleRepo.getHandlesByAddressesAsync(handles)
                    break;
                case 'hexaddress':
                    handles = await handleRepo.getHandlesByAddressesAsync(handles.map(hex => bech32FromHex(hex)))
                    break;
                default:
                    break;
            }
            await HandlesController._searchFromList(req, res, handles);
        } catch (error) {
            next(error);
        }
    }

    public async getHandle (req: Request<IGetHandleRequest, {}, {}>, res: Response, next: NextFunction): Promise<void> {
        try {
            const { code, handle } = await HandlesController.getHandleFromRepo(req);
            res.status(code).json(new HandleViewModel(handle));
        } catch (error) {
            next(error);
        }
    }

    public async getPersonalizedHandle(req: Request<IGetHandleRequest, {}, {}>, res: Response, next: NextFunction) {
        try {
            const handleRepo: HandlesRepository = new HandlesRepository(new (req.app.get('registry') as IRegistry).handlesStore());
            const { code, handle } = await HandlesController.getHandleFromRepo(req);

            const personalization = await handleRepo.getPersonalization(handle);
            res.status(code).json(personalization ?? {});
        } catch (error) {
            next(error);
        }
    }

    private static async buildHandleReferenceToken(req: Request<IGetHandleRequest, {}, {}>): Promise<{ reference_token?: UTxO; code: number }> {
        const { code, handle } = await HandlesController.getHandleFromRepo(req);

        if (handle.reference_utxo) {
            const handleRepo: HandlesRepository = new HandlesRepository(new (req.app.get('registry') as IRegistry).handlesStore());
            const refUtxo = handleRepo.getUTxO(handle.reference_utxo)
            if (refUtxo) {
                return { reference_token: new UTxO(refUtxo), code };
            }
        }

        return { code };
    }

    public async getPersonalizationUTxO(req: Request<IGetHandleRequest, {}, {}>, res: Response, next: NextFunction) {
        try {
            const { reference_token, code } = await HandlesController.buildHandleReferenceToken(req);

            res.status(code).json(reference_token ?? {});
        } catch (error) {
            next(error);
        }
    }

    public async getHandleUTxO(req: Request<IGetHandleRequest, {}, {}>, res: Response, next: NextFunction) {
        try {
            const { handle } = await HandlesController.getHandleFromRepo(req);

            const handleRepo: HandlesRepository = new HandlesRepository(new (req.app.get('registry') as IRegistry).handlesStore());

            const reference_script = handle.script?.cbor;

            let datum = handleRepo.getHandleDatumByName(handle.name);

            // The embedded `datum` field defaults to JSON-decoded (matching
            // the rest of the API's "default to JSON" content-negotiation rule).
            // Clients that want the raw on-chain CBOR-hex opt in via
            // `Accept: text/plain` (or `application/cbor` / `application/cbor-hex`).
            if (datum && !wantsRawCbor(req)) {
                try {
                    datum = await decodeCborToJson({ cborString: datum, schema: {}, defaultKeyType: req.query.default_key_type as DefaultTextFormat });
                } catch {
                    throw ApiError.datumDecodeFailed();
                }
            }

            res.status(handleRepo.currentHttpStatus()).json({
                tx_id: handle.utxo.split('#')[0],
                index: parseInt(handle.utxo.split('#')[1]),
                lovelace: handle.lovelace,
                address: handle.resolved_addresses.ada,
                datum,
                reference_script
            });
        } catch (error) {
            next(error);
        }
    }

    public async getHandleDatum(req: Request<IGetHandleRequest, {}, {}>, res: Response, next: NextFunction) {
        try {
            if (!isDatumEndpointEnabled()) {
                throw ApiError.datumEndpointDisabled();
            }
            const { handle } = await HandlesController.getHandleFromRepo(req);

            const handleRepo: HandlesRepository = new HandlesRepository(new (req.app.get('registry') as IRegistry).handlesStore());

            const handleDatum = handleRepo.getHandleDatumByName(handle.name);

            if (!handleDatum) {
                throw ApiError.datumNotFound();
            }

            // Default to JSON when Accept is missing or */* — match the API-wide default.
            const wantsRaw = wantsRawCbor(req);
            if (wantsRaw) {
                res.status(handleRepo.currentHttpStatus())
                    .contentType(`${wantsRaw}; charset=utf-8`)
                    .send(handleDatum);
                return;
            }

            try {
                const decodedDatum = await decodeCborToJson({ cborString: handleDatum, schema: {}, defaultKeyType: req.query.default_key_type as DefaultTextFormat });
                res.set('Content-Type', 'application/json');
                res.status(handleRepo.currentHttpStatus()).json(decodedDatum);
                return;
            } catch {
                throw ApiError.datumDecodeFailed();
            }
        } catch (error) {
            next(error);
        }
    }

    public async getHandleScript(req: Request<IGetHandleRequest, {}, {}>, res: Response, next: NextFunction) {
        try {
            const { code, handle } = await HandlesController.getHandleFromRepo(req);

            const script = handle.script;
            if (!script) {
                throw ApiError.scriptNotFound();
            }

            // Per content negotiation: text/plain or CBOR mime types get the raw CBOR hex string;
            // anything else (including */* and missing Accept) gets the JSON {cbor, type, hash}.
            const wantsRaw = wantsRawCbor(req);
            if (wantsRaw && script.cbor) {
                res.set('Content-Type', `${wantsRaw}; charset=utf-8`).status(code).send(script.cbor);
                return;
            }

            res.status(code).json(script);
        } catch (error) {
            next(error);
        }
    }

    public async getSubHandleSettings(req: Request<IGetHandleRequest, {}, {}>, res: Response, next: NextFunction) {
        try {
            const handleRepo: HandlesRepository = new HandlesRepository(new (req.app.get('registry') as IRegistry).handlesStore());
            const { handle, code } = await HandlesController.getHandleFromRepo(req);

            if (!handle.subhandle_settings || !handle.subhandle_settings.utxo_id) {
                throw ApiError.subhandleSettingsNotFound();
            }

            const utxo = handleRepo.getUTxO(handle.subhandle_settings.utxo_id);
            const wantsText = wantsTextPlain(req);

            if (wantsText) {
                if (!utxo?.datum) {
                    throw ApiError.subhandleSettingsNotFound();
                }
                res.set('Content-Type', 'text/plain; charset=utf-8').status(code).send(utxo.datum);
                return;
            }

            if (utxo) {
                // Match the API-wide content-negotiation rule applied by
                // getHandleUTxO / getHandleDatum: default response is
                // JSON-decoded datum, raw CBOR is opt-in via Accept header.
                // Embedding raw CBOR inside a JSON envelope (the prior
                // behaviour) forced clients to second-guess the format.
                let decodedDatum = utxo.datum;
                if (decodedDatum) {
                    try {
                        decodedDatum = await decodeCborToJson({ cborString: decodedDatum, schema: {}, defaultKeyType: req.query.default_key_type as DefaultTextFormat });
                    } catch {
                        throw ApiError.datumDecodeFailed();
                    }
                }
                handle.subhandle_settings.utxo = new UTxO({ ...utxo, datum: decodedDatum });
            }

            res.status(code).json(handle.subhandle_settings);
        } catch (error) {
            next(error);
        }
    }

    public async getSubHandleSettingsUTxO(req: Request<IGetHandleRequest, {}, {}>, res: Response, next: NextFunction) {
        try {
            const { code, handle } = await HandlesController.getHandleFromRepo(req);

            if (!handle.subhandle_settings?.utxo_id) {
                throw ApiError.subhandleSettingsNotFound();
            }

            const handleRepo: HandlesRepository = new HandlesRepository(new (req.app.get('registry') as IRegistry).handlesStore());
            const utxo = handleRepo.getUTxO(handle.subhandle_settings.utxo_id);
            if (!utxo) {
                throw ApiError.subhandleSettingsUtxoNotFound();
            }

            // Default to JSON-decoded datum to match getHandleUTxO; raw CBOR
            // is opt-in via Accept: text/plain (or application/cbor). Same
            // content-negotiation contract the rest of the API uses.
            let decodedDatum = utxo.datum;
            if (decodedDatum && !wantsRawCbor(req)) {
                try {
                    decodedDatum = await decodeCborToJson({ cborString: decodedDatum, schema: {}, defaultKeyType: req.query.default_key_type as DefaultTextFormat });
                } catch {
                    throw ApiError.datumDecodeFailed();
                }
            }
            handle.subhandle_settings.utxo = new UTxO({ ...utxo, datum: decodedDatum });

            res.status(code).json(handle.subhandle_settings.utxo);
        } catch (error) {
            next(error);
        }
    }

    public async getSubHandles(req: Request<IGetHandleRequest, {}, {}>, res: Response, next: NextFunction) {
        try {
            const { code, handle } = await HandlesController.getHandleFromRepo(req);

            const handleRepo: HandlesRepository = new HandlesRepository(new (req.app.get('registry') as IRegistry).handlesStore());
            let subHandles = handleRepo.getSubHandlesByRootHandle(handle.name);

            if (req.query.type) {
                const type = req.query.type === 'virtual' ? HandleType.VIRTUAL_SUBHANDLE : HandleType.NFT_SUBHANDLE;
                subHandles = subHandles.filter((subHandle) => subHandle.handle_type === type);
            }

            res.status(code).json(subHandles);
        } catch (error) {
            next(error);
        }
    }
}

export default HandlesController;
