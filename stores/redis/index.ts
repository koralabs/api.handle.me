import { ApiIndexType, chunk, Holder, HolderHandleNames, IApiMetrics, IApiStore, IHandleFileContent, IndexNames, ISlotHistory, isNumeric, LogCategory, Logger, MintingData, NETWORK, SortAndLimitOptions, StoredHandle, UTxOFunctionName, UTxOFunctions } from '@koralabs/kora-labs-common';
import { GlideString, HashDataType, SortOptions } from '@valkey/valkey-glide';
import { promisify } from 'util';
import { MessageChannel, receiveMessageOnPort, Worker } from 'worker_threads';
import { inflate } from 'zlib';
import { DISABLE_HANDLES_SNAPSHOT, NODE_ENV } from '../../config';
import { handleEraBoundaries, MAX_SETS_PER_PIPE, META_INDEXES, ORDERED_SLOTS } from '../../config/constants';

// const glideClient = await GlideClient.createClient({
//       addresses: [{ host: 'https://localhost', port: 6379 }],
//       useTLS: process.env.REDIS_USE_TLS ? process.env.REDIS_USE_TLS == 'true' : true
// });

// glideClient.zremRangeByScore('', {value: 0, isInclusive: true})

const redisTimings: Record<string, number> = {};

export class RedisHandlesStore implements IApiStore {
    private static _worker: any;
    private static _id = 0;
    private static _pipeline: [string, any[]][] | undefined = undefined;

    // #region SETUP **************************
    public initialize(): IApiStore {
        if (!RedisHandlesStore._worker) {
            const worker = new Worker('./workers/redisSync.worker.js');
            worker.on('error', (e) => Logger.log({ message: `Error: ${e}`, category: LogCategory.ERROR, event: 'ValkeySyncWorker.Error' }));
            worker.on('exit', (e) => Logger.log({ message: `Error: ${e}`, category: LogCategory.ERROR, event: 'ValkeySyncWorker.Exit' }));
            RedisHandlesStore._worker = worker;
        }
        //const interval = setInterval(() => {console.log('TIMINGS', JSON.stringify(Object.entries(redisTimings).sort((a, b) => b[1] - a[1])))}, 10_000)
        return this;
    }
    /**
     * Be careful with the pipeline command.
     * Since the commands are queued and executed in a batch,
     * you won't get results for each command until AFTER the pipeline finishes.
     * You'll have to iterate over the batch results that come back in the
     * response of pipeline() to find your desired results.
     * If it feels like your code "isn't running" or "isn't returning anything", this is probably why.
     */
    public pipeline(commands: CallableFunction) {
        RedisHandlesStore._pipeline = [];
        commands();
        //console.log('PIPELINE', RedisHandlesStore._pipeline)
        const results = this.redisClientCall('batch', RedisHandlesStore._pipeline);
        for (let i = 0; i < results.length; i++) {
            // All results are returned
            // Only used to rehydrate the hgetall
            if (RedisHandlesStore._pipeline[i][0] == 'hgetall') {
                //console.log(RedisHandlesStore._pipeline[i][1][0], results[i])
                results[i] = this.rehydrateObject(RedisHandlesStore._pipeline[i][1][0], results[i]);
            }
        }
        RedisHandlesStore._pipeline = undefined;
        return results;
    }

    public destroy(): void {
        this.redisClientCall('flushdb');
        this.redisClientCall('close');
        RedisHandlesStore._pipeline = undefined;
        if (RedisHandlesStore._worker.terminate) RedisHandlesStore._worker.terminate();
        RedisHandlesStore._worker = undefined;
    }

    public rollBackToGenesis(): void {
        Logger.log({ message: 'Calling FLUSHDB', category: LogCategory.INFO, event: 'this.rollBackToGenesis' });
        // Clear all redis cache
        this.redisClientCall('flushdb');
        RedisHandlesStore._pipeline = undefined;
    }

