import { LogCategory, Logger } from '@koralabs/kora-labs-common';
import { HandlesRepository } from '../repositories/handlesRepository';
import { RedisHandlesStore } from '../stores/redis';

export const lambdaHandler = async (event: AWSLambda.ALBEvent, context:AWSLambda.Context) => {
    const store = new RedisHandlesStore();
    const handlesRepo = new HandlesRepository(store);
    const { lockLambdas, last2160check} = handlesRepo.getMetrics();

    if (lockLambdas) {
        // we probably need some recovery checks/notify here
        return
    }

    // Pause the lambdas (cron lock in redis)

    // Zhu-Li, Do the thing!
    Logger.log({ message: `Repopulating indexes from UTxOs to schema version ${store.getIndexSchemaVersion()}`, category: LogCategory.INFO, event: 'getStartingPoint.repopulateIndexesFromUTxOs' });
    store.repopulateIndexesFromUTxOs(utxoFunctions);
    handlesRepo.setMetrics({ indexSchemaVersion: store.getIndexSchemaVersion() });

    // unlock the Lambdas
}