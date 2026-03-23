import request from 'supertest';
import App from '../app';
import * as txEvaluationService from '../services/txEvaluation.service';

jest.mock('../services/ogmios/ogmios.service');
jest.mock('../services/txEvaluation.service');
jest.mock('../repositories/handlesRepository', () => ({
    HandlesRepository: jest.fn().mockImplementation(() => ({
        initialize: jest.fn().mockResolvedValue(undefined)
    }))
}));

describe('Tx Routes Test', () => {
    let app: App | null;

    beforeEach(async () => {
        jest.clearAllMocks();
        app = await new App().initialize();
    });

    it('returns Mesh-compatible budgets for POST /tx/evaluate', async () => {
        jest.spyOn(txEvaluationService, 'evaluateTx').mockResolvedValue([
            { tag: 'SPEND', index: 0, budget: { mem: 11, steps: 22 } }
        ]);

        const response = await request(app?.getServer()).post('/tx/evaluate').send({ txCbor: 'deadbeef' });

        expect(response.status).toBe(200);
        expect(response.body).toEqual([{ tag: 'SPEND', index: 0, budget: { mem: 11, steps: 22 } }]);
    });

    it('surfaces evaluation failures as contract response arrays', async () => {
        jest.spyOn(txEvaluationService, 'evaluateTx').mockRejectedValue(new Error('opaque'));
        jest.spyOn(txEvaluationService, 'mapEvaluationFailureToContractResponses').mockReturnValue([
            { tag: 'SPEND', index: 0, message: 'validator denied', raw: { reason: 'denied' } }
        ]);

        const response = await request(app?.getServer()).post('/tx/evaluate').send({ txCbor: 'deadbeef' });

        expect(response.status).toBe(400);
        expect(response.body).toEqual([{ tag: 'SPEND', index: 0, message: 'validator denied', raw: { reason: 'denied' } }]);
    });

    it('rejects missing txCbor', async () => {
        const response = await request(app?.getServer()).post('/tx/evaluate').send({});

        expect(response.status).toBe(400);
        expect(response.body).toEqual([{ message: 'txCbor is required', raw: {} }]);
    });
});
