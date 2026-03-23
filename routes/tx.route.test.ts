import request from 'supertest';
import App from '../app';

const createInteractionContext = jest.fn();
const createTransactionSubmissionClient = jest.fn();

jest.mock('@cardano-ogmios/client', () => ({
    JSONRPCError: class JSONRPCError extends Error {
        code: number;
        data?: unknown;

        constructor(code: number, message: string, data?: unknown) {
            super(message);
            this.code = code;
            this.data = data;
        }
    },
    createInteractionContext: (...args: unknown[]) => createInteractionContext(...args),
    createTransactionSubmissionClient: (...args: unknown[]) => createTransactionSubmissionClient(...args)
}));

jest.mock('../services/ogmios/ogmios.service');
jest.mock('../ioc/main.registry', () => ({
    ['handlesRepo']: jest.fn().mockReturnValue({
        getHandle: () => null,
        getAll: () => [],
        getAllHandleNames: () => [],
        getHandleStats: () => ({
            percentage_complete: '',
            current_memory_used: 0,
            memory_size: 0,
            ogmios_elapsed: '',
            building_elapsed: '',
            slot_date: new Date(),
            handle_count: 0,
            current_slot: 0,
            current_block_hash: '',
            schema_version: 1
        })
    }),
    ['apiKeysRepo']: jest.fn().mockReturnValue({
        get: () => true
    })
}));

afterAll(async () => {
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 500));
});

describe('Tx Routes Test', () => {
    let app: App | null;

    beforeEach(async () => {
        createInteractionContext.mockResolvedValue({ socket: {} });
        createTransactionSubmissionClient.mockResolvedValue({
            evaluateTransaction: jest.fn(),
            shutdown: jest.fn().mockResolvedValue(undefined)
        });
        app = await new App().initialize();
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('[POST] /tx/evaluate', () => {
        it('returns Mesh-compatible budgets from Ogmios evaluation results', async () => {
            const evaluateTransaction = jest.fn().mockResolvedValue([
                {
                    validator: {
                        purpose: 'spend',
                        index: 0
                    },
                    budget: {
                        memory: 11,
                        cpu: 22
                    }
                }
            ]);
            const shutdown = jest.fn().mockResolvedValue(undefined);
            createTransactionSubmissionClient.mockResolvedValue({
                evaluateTransaction,
                shutdown
            });

            const response = await request(app?.getServer())
                .post('/tx/evaluate')
                .set('Content-Type', 'application/json')
                .send({
                    txCbor: 'deadbeef',
                    additionalUtxos: [
                        {
                            txHash: 'a'.repeat(64),
                            outputIndex: 1,
                            address: 'addr_test1vr0',
                            amount: [
                                { unit: 'lovelace', quantity: '123' },
                                {
                                    unit: `${'b'.repeat(56)}746f6b656e`,
                                    quantity: '2'
                                }
                            ]
                        }
                    ]
                });

            expect(response.status).toEqual(200);
            expect(response.body).toEqual([
                {
                    tag: 'SPEND',
                    index: 0,
                    budget: {
                        mem: 11,
                        steps: 22
                    }
                }
            ]);
            expect(evaluateTransaction).toHaveBeenCalledWith('deadbeef', [
                {
                    transaction: {
                        id: 'a'.repeat(64)
                    },
                    index: 1,
                    address: 'addr_test1vr0',
                    value: {
                        ada: {
                            lovelace: 123n
                        },
                        [String('b'.repeat(56))]: {
                            '746f6b656e': 2n
                        }
                    }
                }
            ]);
            expect(shutdown).toHaveBeenCalledTimes(1);
        });

        it('returns validation failures from Ogmios as 400 arrays', async () => {
            const evaluateTransaction = jest.fn().mockRejectedValue({
                jsonrpc: '2.0',
                method: 'evaluateTransaction',
                error: {
                    code: 3010,
                    message: 'Script execution failure',
                    data: [
                        {
                            validator: {
                                purpose: 'spend',
                                index: 0
                            },
                            error: {
                                code: 3012,
                                message: 'Validation failure',
                                data: {
                                    validationError: 'validator denied',
                                    traces: ['trace 1']
                                }
                            }
                        }
                    ]
                }
            });
            createTransactionSubmissionClient.mockResolvedValue({
                evaluateTransaction,
                shutdown: jest.fn().mockResolvedValue(undefined)
            });

            const response = await request(app?.getServer())
                .post('/tx/evaluate')
                .set('Content-Type', 'application/json')
                .send({
                    txCbor: 'deadbeef'
                });

            expect(response.status).toEqual(400);
            expect(response.body).toEqual([
                expect.objectContaining({
                    message: 'validator denied'
                })
            ]);
        });

        it('rejects requests without txCbor', async () => {
            const response = await request(app?.getServer())
                .post('/tx/evaluate')
                .set('Content-Type', 'application/json')
                .send({
                    additionalUtxos: []
                });

            expect(response.status).toEqual(400);
            expect(response.body).toEqual([
                {
                    message: 'txCbor is required',
                    raw: {
                        type: 'TxEvaluationRequestError'
                    }
                }
            ]);
        });
    });
});

