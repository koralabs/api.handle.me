import { NextFunction, Request, Response } from 'express';

class HomeController {
    public async index (req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            res.redirect('/swagger');
        } catch (error) {
            next(error);
        }
    };
}

export default HomeController;