    repopulateIndexesFromUTxOs(utxoFunctions: UTxOFunctions): void {
        let cursor = '0';
        let deleted = 0;
        let added = 0;
        const startTime = Date.now();
        for (const indexName of Object.values(IndexNames)) {
            // Skip UTXO and MINT indexes
            if ([IndexNames.UTXO_SLOT, IndexNames.UTXO, IndexNames.MINT].includes(indexName)) continue;
            do {
                const [nextCursor, keys] = (this.redisClientCall('scan', cursor, { match: `{root}:${indexName}:*`, count: 1000 })) as [string, string[]];
                cursor = nextCursor;

                if (keys && keys.length > 0) {
                    // Delete keys directly using del with spread operator
                    this.redisClientCall('del', keys);
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

        // iterate through UTXO_SLOT and grab the UTxOs using the slot.
        const utxoIds = (this.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, 0) ?? []) as string[];
        Logger.log(`Repopulating indexes from ${utxoIds.length.toLocaleString()} UTxOs, ${utxoIds[0]}`);
        
        const utxos = this.pipeline(() => {
            utxoIds.map(utxoId => this.getHashFromIndex(IndexNames.UTXO, utxoId)).filter(Boolean)
        });

        // TODO: This will have to be chunked to 10k at a time
        const handles = new Map<string, StoredHandle>();
        const holders = new Map<string, HolderHandleNames>();
        const mintingData = new Map<string, MintingData[]>();
        const mintHandles = this.getKeysFromIndex(IndexNames.MINT) as string[];
        if (mintHandles.length) {
            const mintValues = this.pipeline(() => {
                mintHandles.forEach((handleName) => this.getValuesFromIndexedSet(IndexNames.MINT, handleName));
            }) as Set<string>[];

            mintHandles.forEach((handleName, index) => {
                mintingData.set(
                    handleName,
                    Array.from(mintValues[index] ?? []).map((md) => JSON.parse(md))
                );
            });
        }
        this.pipeline(() => {
            for (const utxo of utxos) {
                utxoFunctions[UTxOFunctionName.UPDATE_HANDLE_INDEXES](utxo, mintingData, handles, holders);
                added++;
            }
        })
        
        // Log progress every 10k keys
        if (added % 10000 === 0) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            const rate = (added / ((Date.now() - startTime) / 1000)).toFixed(0);
            console.log(`Added: ${added.toLocaleString()} keys (${elapsed}s, ~${rate} keys/sec)`);
        }
        
        const endTime = Date.now();
        const pad = (num: number) => num.toString().padStart(2, '0');
        const seconds = (endTime - startTime) / 1000;
        Logger.log(`Repopulate Handle indexes from UTxOs took ${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`);
    }

    public async tryPopulateFromS3UTxOs(utxoFunctions: UTxOFunctions): Promise<{ slot: number; id: string }> {
        const startTime = Date.now();
        this.redisClientCall('flushdb');
        let id = handleEraBoundaries[NETWORK].id;
        let slot = handleEraBoundaries[NETWORK].slot;
        const currentUTxOSchemaVersion = this.getUTxOSchemaVersion();
        const fileName = 'handles_utxos.gz';
        const url = `http://api.handle.me.s3-website-us-west-2.amazonaws.com/${NETWORK}/utxo-snapshot/${this.getUTxOSchemaVersion()}/${fileName}`;
        Logger.log(`Fetching ${url}`);
        const awsResponse = await fetch(url);
        if (awsResponse.status === 200) {
            const buff = await awsResponse.arrayBuffer();
            const unZipPromise = promisify(inflate);
            const result = await unZipPromise(buff);
            const text = result.toString('utf8');
            Logger.log(`Found ${url}`);
            //const text = fs.readFileSync(`handles_utxos.json`, 'utf8');
            const storedS3HandlesUTxOJson = JSON.parse(text) as IHandleFileContent;
            const { utxos, slot: s3Slot, mintingData, hash: s3Hash, utxoSchemaVersion } = storedS3HandlesUTxOJson;

            if (utxoSchemaVersion == currentUTxOSchemaVersion) {
                // Save minting data first
                const mintingDataChunks = chunk(Object.entries(mintingData), MAX_SETS_PER_PIPE);
                for (const mintingDataChunk of mintingDataChunks) {
                    this.pipeline(() => {
                        mintingDataChunk.forEach(([handle, mintData]) => {
                            mintData.forEach(md => this.addValueToIndexedSet(IndexNames.MINT, handle, JSON.stringify(md)))
                        });
                    });
                }

                Logger.log(`Saved minting data for ${Object.keys(mintingData).length.toLocaleString()} handles from S3 snapshot`);

                // save all the individual handles to the store
                utxos.sort((a, b) => a.slot - b.slot);

                const utxoChunks = chunk(utxos, MAX_SETS_PER_PIPE);
                const handles = new Map<string, StoredHandle>();
                const holders = new Map<string, HolderHandleNames>();
                const mintData = new Map(Object.entries(mintingData) as [string, MintingData[]][]);
                for (const utxoChunk of utxoChunks) {
                    this.pipeline(() => {
                        utxoChunk.forEach((utxo) => {
                            utxoFunctions[UTxOFunctionName.ADD_UTXO](utxo);
                            utxoFunctions[UTxOFunctionName.UPDATE_HANDLE_INDEXES](utxo, mintData, handles, holders);
                        });
                    });
                }

                Logger.log(`Saved ${utxos.length.toLocaleString()} UTxOs from S3 snapshot`);


                id = s3Hash;
                slot = s3Slot;
            }
            
            const endTime = Date.now();
            const pad = (num: number) => num.toString().padStart(2, '0');
            const seconds = (endTime - startTime) / 1000;
            Logger.log(`Populate from S3 took ${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`);
        }

        const metrics = this.getMetrics();
        Logger.log(`UTxO storage starting at slot: ${slot} and hash: ${id} with ${metrics.handleCount} Handles`);

        this.setMetrics({ utxoSchemaVersion: currentUTxOSchemaVersion, currentBlockHash: id, currentSlot: slot, startTimestamp: Date.now() });
        return { id, slot };
    }

    /**
     * 
     * @param utxoFunctions Functions that are used to set indexes. NOTE: The first function should always be addUtxos
     * @param failed 
     * @returns 
     */
    public async getStartingPoint(utxoFunctions: UTxOFunctions, failed = false): Promise<{ slot: number; id: string } | null> {
        // This should run locally so we're not worried about a long running process
        if (!failed) {
            const { indexSchemaVersion, utxoSchemaVersion, currentSlot, currentBlockHash } = this.getMetrics();

            const currentSchemaVersion = this.getUTxOSchemaVersion();
            if (currentSchemaVersion > (utxoSchemaVersion ?? 0) || !currentBlockHash || !currentSlot) {
                // start at Handle genesis
                const { id, slot } = await this.tryPopulateFromS3UTxOs(utxoFunctions);
                return { id, slot };
            }

            if (this.getIndexSchemaVersion() > (indexSchemaVersion ?? 0)) {
                Logger.log({ message: `Repopulating indexes from UTxOs to schema version ${this.getIndexSchemaVersion()}`, category: LogCategory.INFO, event: 'getStartingPoint.repopulateIndexesFromUTxOs' });
                this.repopulateIndexesFromUTxOs(utxoFunctions);
                this.setMetrics({ indexSchemaVersion: this.getIndexSchemaVersion() });
            }

            return { id: currentBlockHash, slot: currentSlot };
        } else {
            if (NODE_ENV === 'local' || DISABLE_HANDLES_SNAPSHOT == 'true') {
                return null;
            }

            try {
                const { id, slot } = await this.tryPopulateFromS3UTxOs(utxoFunctions);
                return { id, slot };
            } catch (error: any) {
                Logger.log(`Error fetching file from online with error: ${error.message}`);
                return null;
            }
        }
    }

    // #endregion

    // #region BASIC INDEX METHODS ******************

    public getValueFromIndex(index: IndexNames, key: string | number): string | undefined {
        return this.redisClientCall('get', `{root}:${index}:${key}`);
    }

    public setValueOnIndex(index: IndexNames, key: string | number, value: string): void {
        this.redisClientCall('set', `{root}:${index}:${key}`, value);
    }

    // #endregion

    // #region HASH INDEXES *************************
    public getIndex(index: IndexNames, options?: SortAndLimitOptions): Map<string | number, ApiIndexType> {
        // SLOT & SLOT_HISTORY uses a an ordered set (ZSET)
        if (ORDERED_SLOTS.includes(index)) {
            return this.parseOrderedSlot(this.redisClientCall('zrangeWithScores', `{root}:${index}`, { start: 0, end: -1 }));
        }
        const command = options ? 'sort' : 'smembers';
        if (options && options?.isAlpha == undefined) options = { ...options, isAlpha: true };
        const keys = this.redisClientCall(command, `{root}:${index}`, options);
        const values: Map<string | number, ApiIndexType> = new Map<string | number, ApiIndexType>();
        for (const key of keys) {
            const value = this.getHashFromIndex(index, key);
            if (value) values.set(String(key), value);
        }
        return values;
    }

    public getKeysFromIndex(index: IndexNames, options?: SortAndLimitOptions): (string | number)[] {
        const command = options ? 'sort' : 'smembers';
        if (options && options?.isAlpha == undefined) options = { ...options, isAlpha: true };
        return [...this.redisClientCall(command, `{root}:${index}`, options)].map((v) => (isNumeric(v.toString()) && index != IndexNames.HANDLE ? Number(v.toString()) : v.toString()));
    }

    public getHashFromIndex(index: IndexNames, key: string | number): ApiIndexType | undefined {
        return this.rehydrateObjectFromCache(`{root}:${index}:${key}`);
    }

    public setHashOnIndex(index: IndexNames, key: string | number, value: ApiIndexType): void {
        this.saveObjectToCache(`{root}:${index}:${key}`, value);
        if (META_INDEXES.includes(index)) this.redisClientCall('sadd', `{root}:${index}`, [key]);
        if (index == IndexNames.HOLDER) this.addValueToOrderedSet(IndexNames.HOLDER, (value as Holder).handles.length, key as string);
    }

    private removeKeyFromMetaIndex(index: IndexNames, key: string | number) {
        if (META_INDEXES.includes(index)) {
            const count = this.redisClientCall('scard', `{root}:${index}:${key}`) as number;
            if ((RedisHandlesStore._pipeline && count == 1) || !count) this.redisClientCall('srem', `{root}:${index}`, [key]);
        }
    }

    /**
     * 
     * @param index IndexNames
     * @param key string | number
     */
    public removeKeyFromIndex(index: IndexNames, key: string | number): void {
        this.redisClientCall('del', [`{root}:${index}:${key}`]);
        this.removeKeyFromMetaIndex(index, key);
    }

    // #endregion

    // #region SET INDEXES ************************
    public getValuesFromIndexedSet(index: IndexNames, key: string | number, options?: SortAndLimitOptions): Set<string> | undefined {
        const command = options ? 'sort' : 'smembers';
        if (options && options?.isAlpha == undefined) options = { ...options, isAlpha: true };
        return new Set([...(this.redisClientCall(command, `{root}:${index}:${key}`, options) ?? [])].map((v) => v.toString()));
    }

    public addValueToIndexedSet(index: IndexNames, key: string | number, value: string): void {
        this.redisClientCall('sadd', `{root}:${index}:${key}`, [value]);
        if (META_INDEXES.includes(index)) this.redisClientCall('sadd', `{root}:${index}`, [key]);
    }

    public removeValueFromIndexedSet(index: IndexNames, key: string | number, value: string): void {
        if (key != null) {
            this.redisClientCall('srem', `{root}:${index}:${key}`, [value]);
            this.removeKeyFromMetaIndex(index, key);
        }
    }

    // #endregion

    // #region ORDERED INDEXES  ************************

    public getValuesFromOrderedSet(index: IndexNames, ordinal: number, options?: SortAndLimitOptions): ApiIndexType[] | undefined {
        if (ORDERED_SLOTS.includes(index)) {
            return this.parseOrderedSlot(this.redisClientCall('zrangeWithScores', `{root}:${index}`, { type: 'byScore', start: { value: ordinal }, end: { value: ordinal } }))
                .values()
                .toArray();
        }
        const reverse = options?.orderBy?.toUpperCase() == 'DESC';
        return [...this.redisClientCall('zrange', `{root}:${index}`, { ...options, type: 'byScore', start: { value: options?.start ?? (reverse ? Infinity : -Infinity) }, end: { value: options?.end ?? (reverse ? -Infinity : Infinity) } } as SortOptions, { reverse })].map((v) => (isNumeric(v.toString()) ? Number(v.toString()) : v.toString()));
    }

    public addValueToOrderedSet(index: IndexNames, ordinal: number, value: string | ISlotHistory) {
        if (ORDERED_SLOTS.includes(index)) {
            value = `${ordinal}|${JSON.stringify(value)}`;
            this.redisClientCall('zremRangeByScore', `{root}:${index}`, { value: ordinal, isInclusive: true }, { value: ordinal, isInclusive: true });
        }
        this.redisClientCall('zadd', `{root}:${index}`, [{ element: value, score: ordinal as number }]);
        return;
    }

    public removeValuesFromOrderedSet(index: IndexNames, keyOrOrdinal: string | number) {
        if (ORDERED_SLOTS.includes(index)) {
            this.redisClientCall('zremRangeByScore', `{root}:${index}`, '-', { value: keyOrOrdinal, isInclusive: false });
            return;
        }
        this.redisClientCall('zrem', `{root}:${index}`, typeof keyOrOrdinal == 'string' ? keyOrOrdinal : JSON.stringify(keyOrOrdinal));
        return;
    }

    // #endregion

    // #region METRICS *****************************
    public getMetrics(): IApiMetrics {
        const metrics = this.rehydrateObjectFromCache('metrics') || ({} as IApiMetrics);
        metrics.handleCount = this.count();
        metrics.holderCount = this.holderCount();
        return metrics;
    }

    public setMetrics(metrics: Partial<IApiMetrics>): void {
        const formattedMetrics = Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, String(v)]));
        this.redisClientCall('hset', 'metrics', formattedMetrics);
    }

    public count(): number {
        return this.redisClientCall('scard', `{root}:${IndexNames.HANDLE}`);
    }

    public holderCount(): number {
        return this.redisClientCall('scard', `{root}:${IndexNames.HOLDER}`, { value: -Infinity }, { value: Infinity });
    }

    public getUTxOSchemaVersion(): number {
        return Number(process.env.UTXO_SCHEMA_VERSION);
    }

    public getIndexSchemaVersion(): number {
        return Number(process.env.INDEX_SCHEMA_VERSION);
    }

    // #endregion

    // #region PRIVATE *******************************

    private parseOrderedSlot(results: { score: number; element: GlideString }[]) {
        return results.reduce((acc: Map<number, ISlotHistory | string>, value: { score: number; element: GlideString }) => {
            acc.set(value.score, JSON.parse(value.element.toString().split('|', 2)[1]) as ISlotHistory | string);
            return acc;
        }, new Map<number, ISlotHistory | string>());
    }

    private _isPlainObject(value: any) {
        return (
            typeof value === 'object' &&
            value !== null &&
            !Array.isArray(value)
        );
    }

    private saveObjectToCache(key: string, obj: any) {
        const parentFields: Record<string, string> = {};
        if (this._isPlainObject(obj)) {
            for (const [field, value] of Object.entries(obj)) {
                if (value != undefined && value != null) {
                    if (typeof value === 'object') {
                        // JSON value → add to parent hash
                        parentFields[field] = JSON.stringify(value, (_, val) => (typeof val === 'bigint' ? `${Number(val)}` : val));
                    } else {
                        // Primitive value → add to parent hash
                        parentFields[field] = String(value);
                    }
                }
            }
            if (Object.keys(parentFields).length > 0) {
                this.redisClientCall('hset', key, parentFields);
            }
            return;
        }
        throw new Error(`saveObjectToCache only supports plain objects. Key: ${key}`);
    }

    private rehydrateObjectFromCache(key: string): Record<string, any> | undefined {
        const fields: HashDataType = this.redisClientCall('hgetall', key);
        return this.rehydrateObject(key, fields);
    }

    private rehydrateObject(key: string, fields: HashDataType): Record<string, any> | undefined {
        const result: Record<string, any> = {};
        if (!fields || fields.length == 0) return undefined;
        //                                  very annoying workaround for the difference in normal and batch variants of `hgetall()`
        for (const { field: f, value } of fields.map((entry: any) => ({ field: entry.field ?? entry.key, value: entry.value }))) {
            const field = f.toString();
            if (value.toString() == `${key}:${field}`) result[field] = this.rehydrateObjectFromCache(`${key}:${field}`);
            else {
                try {
                    if (['name', 'hex', 'default_in_wallet'].includes(field)) result[field] = value.toString();
                    else result[field] = JSON.parse(value.toString()); // This covers object, array, boolean, number
                } catch {
                    result[field] = value.toString();
                }
            }
        }
        return result;
    }

    public redisClientCall(cmd: string, ...args: any[]) {
        if (RedisHandlesStore._pipeline && cmd != 'batch') {
            // scard needs to go through for removeValueFromIndexedSet to work right
            if (cmd != 'scard') {
                RedisHandlesStore._pipeline.push([cmd, args]);
                return;
            }
        }
        const start = Date.now();

        const id = RedisHandlesStore._id++;
        const sab = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
        const view = new Int32Array(sab);

        const { port1, port2 } = new MessageChannel();
        RedisHandlesStore._worker.postMessage({ id, sab, payload: { id, cmd, args }, reply: port2 }, [port2]);

        // Block up to 30s so we don't hang forever
        const status = Atomics.wait(view, 0, 0, 30_000);
        if (status === 'timed-out') {
            throw new Error(`GlideClient ${cmd} timed out`);
        }

        const msg = receiveMessageOnPort(port1);
        port1.close();

        const end = Date.now();
        redisTimings[cmd] = (redisTimings[cmd] ?? 0) + (end - start);

        if (!msg || msg.message.id !== id) {
            Logger.log({ message: `GlideClient ${cmd} received no/incorrect reply: ${msg}`, category: LogCategory.ERROR, event: 'redisClientCall.incorrectMessageResponse' });
            return undefined;
        }

        const { ok, result, error } = msg.message;
        if (!ok) {
            const message = error?.message || `GlideClient ${cmd} failed`;
            Logger.log({ message, category: LogCategory.ERROR, event: 'redisClientCall.errorFromPostMessage' });
            throw new Error(message);
        }
        return result;
    }

    // #endregion
}
