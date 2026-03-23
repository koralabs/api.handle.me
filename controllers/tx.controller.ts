import { NextFunction, Request, Response } from 'express';
import {
    evaluateTransactionViaOgmios,
    TxEvaluationRequestError,
    validateEvaluateTxRequest
} from '../services/txEvaluation.service';

class TxController {
    public evaluate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const request = validateEvaluateTxRequest(req.body);
            const result = await evaluateTransactionViaOgmios(request);
            res.status(200).json(result);
        } catch (error) {
            if (error instanceof TxEvaluationRequestError) {
                res.status(400).json([
                    {
                        message: error.message,
                        raw: {
                            type: error.name
                        }
                    }
                ]);
                return;
            }

            if (error instanceof Error && Array.isArray((error as Error & { body?: unknown }).body)) {
                res.status((error as Error & { status?: number }).status ?? 400).json(
                    (error as Error & { body: unknown[] }).body
                );
                return;
            }

            next(error);
        }
    };
}

export default TxController;

