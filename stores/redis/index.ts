import { ApiIndexType, chunk, Holder, HolderHandleNames, IApiMetrics, IApiStore, IHandleFileContent, IndexNames, ISlotHistory, isNumeric, LogCategory, Logger, MintingData, NETWORK, SortAndLimitOptions, StoredHandle, UTxOFunctionName, UTxOFunctions, UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import { GlideString, HashDataType, SortOptions } from '@valkey/valkey-glide';
import { promisify } from 'util';
import { MessageChannel, receiveMessageOnPort, Worker } from 'worker_threads';
import { inflate } from 'zlib';
import { DISABLE_HANDLES_SNAPSHOT, NODE_ENV } from '../../config';
import { handleEraBoundaries, MAX_SETS_PER_PIPE, META_INDEXES, ORDERED_SLOTS } from '../../config/constants';
import { getHandleNameFromAssetName } from '../../services/ogmios/utils';
import { canonicalJsonStringify } from '../../utils/helpers';
import { isChainVerifiedSnapshot, VerifiedHandleFileContent } from '../../utils/verifiedSnapshot';
import { getApiCacheTag, getApiIndexKey, getApiIndexRootKey, getApiIndexScanPattern, getApiMetricsKey, getApiMptRootHashKey, getApiNamespaceScanPattern, getApiScannedBlocksKey } from './keys';

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
            worker.on('error', (error: any) => Logger.log({ message: `Valkey sync worker error: ${error?.message ?? error}`, category: LogCategory.ERROR, event: 'ValkeySyncWorker.Error' }));
            worker.on('exit', (code: number) => {
                // worker.terminate() resolves with exit code 1 by design; treat that as expected shutdown noise.
                if (code === 0 || code === 1) {
                    Logger.local(`Valkey sync worker exited with code ${code}`);
                    return;
                }
                Logger.log({ message: `Valkey sync worker exited unexpectedly with code ${code}`, category: LogCategory.ERROR, event: 'ValkeySyncWorker.Exit' });
            });
            RedisHandlesStore._worker = worker;
        }
        //const interval = setInterval(() => {Logger.local('TIMINGS', JSON.stringify(Object.entries(redisTimings).sort((a, b) => b[1] - a[1])))}, 10_000)
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
        if (RedisHandlesStore._pipeline !== undefined) {
            // Fail loudly on reentrance — the previous behavior silently
            // overwrote the outer pipeline's queued commands, causing writes
            // to vanish. Callers must not nest pipelines.
            throw new Error('RedisHandlesStore.pipeline() called while another pipeline is already active');
        }
        RedisHandlesStore._pipeline = [];
        try {
            commands();
            //Logger.local('PIPELINE', RedisHandlesStore._pipeline)
            const pipelineCommands = RedisHandlesStore._pipeline ?? [];
            if (pipelineCommands.length === 0) {
                return [];
            }
            const results = this.redisClientCall('batch', pipelineCommands);
            for (let i = 0; i < results.length; i++) {
                // All results are returned
                // Only used to rehydrate the hgetall
                if (pipelineCommands[i][0] == 'hgetall') {
                    //Logger.local(pipelineCommands[i][1][0], results[i])
                    results[i] = this.rehydrateObject(pipelineCommands[i][1][0], results[i]);
                }
            }
            return results;
        } finally {
            RedisHandlesStore._pipeline = undefined;
        }
    }

    public destroy(): void {
        this.clearNamespace();
        this.redisClientCall('close');
        RedisHandlesStore._pipeline = undefined;
        if (RedisHandlesStore._worker.terminate) RedisHandlesStore._worker.terminate();
        RedisHandlesStore._worker = undefined;
    }

    public rollBackToGenesis(): void {
        Logger.log({ message: 'Clearing scoped cache namespace', category: LogCategory.INFO, event: 'this.rollBackToGenesis' });
        this.clearNamespace();
        RedisHandlesStore._pipeline = undefined;
    }

    repopulateIndexesFromUTxOs(utxoFunctions: UTxOFunctions): void {
        let deleted = 0;
        let added = 0;
        const startTime = Date.now();
        for (const indexName of Object.values(IndexNames)) {
            // Skip UTXO and MINT indexes
            if ([IndexNames.UTXO_SLOT, IndexNames.UTXO, IndexNames.MINT].includes(indexName)) continue;
            let cursor = '0';
            deleted += Number(this.redisClientCall('del', [getApiIndexRootKey(indexName)]) ?? 0);
            do {
                const [nextCursor, keys] = (this.redisClientCall('scan', cursor, { match: getApiIndexScanPattern(indexName), count: 1000 })) as [string, string[]];
                cursor = nextCursor;

                if (keys && keys.length > 0) {
                    // Delete keys directly using del with spread operator
                    this.redisClientCall('del', keys);
                    deleted += keys.length;

                    // Log progress every 100k keys
                    if (deleted % 100000 === 0 || deleted % 100000 < keys.length) {
                        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
                        const rate = (deleted / ((Date.now() - startTime) / 1000)).toFixed(0);
                        Logger.local(`Deleted: ${deleted.toLocaleString()} keys (${elapsed}s, ~${rate} keys/sec): firstKey ${keys[0]}, lastKey ${keys[keys.length - 1]}`);
                    }
                }
            } while (cursor !== '0');
        }

        // iterate through UTXO_SLOT and grab the UTxOs using the slot.
        const utxoIds = (this.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, 0) ?? []) as string[];
        Logger.log(`Repopulating indexes from ${utxoIds.length.toLocaleString()} UTxOs Ids`);
        
        const utxos = (this.pipeline(() => {
            utxoIds.map(utxoId => this.getHashFromIndex(IndexNames.UTXO, utxoId)).filter(Boolean)
        }) as (UTxOWithTxInfo | undefined)[]).filter((utxo): utxo is UTxOWithTxInfo => !!utxo && Array.isArray(utxo.handles));

        const handleNames = utxos.flatMap(u => u.handles.flatMap(h => h[1]).map(h => getHandleNameFromAssetName(h).name));

        // TODO: This will have to be chunked to 10k at a time
        const handles = new Map<string, StoredHandle>();
        const holders = new Map<string, HolderHandleNames>();
        const mintingData = new Map<string, MintingData[]>();

        Logger.log(`Building mint data for ${handleNames.length.toLocaleString()} handles`);
        if (handleNames.length) {
            const mintValues = this.pipeline(() => {
                handleNames.forEach((handleName) => this.getValuesFromIndexedSet(IndexNames.MINT, handleName));
            }) as Set<string>[];

            mintValues.forEach((mintData, index) => {
                mintingData.set(
                    handleNames[index],
                    Array.from(mintData ?? []).map((md) => JSON.parse(md))
                );
            });
        }
        Logger.log(`Built mint data for ${mintingData.size.toLocaleString()} handles`);

        const utxoChunks = chunk(utxos, MAX_SETS_PER_PIPE);
        for (const utxoChunk of utxoChunks) {
            this.pipeline(() => {
                for (const utxo of utxoChunk) {
                    utxoFunctions[UTxOFunctionName.UPDATE_HANDLE_INDEXES](utxo, mintingData, handles, holders);
                    added++;
                }
            })
        }
        
        // Log progress every 10k keys
        if (added % 10000 === 0) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            const rate = (added / ((Date.now() - startTime) / 1000)).toFixed(0);
            Logger.local(`Added: ${added.toLocaleString()} keys (${elapsed}s, ~${rate} keys/sec)`);
        }
        
        const endTime = Date.now();
        const pad = (num: number) => num.toString().padStart(2, '0');
        const seconds = (endTime - startTime) / 1000;
        Logger.log(`Repopulate Handle indexes from UTxOs took ${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`);
    }

    public async tryPopulateFromS3UTxOs(utxoFunctions: UTxOFunctions): Promise<{ slot: number; id: string }> {
        const startTime = Date.now();
        const currentUTxOSchemaVersion = this.getUTxOSchemaVersion();
        const fileName = 'handles_utxos.gz';
        const url = `http://api.handle.me.s3-website-us-west-2.amazonaws.com/${NETWORK}/utxo-snapshot/${this.getUTxOSchemaVersion()}/${fileName}`;

        // Resume-capable loader. Progress marker lives in the namespace as a
        // hash at {api:NETWORK}:snapshot_loader:progress. On fresh start we
        // clearNamespace() and then write an empty progress marker. On resume
        // we skip clearNamespace and pick up from the saved chunk index so a
        // 15-min Lambda timeout doesn't lose progress; the next invocation
        // continues from where we stopped.
        //
        // The marker is tagged with the snapshot's schema version AND block
        // hash. Resuming only happens when both match the current S3 snapshot.
        // A schema bump (or an operator uploading a replacement snapshot) across
        // invocations otherwise causes the next invocation to resume from stale
        // chunk offsets into new-schema data — see correctness-spiral V2.
        const progressKey = `${getApiCacheTag(NETWORK)}:snapshot_loader:progress`;
        type LoaderProgress = { mdIdx: number; utxoIdx: number; utxoSchemaVersion: number; snapshotHash: string };
        const readProgress = (): LoaderProgress | null => {
            const raw = this.redisClientCall('hgetall', progressKey) as Record<string, string> | null;
            if (!raw || Object.keys(raw).length === 0) return null;
            return {
                mdIdx: Number(raw.mdIdx ?? 0),
                utxoIdx: Number(raw.utxoIdx ?? 0),
                utxoSchemaVersion: Number(raw.utxoSchemaVersion ?? 0),
                snapshotHash: `${raw.snapshotHash ?? ''}`
            };
        };
        const writeProgress = (p: LoaderProgress) => {
            this.redisClientCall('hset', progressKey, {
                mdIdx: String(p.mdIdx),
                utxoIdx: String(p.utxoIdx),
                utxoSchemaVersion: String(p.utxoSchemaVersion),
                snapshotHash: p.snapshotHash
            });
        };
        const deleteProgress = () => {
            this.redisClientCall('del', [progressKey]);
        };

        const existing = readProgress();

        // No existing progress = fresh boot (or post-reset). Clean the namespace up-front so
        // any stale keys from a prior deploy don't coexist with whatever we're about to write.
        // If S3 is 404 we fall through and use era-genesis metrics over a cleared namespace.
        if (!existing) {
            Logger.log(`Snapshot loader: fresh start — clearing namespace`);
            this.clearNamespace();
        }

        let id = handleEraBoundaries[NETWORK].id;
        let slot = handleEraBoundaries[NETWORK].slot;
        Logger.log(`Fetching ${url}`);
        const awsResponse = await fetch(url);
        if (awsResponse.status === 200) {
            const buff = await awsResponse.arrayBuffer();
            const unZipPromise = promisify(inflate);
            const result = await unZipPromise(buff);
            const text = result.toString('utf8');
            Logger.log(`Found ${url}`);
            const storedS3HandlesUTxOJson = JSON.parse(text) as VerifiedHandleFileContent;
            const { utxos, slot: s3Slot, mintingData, hash: s3Hash, utxoSchemaVersion, scannedBlocks } = storedS3HandlesUTxOJson;

            // Determine whether to resume or restart. Resuming requires both the schema version
            // and the snapshot hash to match what the progress marker was written against —
            // otherwise the prior invocation's offsets would be applied to new-schema data.
            const progressIsReusable = !!existing
                && existing.utxoSchemaVersion === Number(utxoSchemaVersion)
                && existing.snapshotHash === `${s3Hash}`;
            if (existing && !progressIsReusable) {
                Logger.log({
                    message: `Snapshot loader: discarding progress marker — schemaVersion=${existing.utxoSchemaVersion}→${utxoSchemaVersion} snapshotHash=${existing.snapshotHash}→${s3Hash}`,
                    category: LogCategory.WARN,
                    event: 'snapshotLoader.progressMismatch'
                });
                deleteProgress();
                this.clearNamespace();
            }
            if (progressIsReusable) {
                Logger.log(`Snapshot loader: resuming at mdIdx=${existing!.mdIdx} utxoIdx=${existing!.utxoIdx}`);
            } else {
                writeProgress({ mdIdx: 0, utxoIdx: 0, utxoSchemaVersion: Number(utxoSchemaVersion), snapshotHash: `${s3Hash}` });
            }
            const progress: LoaderProgress = progressIsReusable
                ? existing!
                : { mdIdx: 0, utxoIdx: 0, utxoSchemaVersion: Number(utxoSchemaVersion), snapshotHash: `${s3Hash}` };

            if (utxoSchemaVersion == currentUTxOSchemaVersion && isChainVerifiedSnapshot(storedS3HandlesUTxOJson)) {
                const mintingDataChunks = chunk(Object.entries(mintingData), MAX_SETS_PER_PIPE);
                for (let i = progress.mdIdx; i < mintingDataChunks.length; i++) {
                    const mintingDataChunk = mintingDataChunks[i];
                    this.pipeline(() => {
                        mintingDataChunk.forEach(([handle, mintData]) => {
                            mintData.forEach(md => this.addValueToIndexedSet(IndexNames.MINT, handle, canonicalJsonStringify(md)));
                        });
                    });
                    progress.mdIdx = i + 1;
                    if ((i + 1) % 20 === 0 || i + 1 === mintingDataChunks.length) {
                        writeProgress(progress);
                        Logger.log(`Snapshot loader: mintingData ${progress.mdIdx}/${mintingDataChunks.length} chunks`);
                    }
                }
                writeProgress(progress);

                Logger.log(`Saved minting data for ${Object.keys(mintingData).length.toLocaleString()} handles from S3 snapshot`);

                utxos.sort((a, b) => a.slot - b.slot);

                const utxoChunks = chunk(utxos, MAX_SETS_PER_PIPE);
                const handles = new Map<string, StoredHandle>();
                const holders = new Map<string, HolderHandleNames>();
                const mintData = new Map(Object.entries(mintingData) as [string, MintingData[]][]);
                for (let i = progress.utxoIdx; i < utxoChunks.length; i++) {
                    const utxoChunk = utxoChunks[i];
                    this.pipeline(() => {
                        utxoChunk.forEach((utxo) => {
                            utxoFunctions[UTxOFunctionName.ADD_UTXO](utxo);
                            utxoFunctions[UTxOFunctionName.UPDATE_HANDLE_INDEXES](utxo, mintData, handles, holders);
                        });
                    });
                    progress.utxoIdx = i + 1;
                    if ((i + 1) % 20 === 0 || i + 1 === utxoChunks.length) {
                        writeProgress(progress);
                        Logger.log(`Snapshot loader: utxos ${progress.utxoIdx}/${utxoChunks.length} chunks`);
                    }
                }
                writeProgress(progress);

                Logger.log(`Saved ${utxos.length.toLocaleString()} UTxOs from S3 snapshot`);

                // Restore the scanned-blocks ledger in bulk so processRollback's missed-block
                // drift detection is accurate immediately, rather than having to rebuild after
                // ~20 blocks of forward scanning. Snapshots published before this field existed
                // will simply have no entries; the scan loop populates going forward.
                if (scannedBlocks?.length) {
                    const scannedChunks = chunk(scannedBlocks, MAX_SETS_PER_PIPE);
                    for (const scannedChunk of scannedChunks) {
                        this.addScannedBlocks(scannedChunk);
                    }
                    Logger.log(`Restored ${scannedBlocks.length.toLocaleString()} scanned block hashes from S3 snapshot`);
                }

                id = s3Hash;
                slot = s3Slot;
            } else if (utxoSchemaVersion != currentUTxOSchemaVersion) {
                Logger.log(`Ignoring S3 snapshot schema version ${utxoSchemaVersion}; expected ${currentUTxOSchemaVersion}`);
            } else {
                Logger.log(`Ignoring S3 snapshot ${url} because it is not chain-verified`);
            }
        }
        const endTime = Date.now();
        const pad = (num: number) => num.toString().padStart(2, '0');
        const seconds = (endTime - startTime) / 1000;
        Logger.log(`Populate from S3 took ${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`);

        const metrics = this.getMetrics();
        Logger.log(`UTxO storage starting at slot: ${slot} and hash: ${id} with ${metrics.handleCount} Handles`);

        this.setMetrics({ utxoSchemaVersion: currentUTxOSchemaVersion, indexSchemaVersion: this.getIndexSchemaVersion(), currentBlockHash: id, currentSlot: slot, startTimestamp: Date.now() });
        deleteProgress();
        return { id, slot };
    }

    /**
     * 
     * @param utxoFunctions Functions that are used to set indexes. NOTE: The first function should always be addUtxos
     * @param failed 
     * @returns 
     */
    public async getStartingPoint(utxoFunctions: UTxOFunctions, failed = false): Promise<{ slot: number; id: string } | null> {
        const snapshotsDisabled = NODE_ENV === 'local' || DISABLE_HANDLES_SNAPSHOT == 'true';
        // This should run locally so we're not worried about a long running process
        if (!failed) {
            const { indexSchemaVersion, utxoSchemaVersion, currentSlot, currentBlockHash } = this.getMetrics();

            const currentSchemaVersion = this.getUTxOSchemaVersion();
            if (currentSchemaVersion > (utxoSchemaVersion ?? 0) || !currentBlockHash || !currentSlot) {
                if (snapshotsDisabled) {
                    return null;
                }
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
            if (snapshotsDisabled) {
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
        return this.redisClientCall('get', getApiIndexKey(index, key));
    }

    public setValueOnIndex(index: IndexNames, key: string | number, value: string): void {
        this.redisClientCall('set', getApiIndexKey(index, key), value);
    }

    // #endregion

    // #region HASH INDEXES *************************
    public getIndex(index: IndexNames, options?: SortAndLimitOptions): Map<string | number, ApiIndexType> {
        // SLOT & SLOT_HISTORY uses a an ordered set (ZSET)
        if (ORDERED_SLOTS.includes(index)) {
            return this.parseOrderedSlot(this.redisClientCall('zrangeWithScores', getApiIndexRootKey(index), { start: 0, end: -1 }));
        }
        const command = options ? 'sort' : 'smembers';
        if (options && options?.isAlpha == undefined) options = { ...options, isAlpha: true };
        const keys = this.redisClientCall(command, getApiIndexRootKey(index), options);
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
        return [...this.redisClientCall(command, getApiIndexRootKey(index), options)].map((v) => (isNumeric(v.toString()) && index != IndexNames.HANDLE ? Number(v.toString()) : v.toString()));
    }

    public getHashFromIndex(index: IndexNames, key: string | number): ApiIndexType | undefined {
        return this.rehydrateObjectFromCache(getApiIndexKey(index, key));
    }

    public getHashFieldFromIndex(index: IndexNames, key: string | number, field: string): string | undefined {
        const value = this.redisClientCall('hget', getApiIndexKey(index, key), field);
        if (value == null) return undefined;
        return value.toString();
    }

    public setHashOnIndex(index: IndexNames, key: string | number, value: ApiIndexType): void {
        this.saveObjectToCache(getApiIndexKey(index, key), value);
        if (META_INDEXES.includes(index)) this.redisClientCall('sadd', getApiIndexRootKey(index), [key]);
        if (index == IndexNames.HOLDER) this.addValueToOrderedSet(IndexNames.HOLDER, (value as Holder).handles.length, key as string);
    }

    private removeKeyFromMetaIndex(index: IndexNames, key: string | number) {
        if (META_INDEXES.includes(index)) {
            if (index === IndexNames.HANDLE) {
                this.redisClientCall('srem', getApiIndexRootKey(index), [key]);
                return;
            }
            const count = this.redisClientCall('scard', getApiIndexKey(index, key)) as number;
            if ((RedisHandlesStore._pipeline && count == 1) || !count) this.redisClientCall('srem', getApiIndexRootKey(index), [key]);
        }
    }

    /**
     * 
     * @param index IndexNames
     * @param key string | number
     */
    public removeKeyFromIndex(index: IndexNames, key: string | number): void {
        this.redisClientCall('del', [getApiIndexKey(index, key)]);
        this.removeKeyFromMetaIndex(index, key);
    }

    // #endregion

    // #region SET INDEXES ************************
    public getValuesFromIndexedSet(index: IndexNames, key: string | number, options?: SortAndLimitOptions): Set<string> | undefined {
        const command = options ? 'sort' : 'smembers';
        if (options && options?.isAlpha == undefined) options = { ...options, isAlpha: true };
        return new Set([...(this.redisClientCall(command, getApiIndexKey(index, key), options) ?? [])].map((v) => v.toString()));
    }

    public addValueToIndexedSet(index: IndexNames, key: string | number, value: string): void {
        this.redisClientCall('sadd', getApiIndexKey(index, key), [value]);
        if (META_INDEXES.includes(index)) this.redisClientCall('sadd', getApiIndexRootKey(index), [key]);
    }

    public removeValueFromIndexedSet(index: IndexNames, key: string | number, value: string): void {
        if (key != null) {
            this.redisClientCall('srem', getApiIndexKey(index, key), [value]);
            this.removeKeyFromMetaIndex(index, key);
        }
    }

    // #endregion

    // #region ORDERED INDEXES  ************************

    public getValuesFromOrderedSet(index: IndexNames, ordinal: number, options?: SortAndLimitOptions): ApiIndexType[] | undefined {
        if (ORDERED_SLOTS.includes(index)) {
            return this.parseOrderedSlot(this.redisClientCall('zrangeWithScores', getApiIndexRootKey(index), { type: 'byScore', start: { value: ordinal }, end: { value: ordinal } }))
                .values()
                .toArray();
        }
        const reverse = options?.orderBy?.toUpperCase() == 'DESC';
        return [...this.redisClientCall('zrange', getApiIndexRootKey(index), { ...options, type: 'byScore', start: { value: options?.start ?? (reverse ? Infinity : -Infinity) }, end: { value: options?.end ?? (reverse ? -Infinity : Infinity) } } as SortOptions, { reverse })].map((v) => (isNumeric(v.toString()) ? Number(v.toString()) : v.toString()));
    }

    public addValueToOrderedSet(index: IndexNames, ordinal: number, value: string | ISlotHistory) {
        if (ORDERED_SLOTS.includes(index)) {
            value = `${ordinal}|${JSON.stringify(value)}`;
            this.redisClientCall('zremRangeByScore', getApiIndexRootKey(index), { value: ordinal, isInclusive: true }, { value: ordinal, isInclusive: true });
        }
        this.redisClientCall('zadd', getApiIndexRootKey(index), [{ element: value, score: ordinal as number }]);
        return;
    }

    public removeValuesFromOrderedSet(index: IndexNames, keyOrOrdinal: string | number) {
        if (ORDERED_SLOTS.includes(index)) {
            this.redisClientCall('zremRangeByScore', getApiIndexRootKey(index), '-', { value: keyOrOrdinal, isInclusive: false });
            return;
        }
        this.redisClientCall('zrem', getApiIndexRootKey(index), typeof keyOrOrdinal == 'string' ? keyOrOrdinal : JSON.stringify(keyOrOrdinal));
        return;
    }

    // Scanned-blocks ledger: one ZSET entry per canonical block the scanner has fully processed.
    // score=slot, value=blockHash. Independent of IndexNames because it tracks "blocks seen"
    // rather than "handles/UTxOs we derived from blocks", which is what the other indexes do.
    public recordScannedBlock(slot: number, blockHash: string): void {
        if (!blockHash) return;
        this.redisClientCall('zadd', getApiScannedBlocksKey(), [{ element: blockHash, score: slot }]);
    }

    public addScannedBlocks(entries: { slot: number; hash: string }[]): void {
        if (!entries.length) return;
        this.redisClientCall(
            'zadd',
            getApiScannedBlocksKey(),
            entries.filter(({ hash }) => !!hash).map(({ slot, hash }) => ({ element: hash, score: slot }))
        );
    }

    public getScannedBlockHashesInRange(minSlot: number, maxSlot: number): Set<string> {
        const results = this.redisClientCall('zrange', getApiScannedBlocksKey(), {
            type: 'byScore',
            start: { value: minSlot },
            end: { value: maxSlot }
        }) as GlideString[] | null;
        return new Set((results ?? []).map((v) => v.toString()));
    }

    public listAllScannedBlocks(): { slot: number; hash: string }[] {
        const results = this.redisClientCall('zrangeWithScores', getApiScannedBlocksKey(), { start: 0, end: -1 }) as { score: number; element: GlideString }[] | null;
        return (results ?? []).map(({ score, element }) => ({ slot: Number(score), hash: element.toString() }));
    }

    public trimScannedBlocksToRecent(keep: number): void {
        // Keep the top `keep` highest-score entries (most recent slots). ZREMRANGEBYRANK
        // indices are 0-based; removing [0, -keep-1] leaves the last `keep` entries intact.
        this.redisClientCall('zremRangeByRank', getApiScannedBlocksKey(), 0, -keep - 1);
    }

    public getScoresFromOrderedSet(index: IndexNames, values: string[]): number[] {
        if (!values.length) return [];
        const scores = this.redisClientCall('zmscore', getApiIndexRootKey(index), values) as (number | string | null | undefined)[];
        return scores.map((score) => {
            if (score == null) return 0;
            return Number(score.toString());
        });
    }

    // #endregion

    // #region METRICS *****************************
    public getMetrics(): IApiMetrics {
        const metrics = this.rehydrateObjectFromCache(getApiMetricsKey()) || ({} as IApiMetrics);
        metrics.handleCount = this.count();
        metrics.holderCount = this.holderCount();
        return metrics;
    }

    public setMetrics(metrics: Partial<IApiMetrics>): void {
        const formattedMetrics = Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, String(v)]));
        this.redisClientCall('hset', getApiMetricsKey(), formattedMetrics);
    }

    public getMptRootHash(): string | undefined {
        return this.redisClientCall('get', getApiMptRootHashKey()) || undefined;
    }

    public setMptRootHash(hash: string): void {
        this.redisClientCall('set', getApiMptRootHashKey(), hash);
    }

    public count(): number {
        return this.redisClientCall('scard', getApiIndexRootKey(IndexNames.HANDLE));
    }

    public holderCount(): number {
        return this.redisClientCall('scard', getApiIndexRootKey(IndexNames.HOLDER));
    }

    public getUTxOSchemaVersion(): number {
        return Number(process.env.UTXO_SCHEMA_VERSION);
    }

    public getIndexSchemaVersion(): number {
        return Number(process.env.INDEX_SCHEMA_VERSION);
    }

    // #endregion

    // #region PRIVATE *******************************

    private clearNamespace() {
        let cursor = '0';
        do {
            const [nextCursor, keys] = (this.redisClientCall('scan', cursor, { match: getApiNamespaceScanPattern(), count: 1000 })) as [string, string[]];
            cursor = nextCursor;
            if (keys && keys.length > 0) {
                this.redisClientCall('del', keys);
            }
        } while (cursor !== '0');
    }

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
        const status = Atomics.wait(view, 0, 0, 20_000);
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
