import { LogCategory, Logger, UTxOFunctionName } from '@koralabs/kora-labs-common';
import { HandlesRepository } from '../repositories/handlesRepository';
import { RedisHandlesStore } from '../stores/redis';

export const lambdaHandler = async (event: AWSLambda.ALBEvent, context:AWSLambda.Context) => {
    const store = new RedisHandlesStore();
    const handlesRepo = new HandlesRepository(store);
    handlesRepo.initialize();
    const { lockLambdas } = handlesRepo.getMetrics();

    if (lockLambdas) {
        // we probably need some recovery checks/notify here
        Logger.log({ message: `Lambdas are currently locked, skipping reindexing`, category: LogCategory.WARN, event: 'reindexLambda.locked' });
        return
    }

    // Pause the lambdas (cron lock in redis)
    handlesRepo.setMetrics({ lockLambdas: true });

    // Zhu-Li, Do the thing!
    Logger.log({ message: `Repopulating indexes from UTxOs to schema version ${store.getIndexSchemaVersion()}`, category: LogCategory.INFO, event: 'getStartingPoint.repopulateIndexesFromUTxOs' });

    try {
        // TODO: This should process in chunks of 10k or so then stop the lambda and it should restart and pick up where it left off.
        // This function already chunks at a rate of about 20K every 10 seconds. 300K handles should take about 5 minutes
        store.repopulateIndexesFromUTxOs({
            [UTxOFunctionName.ADD_UTXO]: handlesRepo.addUTxO.bind(handlesRepo),
            [UTxOFunctionName.UPDATE_HANDLE_INDEXES]: handlesRepo.updateHandleIndexes.bind(handlesRepo)
        });

        // Unpause the lambdas and set the new schema version
        handlesRepo.setMetrics({ indexSchemaVersion: store.getIndexSchemaVersion(), lockLambdas: false });
    } catch (error) {
        handlesRepo.setMetrics({ lockLambdas: false });
        throw error;
    }
}