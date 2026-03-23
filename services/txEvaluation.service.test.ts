import { createInteractionContext, createTransactionSubmissionClient } from '@cardano-ogmios/client';
import {
    evaluateTx,
    mapEvaluationFailureToContractResponses
} from './txEvaluation.service';

jest.mock('@cardano-ogmios/client', () => ({
    createInteractionContext: jest.fn(),
    createTransactionSubmissionClient: jest.fn()
}));

const mockedCreateInteractionContext = createInteractionContext as jest.MockedFunction<typeof createInteractionContext>;
const mockedCreateTransactionSubmissionClient = createTransactionSubmissionClient as jest.MockedFunction<
    typeof createTransactionSubmissionClient
>;

describe('txEvaluation.service', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        mockedCreateInteractionContext.mockResolvedValue({} as any);
    });

    it('maps Ogmios budgets into Mesh-compatible action budgets', async () => {
        const shutdown = jest.fn().mockResolvedValue(undefined);
        mockedCreateTransactionSubmissionClient.mockResolvedValue({
            evaluateTransaction: jest.fn().mockResolvedValue([
                {
                    validator: { purpose: 'spend', index: 0 },
                    budget: { memory: 123, cpu: 456 }
                },
                {
                    validator: { purpose: 'mint', index: 1 },
                    budget: { memory: 789, cpu: 321 }
                }
            ]),
            shutdown
        } as any);

        const result = await evaluateTx({
            txCbor: 'deadbeef',
            additionalUtxos: [
                {
                    txHash: 'a'.repeat(64),
                    outputIndex: 0,
                    address: 'addr_test1vr0',
                    amount: [
                        { unit: 'lovelace', quantity: '5000000' },
                        { unit: `${'b'.repeat(56)}abcd`, quantity: '1' }
                    ]
                }
            ]
        });

        expect(result).toEqual([
            { tag: 'SPEND', index: 0, budget: { mem: 123, steps: 456 } },
            { tag: 'MINT', index: 1, budget: { mem: 789, steps: 321 } }
        ]);
        expect(mockedCreateTransactionSubmissionClient).toHaveBeenCalled();
        expect(shutdown).toHaveBeenCalled();
    });

    it('maps script execution failures into contract responses', () => {
        expect(
            mapEvaluationFailureToContractResponses({
                code: 3010,
                message: 'Script execution failed',
                data: [
                    {
                        validator: { purpose: 'spend', index: 0 },
                        error: {
                            code: 3012,
                            message: 'Validation failed',
                            data: {
                                validationError: 'missing signature',
                                traces: ['trace one', 'trace two']
                            }
                        }
                    }
                ]
            })
        ).toEqual([
            {
                tag: 'SPEND',
                index: 0,
                message: 'missing signature (trace one | trace two)',
                raw: {
                    validator: { purpose: 'spend', index: 0 },
                    error: {
                        code: 3012,
                        message: 'Validation failed',
                        data: {
                            validationError: 'missing signature',
                            traces: ['trace one', 'trace two']
                        }
                    }
                }
            }
        ]);
    });
});
