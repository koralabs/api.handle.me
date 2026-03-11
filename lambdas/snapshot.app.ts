import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { IndexNames, LockedLambdaReason, LogCategory, Logger, MintingData, UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import fs from 'fs';
import stdOut from 'node:readline';
import zlib from 'zlib';
import { HandlesRepository } from '../repositories/handlesRepository';
import { RedisHandlesStore } from '../stores/redis';
import { extractApiIndexMember, getApiIndexScanPattern } from '../stores/redis/keys';
import { buildSnapshotVerification, VerifiedHandleFileContent } from '../utils/snapshotVerification';
process.env.ENABLE_OGMIOS_SCANNING = 'false';

declare global {
    interface Console {
        sameLine(msg: string): void;
    }
}
console.sameLine = function (message) {
    stdOut.clearLine(process.stdout, 0); // Clear the current line from the cursor to the right
    stdOut.cursorTo(process.stdout, 0); // Move the cursor to the beginning of the line
    process.stdout.write(message);
};

// Run locally with (note your .env): 
// tsx -r dotenv/config ./lambdas/snapshot.ts local

const LOCK_REASON_SNAPSHOT = 'SNAPSHOT' as LockedLambdaReason;
const LOCKED_LAMBDA_RETRY_DELAY_MS = 15_000;
const LOCKED_LAMBDA_MAX_RETRIES = 4;

const delayMs = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const waitForUnlockedLambdas = async (handlesRepo: HandlesRepository) => {
    let metrics = handlesRepo.getMetrics();
    let retries = 0;

    while (metrics.lockLambdas) {
        if (retries >= LOCKED_LAMBDA_MAX_RETRIES) return metrics;
        retries++;
        await delayMs(LOCKED_LAMBDA_RETRY_DELAY_MS);
        metrics = handlesRepo.getMetrics();
    }

    return metrics;
};

const getRedisItems = async () => {
    const utxos: Map<string, UTxOWithTxInfo | null> = new Map();
    const mints: Map<string, MintingData[] | null> = new Map();

    let lastSlot = 0; // Lets hardcode this to 20 blocks ago (from Bf) To avoid recording a rollbak to the snapshot
    let lastHash = '';
    let utxoSchemaVersion = 0;
    let handleCount = 0;

    try {
        const redisHandleStore = new RedisHandlesStore();
        await redisHandleStore.initialize();

        let cursor = '0';
        let totalKeys = 0;

        const metrics = redisHandleStore.getMetrics();
        lastSlot = Number(metrics.currentSlot);
        lastHash = `${metrics.currentBlockHash}`;
        utxoSchemaVersion = Number(metrics.utxoSchemaVersion);
        handleCount = Number(metrics.handleCount);

        do {
            const [nextCursor, keys] = redisHandleStore.redisClientCall('scan', cursor, { match: getApiIndexScanPattern(IndexNames.UTXO), count: 1000 }) as [string, string[]];
            cursor = nextCursor;

            if (keys && keys.length > 0) {
                totalKeys += keys.length;

                // Log progress every 10k keys
                if (totalKeys % 10000 === 0 || totalKeys % 10000 < keys.length) {
                    console.sameLine(`Progress: ${totalKeys.toLocaleString()} keys scanned (cursor: ${cursor})`);
                }

                // check if keys start with the env-scoped utxo prefix and add the member key
                const pipelineResults: UTxOWithTxInfo[] = redisHandleStore.pipeline(() => {
                    for (const key of keys) {
                        const utxoKey = extractApiIndexMember(`${key}`, IndexNames.UTXO);
                        if (!utxoKey) continue;
                        redisHandleStore.getHashFromIndex(IndexNames.UTXO, utxoKey) as UTxOWithTxInfo | null;
                    }
                });

                for (const item of pipelineResults) {
                    if (item && item?.slot <= lastSlot) utxos.set(item.id, item);
                }
            }
        } while (cursor !== '0');

        do {
            const [nextCursor, keys] = redisHandleStore.redisClientCall('scan', cursor, { match: getApiIndexScanPattern(IndexNames.MINT), count: 1000 }) as [string, string[]];
            cursor = nextCursor;

            if (keys && keys.length > 0) {
                totalKeys += keys.length;

                // Log progress every 10k keys
                if (totalKeys % 10000 === 0 || totalKeys % 10000 < keys.length) {
                    console.sameLine(`Progress: ${totalKeys.toLocaleString()} keys scanned (cursor: ${cursor})`);
                }

                // check if keys start with the env-scoped mint prefix and add the member key
                const pipelineResults: (Set<string> | undefined)[] = redisHandleStore.pipeline(() => {
                    for (const key of keys) {
                        const mintKey = extractApiIndexMember(`${key}`, IndexNames.MINT);
                        if (!mintKey) continue;
                        redisHandleStore.getValuesFromIndexedSet(IndexNames.MINT, mintKey);
                    }
                });
                // Logger.local('PIPELINE RESULTS LENGTH', pipelineResults, pipelineResults.length);
                for (let i = 0; i < pipelineResults.length; i++) {
                    const item = pipelineResults[i];
                    const mintKey = extractApiIndexMember(`${keys[i]}`, IndexNames.MINT);
                    if (!mintKey) continue;
                    const filteredResults: MintingData[] = item
                        ? Array.from(item)
                              .map((md) => JSON.parse(md))
                              .filter((md) => md.created_slot <= lastSlot)
                        : [];
                    mints.set(mintKey, filteredResults);
                }
            }
        } while (cursor !== '0');
    } catch (error: any) {
        Logger.log({ message: `Error counting keys: ${error?.message ?? error}`, category: LogCategory.ERROR, event: 'snapshot.getRedisItems' });
    }

    Logger.local(`Total UTxOs: ${utxos.size.toLocaleString()}`);
    Logger.local(`Total Mints: ${mints.size.toLocaleString()}`);

    return {
        utxos,
        mints,
        lastSlot,
        lastHash,
        utxoSchemaVersion,
        handleCount
    };
};

export const processSnapshot = async (_network: string) => {
    const results = await getRedisItems();

    const fileJson: VerifiedHandleFileContent & { snapshotHandleCount: number } = {
        slot: results.lastSlot,
        hash: results.lastHash,
        utxoSchemaVersion: results.utxoSchemaVersion,
        snapshotHandleCount: results.handleCount,
        utxos: Array.from(results.utxos)
            .map(([_, v]) => v)
            .filter((v): v is UTxOWithTxInfo => v !== null),
        mintingData: Array.from(results.mints).reduce<{ [handle: string]: MintingData[] }>((acc, [k, v]) => {
            if (v !== null) acc[k] = v as unknown as MintingData[];
            return acc;
        }, {})
    };

    return fileJson;
};

export const handler = async (event: any) => {
    const store = new RedisHandlesStore();
    const handlesRepo = new HandlesRepository(store);
    await handlesRepo.initialize();
    const { lockLambdas } = await waitForUnlockedLambdas(handlesRepo);

    if (lockLambdas) {
        // we probably need some recovery checks/notify here
        return {
            statusCode: 200,
            body: ''
        };
    }

    handlesRepo.setMetrics({ lockLambdas: LOCK_REASON_SNAPSHOT, lockLambdasTimestamp: Date.now() });
    try {
        const network = `${process.env.NETWORK ?? 'preview'}`.toLowerCase();
        const { snapshotHandleCount, ...fileJson } = await processSnapshot(network);
        const verifiedFileJson: VerifiedHandleFileContent = {
            ...fileJson,
            verification: await buildSnapshotVerification(snapshotHandleCount)
        };

        const { utxoSchemaVersion = 1 } = verifiedFileJson;
        const fileName = `${network}/utxo-snapshot/${utxoSchemaVersion}/handles_utxos.gz`;

        const zippedSnapshots = [
            {
                Key: fileName,
                Body: zlib.deflateSync(JSON.stringify(verifiedFileJson))
            }
        ];

        const s3Result = await Promise.all(
            zippedSnapshots.map(({ Key, Body }) => {
                const params = {
                    Bucket: 'api.handle.me',
                    Key,
                    Body
                };
                return new S3Client({ region: 'us-west-2' }).send(new PutObjectCommand(params));
            })
        );

        Logger.local(`s3Result ${JSON.stringify(s3Result)}`);

        return {
            statusCode: 200,
            body: ''
        };
    } finally {
        handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.UNLOCKED });
    }
};

if (process.argv[2] === 'local') {
    await (async () => {
        const { snapshotHandleCount, ...fileData } = await processSnapshot(process.env.NETWORK ?? 'preview');
        const fileJson = JSON.stringify({
            ...fileData,
            verification: await buildSnapshotVerification(snapshotHandleCount)
        });
        fs.writeFileSync(`tmp/handles_utxos.json`, fileJson);
        fs.writeFileSync(`tmp/handles_utxos.gz`, zlib.deflateSync(fileJson));
    })();
    process.exit();
}
