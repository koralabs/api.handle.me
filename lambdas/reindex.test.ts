import { LogCategory, Logger, UTxOFunctionName } from '@koralabs/kora-labs-common';
import { HandlesRepository } from '../repositories/handlesRepository';
import { RedisHandlesStore } from '../stores/redis';

jest.mock('@koralabs/kora-labs-common');
jest.mock('../stores/redis');
jest.mock('../repositories/handlesRepository');

const MockedStoreClass = RedisHandlesStore as unknown as jest.Mock;
const MockedRepoClass = HandlesRepository as unknown as jest.Mock;
const mockedLogger = Logger as jest.Mocked<typeof Logger>;

const loadReindexModule = () => {
    let reindexModule: any;
    jest.isolateModules(() => {
        reindexModule = require('./reindex');
    });
    return reindexModule;
};

const setup = () => {
    const store = {
        getIndexSchemaVersion: jest.fn().mockReturnValue(1),
        repopulateIndexesFromUTxOs: jest.fn()
    };

    const handlesRepo = {
        getMetrics: jest.fn(),
        setMetrics: jest.fn(),
        addUTxO: jest.fn(),
        updateHandleIndexes: jest.fn()
    };

    MockedStoreClass.mockImplementation(() => store);
    MockedRepoClass.mockImplementation(() => handlesRepo);

    return {
        handlesRepo,
        reindexModule: loadReindexModule(),
        store
    };
};

describe('Reindex lambda unit tests', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('exports lambdaHandler', () => {
        const { reindexModule } = setup();
        expect(typeof reindexModule.lambdaHandler).toBe('function');
    });

    it('returns early when lambdas are locked', async () => {
        const { handlesRepo, reindexModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ lockLambdas: true });

        const result = await reindexModule.lambdaHandler({} as any, {} as any);

        expect(result).toBeUndefined();
        expect(mockedLogger.log).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining('Lambdas are currently locked'),
                category: LogCategory.WARN,
                event: 'reindexLambda.locked'
            })
        );
        expect(handlesRepo.setMetrics).not.toHaveBeenCalled();
    });

    it('locks lambdas before reindexing', async () => {
        const { handlesRepo, reindexModule } = setup();
        handlesRepo.getMetrics.mockReturnValue({ lockLambdas: false });

        await reindexModule.lambdaHandler({} as any, {} as any);

        expect(handlesRepo.setMetrics).toHaveBeenNthCalledWith(1, { lockLambdas: true });
    });

    it('calls repopulateIndexesFromUTxOs with correct function bindings', async () => {
        const { handlesRepo, reindexModule, store } = setup();
        handlesRepo.getMetrics.mockReturnValue({ lockLambdas: false });

        await reindexModule.lambdaHandler({} as any, {} as any);

        expect(store.repopulateIndexesFromUTxOs).toHaveBeenCalledWith(
            expect.objectContaining({
                [UTxOFunctionName.ADD_UTXO]: expect.any(Function),
                [UTxOFunctionName.UPDATE_HANDLE_INDEXES]: expect.any(Function)
            })
        );
    });

    it('bindings are methods from handlesRepo', async () => {
        const { handlesRepo, reindexModule, store } = setup();
        handlesRepo.getMetrics.mockReturnValue({ lockLambdas: false });

        await reindexModule.lambdaHandler({} as any, {} as any);

        const callArgs = store.repopulateIndexesFromUTxOs.mock.calls[0][0];

        // Test that the bindings call the correct repo methods
        callArgs[UTxOFunctionName.ADD_UTXO]({});
        expect(handlesRepo.addUTxO).toHaveBeenCalledWith({});

        callArgs[UTxOFunctionName.UPDATE_HANDLE_INDEXES]({});
        expect(handlesRepo.updateHandleIndexes).toHaveBeenCalledWith({});
    });

    it('logs reindexing start with schema version', async () => {
        const { handlesRepo, reindexModule, store } = setup();
        handlesRepo.getMetrics.mockReturnValue({ lockLambdas: false });
        store.getIndexSchemaVersion.mockReturnValue(2);

        await reindexModule.lambdaHandler({} as any, {} as any);

        expect(mockedLogger.log).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.stringContaining('Repopulating indexes from UTxOs to schema version 2'),
                category: LogCategory.INFO,
                event: 'getStartingPoint.repopulateIndexesFromUTxOs'
            })
        );
    });

    it('updates metrics and unlocks lambdas after reindexing', async () => {
        const { handlesRepo, reindexModule, store } = setup();
        handlesRepo.getMetrics.mockReturnValue({ lockLambdas: false });
        store.getIndexSchemaVersion.mockReturnValue(3);

        await reindexModule.lambdaHandler({} as any, {} as any);

        expect(handlesRepo.setMetrics).toHaveBeenLastCalledWith({
            indexSchemaVersion: 3,
            lockLambdas: false
        });
    });

    it('unlocks lambdas when reindexing throws', async () => {
        const { handlesRepo, reindexModule, store } = setup();
        handlesRepo.getMetrics.mockReturnValue({ lockLambdas: false });
        store.repopulateIndexesFromUTxOs.mockImplementation(() => {
            throw new Error('Reindex failed');
        });

        await expect(reindexModule.lambdaHandler({} as any, {} as any)).rejects.toThrow('Reindex failed');

        expect(handlesRepo.setMetrics).toHaveBeenNthCalledWith(1, { lockLambdas: true });
        expect(handlesRepo.setMetrics).toHaveBeenNthCalledWith(2, { lockLambdas: false });
    });
});
