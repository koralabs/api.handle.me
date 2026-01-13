import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { IHandleFileContent, IndexNames, MintingData, UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import fs from 'fs';
import stdOut from 'node:readline';
import zlib from 'zlib';
import { RedisHandlesStore } from '../stores/redis';

declare global {
  interface Console {
    sameLine(msg: string): void;
  }
}
console.sameLine = function(message) {
    stdOut.clearLine(process.stdout, 0); // Clear the current line from the cursor to the right
    stdOut.cursorTo(process.stdout, 0); // Move the cursor to the beginning of the line
    process.stdout.write(message);
}

const getRedisItems = async () => {
    const utxos: Map<string, UTxOWithTxInfo | null> = new Map();
    const mints: Map<string, MintingData[] | null> = new Map();

    let lastSlot = 0;
    let lastHash = '';
    let utxoSchemaVersion = 0;

    try {
        const redisHandleStore = new RedisHandlesStore();
        await redisHandleStore.initialize();
        // console.log('Connected to Valkey');

        let cursor = '0';
        let totalKeys = 0;

        const metrics = redisHandleStore.getMetrics();
        lastSlot = Number(metrics.currentSlot);
        lastHash = `${metrics.currentBlockHash}`;
        utxoSchemaVersion = Number(metrics.utxoSchemaVersion);

        do {
            const [nextCursor, keys] = redisHandleStore.redisClientCall('scan', cursor, { match: `{root}:${IndexNames.UTXO}:*`, count: 1000 }) as [string, string[]];
            cursor = nextCursor;

            if (keys && keys.length > 0) {
                totalKeys += keys.length;

                // Log progress every 10k keys
                if (totalKeys % 10000 === 0 || totalKeys % 10000 < keys.length) {
                    console.sameLine(`Progress: ${totalKeys.toLocaleString()} keys scanned (cursor: ${cursor})`);
                }

                // check if keys starts with ({root}:utxo_slot | {root}:utxo) and add to utxoKeys
                const pipelineResults: UTxOWithTxInfo[] = redisHandleStore.pipeline(() => {
                    for (const key of keys) {
                        const keyParts = `${key}`.split(':');
                        const utxoKey = keyParts[2];
                        redisHandleStore.getValueFromIndex(IndexNames.UTXO, utxoKey) as UTxOWithTxInfo | null;
                    }
                });

                for (const item of pipelineResults) {
                    if (item && item?.slot <= lastSlot) utxos.set(item.id, item);
                }
            }
        } while (cursor !== '0');

        do {
            const [nextCursor, keys] = redisHandleStore.redisClientCall('scan', cursor, { match: `{root}:${IndexNames.MINT}:*`, count: 1000 }) as [string, string[]];
            cursor = nextCursor;

            if (keys && keys.length > 0) {
                totalKeys += keys.length;

                // Log progress every 10k keys
                if (totalKeys % 10000 === 0 || totalKeys % 10000 < keys.length) {
                    console.sameLine(`Progress: ${totalKeys.toLocaleString()} keys scanned (cursor: ${cursor})`);
                }

                // check if keys starts with ({root}:utxo_slot | {root}:utxo) and add to utxoKeys
                const pipelineResults: (Set<string> | undefined)[] = redisHandleStore.pipeline(() => {
                    for (const key of keys) {
                        const keyParts = `${key}`.split(':');
                        const mintKey = keyParts[2];
                        redisHandleStore.getValuesFromIndexedSet(IndexNames.MINT, mintKey);
                    }
                });
                // console.log('PIPELINE RESULTS LENGTH', pipelineResults, pipelineResults.length);
                for (let i = 0; i < pipelineResults.length; i++) {
                    const item = pipelineResults[i];
                    const filteredResults: MintingData[] = item ? Array.from(item).map(md => JSON.parse(md)).filter(md => md.created_slot <= lastSlot) : [];
                    mints.set(keys[i].split(':')[2], filteredResults);
                }
            }
        } while (cursor !== '0');
    } catch (error) {
        console.error('Error counting keys:', error);
    }

    console.log(`Total UTxOs: ${utxos.size.toLocaleString()}`);
    console.log(`Total Mints: ${mints.size.toLocaleString()}`);

    return {
        utxos,
        mints,
        lastSlot,
        lastHash,
        utxoSchemaVersion
    };
};

export const processSnapshot = async (network: string) => {
    const results = await getRedisItems();

    const fileJson: IHandleFileContent = {
        slot: results.lastSlot,
        hash: results.lastHash,
        utxoSchemaVersion: results.utxoSchemaVersion,
        utxos: Array.from(results.utxos)
            .map(([_, v]) => v)
            .filter((v): v is UTxOWithTxInfo => v !== null),
        mintingData: Array.from(results.mints).reduce<{ [handle: string]: MintingData[]; }>((acc, [k, v]) => {
            if (v !== null) acc[k]  = v as unknown as MintingData[];
            return acc;
        }, {})
    };

    return fileJson;
};

export const handler = async (event: any) => {
    const networks = ['mainnet', 'preview', 'preprod'];
    for (let i = 0; i < networks.length; i++) {
        const fileJson = await processSnapshot(networks[i]);

        const { utxoSchemaVersion = 1 } = fileJson;
        const fileName = `${networks[i]}/utxo-snapshot/${utxoSchemaVersion}/handles_utxos.gz`;

        const zippedSnapshots = [
            {
                Key: fileName,
                Body: zlib.deflateSync(JSON.stringify(fileJson))
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

        console.log(`s3Result ${JSON.stringify(s3Result)}`);
    }

    return {
        statusCode: 200,
        body: ''
    };
};

if (process.argv[2] === 'local') {
    await (async () => {
        const fileData = await processSnapshot(process.env.NETWORK ?? 'preview');
        const fileJson = JSON.stringify(fileData);
        fs.writeFileSync(`handles_utxos.json`, fileJson);
        fs.writeFileSync(`handles_utxos.gz`, zlib.deflateSync(fileJson));
    })();
    process.exit();
}
