import { HandlesRepository } from '../repositories/handlesRepository';
import { RedisHandlesStore } from '../stores/redis';

const { lambdaHandler } = require('./reindex');

describe('Reindex lambda e2e', () => {
    const store = new RedisHandlesStore();
    const repo = new HandlesRepository(store);

    beforeAll(async () => {
        await repo.initialize();
    });

    afterAll(() => {
        repo.destroy();
    });

    beforeEach(() => {
        repo.rollBackToGenesis();
        repo.setMetrics({
            currentSlot: 100,
            lastSlot: 100,
            currentBlockHash: 'test_hash',
            tipBlockHash: 'test_hash',
            handleCount: 0,
            lockLambdas: false,
            indexSchemaVersion: 1,
            firstSlot: 1,
            startTimestamp: Date.now()
        });
    });

    it('returns early without making changes when lambdas are locked', async () => {
        repo.setMetrics({ lockLambdas: true });
        const initialMetrics = repo.getMetrics();

        await lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context);

        const finalMetrics = repo.getMetrics();
        expect(finalMetrics.lockLambdas).toBe(true);
        expect(finalMetrics.indexSchemaVersion).toEqual(initialMetrics.indexSchemaVersion);
    });

    it('successfully reindexes and completes without lock', async () => {
        const initialMetrics = repo.getMetrics();
        expect(initialMetrics.lockLambdas).toBe(false);

        await lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context);

        const finalMetrics = repo.getMetrics();
        expect(finalMetrics.lockLambdas).toBe(false);
        // indexSchemaVersion should be set after reindexing (could be string from Redis)
        expect(finalMetrics.indexSchemaVersion).toBeDefined();
    });

    it('repopulates empty index without errors', async () => {
        expect(repo.getMetrics().handleCount).toBe(0);

        const result = await lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context);

        expect(result).toBeUndefined();
        expect(repo.getMetrics().lockLambdas).toBe(false);
    });

    it('does not throw an error during reindexing', async () => {
        await expect(lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context)).resolves.toBeUndefined();
    });

    it('unlocks lambdas when repopulation fails', async () => {
        const repopulateSpy = jest.spyOn(RedisHandlesStore.prototype, 'repopulateIndexesFromUTxOs').mockImplementation(() => {
            throw new Error('forced failure');
        });

        await expect(lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context)).rejects.toThrow('forced failure');

        expect(repo.getMetrics().lockLambdas).toBe(false);
        repopulateSpy.mockRestore();
    });
});
