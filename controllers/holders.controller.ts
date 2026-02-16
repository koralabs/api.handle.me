import { HolderPaginationModel, HttpException, IGetAllHoldersQueryParams, IGetHolderAddressDetailsRequest } from '@koralabs/kora-labs-common';
import { NextFunction, Request, Response } from 'express';
import { MAX_PAGINATED_RESULTS } from '../config/constants';
import { IRegistry } from '../interfaces/registry.interface';
import { HandlesRepository } from '../repositories/handlesRepository';

class HoldersController {
    public  async getAll(req: Request<Request, {}, {}, IGetAllHoldersQueryParams>, res: Response, next: NextFunction): Promise<void> {
        try {
            const { records_per_page, sort, page } = req.query;
            const count = Number(records_per_page);
            if (records_per_page && Number.isFinite(count) && count > MAX_PAGINATED_RESULTS) {
                throw new HttpException(400, `'records_per_page' must be ${MAX_PAGINATED_RESULTS} or less`);
            }
            const pagination = new HolderPaginationModel({ page, sort, recordsPerPage: records_per_page });
            const handleRepo: HandlesRepository = new HandlesRepository(new (req.app.get('registry') as IRegistry).handlesStore());
            const holders = handleRepo.getAllHolders({ pagination }).map(({ handles: _handles, ...holder }) => holder);
            res.status(handleRepo.currentHttpStatus()).json(holders);
        } catch (error) {
            next(error);
        }
    }

    public async getHolderAddressDetails(req: Request<IGetHolderAddressDetailsRequest, {}, {}>, res: Response, next: NextFunction) {
        try {
            const holderAddress = req.params.address;
            const handleRepo: HandlesRepository = new HandlesRepository(new (req.app.get('registry') as IRegistry).handlesStore());
            const details = handleRepo.getHolder(holderAddress);
            if (!details) {
                throw new HttpException(404, 'Not found');
            }
            else {
                res.status(handleRepo.currentHttpStatus()).json(details);
            }
        } catch (error) {
            next(error);
        }
    }
}

export default HoldersController;
