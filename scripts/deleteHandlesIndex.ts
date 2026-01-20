import { IndexNames } from '@koralabs/kora-labs-common';
import { RedisHandlesStore } from '../stores/redis';

const redisHandleStore = new RedisHandlesStore();
await redisHandleStore.initialize();
let cursor = '0';
let deleted = 0;
const startTime = Date.now();
for (const indexName of Object.values(IndexNames)) {
    // Skip UTXO and MINT indexes
    if ([IndexNames.UTXO_SLOT, IndexNames.UTXO, IndexNames.MINT].includes(indexName)) continue;
    do {
        const [nextCursor, keys] = (await redisHandleStore.redisClientCall('scan', cursor, { match: `{root}:${indexName}:*`, count: 1000 })) as [string, string[]];
        cursor = nextCursor;

        if (keys && keys.length > 0) {
            // Delete keys directly using del with spread operator
            await redisHandleStore.redisClientCall('del', keys);
            deleted += keys.length;

            // Log progress every 100k keys
            if (deleted % 100000 === 0 || deleted % 100000 < keys.length) {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
                const rate = (deleted / ((Date.now() - startTime) / 1000)).toFixed(0);
                console.log(`Deleted: ${deleted.toLocaleString()} keys (${elapsed}s, ~${rate} keys/sec): firstKey ${keys[0]}, lastKey ${keys[keys.length - 1]}`);
            }
        }
    } while (cursor !== '0');
}
process.exit()