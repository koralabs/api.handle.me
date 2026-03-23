import { NextFunction, Request, Response } from 'express';
import { evaluateTx, mapEvaluationFailureToContractResponses } from '../services/txEvaluation.service';

class TxController {
    public evaluate = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const { txCbor, additionalUtxos = [] } = req.body ?? {};
            if (typeof txCbor !== 'string' || txCbor.trim() === '') {
                res.status(400).json([
                    {
                        message: 'txCbor is required',
                        raw: req.body ?? null
                    }
                ]);
                return;
            }

            const evaluated = await evaluateTx({
                txCbor,
                additionalUtxos: Array.isArray(additionalUtxos) ? additionalUtxos : []
            });
            res.json(evaluated);
        } catch (error) {
            const responses = mapEvaluationFailureToContractResponses(error);
            res.status(400).json(responses);
        }
    };
}

export default TxController;
