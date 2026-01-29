import { HandlesRepository } from '../repositories/handlesRepository';
import { RedisHandlesStore } from '../stores/redis';

// This is meant to handle the 20 block and 2160 block double checks for rolled back data
export const lambdaHandler = async (event: AWSLambda.ALBEvent, context:AWSLambda.Context) => {
    const store = new RedisHandlesStore();
    const handlesRepo = new HandlesRepository(store);
    const { lockLambdas, last2160check} = handlesRepo.getMetrics();

    if (lockLambdas) {
        // we probably need some recovery checks/notify here
        return
    };
    // lock lambdas (cron lock in redis)

    // if it is time to run the 2160 then we don't have to run the 20
    // 2160 confirmation range once an hour

        // Get "2160 ago block" (Blockfrost supports get by height/number)
        // Get all blocks/txs/UTxOs from Bf/Ko
        // Get all of the UTxOs from db after that slot 
        // Check for  API <--  missing UTxOs --> Bf/Ko
            // This should be a notify since we are very rarely expecting in this range 
                // and may need to adjust the number 20 above accordingly
            // If there are any missing delete/replay 
            // Request all Handles in slot range and hard-set their data from Bf/Ko
        // Update last2160check
    // unlock the scanner
    // unlock the rollback

    // 20 confirmation range once a minute

        // Get "20 ago block" (Blockfrost supports get by height/number)
        // Get all blocks/txs/UTxOs from Bf/Ko
        // Get all of the UTxOs from db after that slot 
        // Check for  API <--  missing UTxOs --> Bf/Ko
            // If there are any missing delete/replay 
            // Request all Handles in slot range and hard-set their data from Bf/Ko
    // unlock the scanner
    // unlock the rollback
}
