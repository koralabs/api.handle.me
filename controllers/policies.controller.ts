import { HttpException } from '@koralabs/kora-labs-common';
import { NextFunction, Request, Response } from 'express';
import { IRegistry } from '../interfaces/registry.interface';
import { HandlesRepository } from '../repositories/handlesRepository';
import { ApiError } from '../utils/apiError';
import { decodePoliciesDatum, HANDLE_POLICIES_NAME } from '../utils/policies';

class PoliciesController {
    public async index(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const handleRepo = new HandlesRepository(new (req.app.get('registry') as IRegistry).handlesStore());
            let policiesDatum: string | null;

            try {
                policiesDatum = handleRepo.getHandleDatumByName(HANDLE_POLICIES_NAME);
            } catch (error) {
                if (error instanceof HttpException && error.status === 404) {
                    throw ApiError.policiesNotFound();
                }
                throw error;
            }

            if (!policiesDatum) {
                throw ApiError.policiesNotFound();
            }

            try {
                const policies = await decodePoliciesDatum(policiesDatum);
                res.status(handleRepo.currentHttpStatus()).json(policies);
                return;
            } catch {
                throw ApiError.policiesDecodeFailed();
            }
        } catch (error) {
            next(error);
        }
    }
}

export default PoliciesController;
