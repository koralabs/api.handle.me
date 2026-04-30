import { IGetAllQueryParams, StoredHandle } from '@koralabs/kora-labs-common';
import { NextFunction, Request, Response } from 'express';
import { IRegistry } from '../interfaces/registry.interface';
import { HandleViewModel } from '../models/view/handle.view.model';
import { HandlesRepository } from '../repositories/handlesRepository';
import { wantsTextPlain } from '../utils/contentNegotiation';
import HandlesController from './handles.controller';

class RootHandlesController {
    public async index (req: Request<Request, {}, {}, IGetAllQueryParams>, res: Response, next: NextFunction): Promise<void> {
        try {
            const handleRepo: HandlesRepository = new HandlesRepository(new (req.app.get('registry') as IRegistry).handlesStore());
            const handleResults = HandlesController.parseQueryAndSearchHandles(req, handleRepo, handleRepo.getRootHandleNames());
            let handles = handleResults.handles as StoredHandle[];

            const mintingType = req.query?.minting_type
            if (mintingType) {
                handles = handles.filter(h => h.subhandle_settings?.virtual?.public_minting_enabled || h.subhandle_settings?.nft?.public_minting_enabled)
            }

            if (wantsTextPlain(req)) {
                const handleNames = handles.map(h => h.name);
                res.set('Content-Type', 'text/plain; charset=utf-8');
                const total = handleNames.length.toString();
                res.set('X-Total-Count', total);
                res.set('x-handles-search-total', total);
                res.status(handleRepo.currentHttpStatus()).send(handleNames.join('\n'));
                return;
            }

            const total = handleResults.searchTotal.toString();
            res.set('X-Total-Count', total);
            res.set('x-handles-search-total', total);
            res.status(handleRepo.currentHttpStatus())
                .json(handles.filter((handle: StoredHandle) => !!handle.utxo).map((handle: StoredHandle) => {
                    return {...new HandleViewModel(handle), subhandle_settings: handle.subhandle_settings}
                }));
        } catch (error) {
            next(error);
        }
    };
}

export default RootHandlesController;
