import { Batch, GlideClient } from '@valkey/valkey-glide';

// Create a Valkey client using valkey-glide
let client;

async function initializeClient() {
    try {
        client = await GlideClient.createClient({
            addresses: [{ host: 'localhost', port: 6379 }]
            // Uncomment below if Valkey requires authentication
            // password: 'your_password'
        });
    } catch (err) {
        console.error('Valkey Client Error:', err);
        process.exit(1);
    }
}

/**
 * Generate a random string of specified length
 */
function generateRandomString(length) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < length; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

/**
 * Generate a random object with random field values
 */
function generateRandomObject() {
    return {
        id: Math.random().toString(36).substring(2, 15),
        name: generateRandomString(10),
        email: `${generateRandomString(8)}@example.com`,
        age: Math.floor(Math.random() * 100),
        active: Math.random() > 0.5,
        score: Math.random() * 1000,
        tags: [generateRandomString(5), generateRandomString(5), generateRandomString(5)],
        timestamp: new Date().toISOString(),
        randomValue: Math.random()
    };
}

/**
 * Generate a random key
 */
function generateRandomKey() {
    return `key:${generateRandomString(15)}:${Date.now()}:${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * Main function to populate Valkey with million records
 */
async function populateValkey() {
    try {
        await initializeClient();
        console.log('Connected to Valkey');

        // Get current database size
        await countKeys();

        const TOTAL_RECORDS = 1_000_000;
        const BATCH_SIZE = 1000; // Insert in batches to improve performance
        let inserted = 0;
        const startTime = Date.now();

        console.log(`Starting to insert ${TOTAL_RECORDS.toLocaleString()} records...`);

        for (let i = 0; i < TOTAL_RECORDS; i += BATCH_SIZE) {
            const batchSize = Math.min(BATCH_SIZE, TOTAL_RECORDS - i);

            const pipeline = new Batch(true);
            for (let j = 0; j < batchSize; j++) {
                const key = generateRandomKey();
                const value = generateRandomObject();
                pipeline.hset(key, value);
            }

            const result = await client.exec(pipeline, true, { timeout: 10_000 });
            
            // Log first batch result to debug
            if (i === 0) {
                console.log(`First batch executed, result type: ${typeof result}, length: ${result?.length}, first few results:`, result?.slice(0, 3));
            }

            inserted += batchSize;

            // Log progress every 50k records
            if (inserted % 50000 === 0) {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
                const rate = (inserted / ((Date.now() - startTime) / 1000)).toFixed(0);
                console.log(`Progress: ${inserted.toLocaleString()} / ${TOTAL_RECORDS.toLocaleString()} records (${elapsed}s, ~${rate} ops/sec)`);
            }
        }

        const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
        const finalRate = (TOTAL_RECORDS / ((Date.now() - startTime) / 1000)).toFixed(0);

        console.log(`\n✓ Successfully inserted ${TOTAL_RECORDS.toLocaleString()} records`);
        console.log(`Total time: ${totalTime} seconds`);
        console.log(`Average rate: ${finalRate} operations/second`);

        // Get some stats
        const info = await client.info('keyspace');
        console.log('Database info:', info);
    } catch (error) {
        console.error('Error during population:', error);
    } finally {
        if (client) {
            await client.close();
        }
        console.log('Disconnected from Valkey');
    }
}

/**
 * Count keys in database using SCAN
 */
async function countKeys(close = false) {
    try {
        await initializeClient();
        console.log('Connected to Valkey');

        let cursor = '0';
        let totalKeys = 0;

        console.log('Counting keys in database...');

        do {
            const [nextCursor, keys] = await client.scan(cursor);
            cursor = nextCursor;

            if (keys && keys.length > 0) {
                totalKeys += keys.length;

                // Log progress every 100k keys
                if (totalKeys % 100000 === 0 || totalKeys % 100000 < keys.length) {
                    console.log(`Progress: ${totalKeys.toLocaleString()} keys scanned (cursor: ${cursor})`);
                }
            }
        } while (cursor !== '0');

        console.log(`\nTotal keys in database: ${totalKeys.toLocaleString()}`);
    } catch (error) {
        console.error('Error counting keys:', error);
    } finally {
        if (close) {
            if (client) {
                await client.close();
            }
            console.log('Disconnected from Valkey');
        }
    }
}

/**
 * Delete all keys using SCAN with batching
 */
async function deleteAllKeys() {
    try {
        await initializeClient();
        console.log('Connected to Valkey');

        let cursor = '0';
        let deleted = 0;
        const startTime = Date.now();

        console.log('Starting to delete keys using SCAN...\n');

        do {
            const [nextCursor, keys] = await client.scan(cursor, 1000);
            cursor = nextCursor;

            if (keys && keys.length > 0) {
                // Delete keys directly using del with spread operator
                await client.del(keys);
                deleted += keys.length;

                // Log progress every 100k keys
                if (deleted % 100000 === 0 || deleted % 100000 < keys.length) {
                    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
                    const rate = (deleted / ((Date.now() - startTime) / 1000)).toFixed(0);
                    console.log(`Deleted: ${deleted.toLocaleString()} keys (${elapsed}s, ~${rate} keys/sec): firstKey ${keys[0]}, lastKey ${keys[keys.length - 1]}`);
                }
            }
        } while (cursor !== '0');

        const totalTime = ((Date.now() - startTime) / 1000).toFixed(2);
        const finalRate = (deleted / ((Date.now() - startTime) / 1000)).toFixed(0);

        console.log(`\n✓ Completed`);
        console.log(`Total keys deleted: ${deleted.toLocaleString()}`);
        console.log(`Total time: ${totalTime} seconds`);
        console.log(`Average rate: ${finalRate} keys/second`);

        // Verify database is empty
        const info = await client.info('keyspace');
        console.log('Database info:', info);
    } catch (error) {
        console.error('Error during deletion:', error);
    } finally {
        if (client) {
            await client.close();
        }
        console.log('Disconnected from Valkey');
    }
}

// Run the script
// populateValkey();
// countKeys(true);
deleteAllKeys();
