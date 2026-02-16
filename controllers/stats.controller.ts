import { NextFunction, Request, Response } from 'express';
import { IRegistry } from '../interfaces/registry.interface';
import { HandlesRepository } from '../repositories/handlesRepository';

class StatsController {
    public async index (req: Request<Request>, res: Response, next: NextFunction): Promise<void> {
        try {
            const handleRepo: HandlesRepository = new HandlesRepository(new (req.app.get('registry') as IRegistry).handlesStore());
            const metrics = handleRepo.getMetrics();
            const stats = {
                total_handles: metrics.handleCount ?? 0,
                total_holders: metrics.holderCount ?? 0
            }
            res.status(handleRepo.currentHttpStatus()).json(stats);
        } catch (error) {
            next(error);
        }
    };
}

export default StatsController;
