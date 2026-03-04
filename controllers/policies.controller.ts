import { HttpException } from '@koralabs/kora-labs-common';
import { NextFunction, Request, Response } from 'express';
import { IRegistry } from '../interfaces/registry.interface';
import { HandlesRepository } from '../repositories/handlesRepository';
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
                    res.status(404).json({ message: 'Handle policies not found' });
                    return;
                }
                throw error;
            }

            if (!policiesDatum) {
                res.status(404).json({ message: 'Handle policies not found' });
                return;
            }

            try {
                const policies = await decodePoliciesDatum(policiesDatum);
                res.status(handleRepo.currentHttpStatus()).json(policies);
                return;
            } catch {
                res.status(400).json({ message: 'Unable to decode handle policies datum to json' });
                return;
            }
        } catch (error) {
            next(error);
        }
    }
}

export default PoliciesController;
