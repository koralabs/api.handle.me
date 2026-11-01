import { ApiIndexType, chunk, Holder, HolderHandleNames, IApiMetrics, IApiStore, IHandleFileContent, IndexNames, ISlotHistory, isNumeric, LogCategory, Logger, MintingData, NETWORK, SortAndLimitOptions, StoredHandle, UTxOFunctionName, UTxOFunctions, UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import { GlideString, HashDataType, SortOptions } from '@valkey/valkey-glide';
import { promisify } from 'util';
import { createHash, randomUUID } from 'crypto';
import { MessageChannel, receiveMessageOnPort, Worker } from 'worker_threads';
import { inflate } from 'zlib';
import { objectStoreConfig } from '@koralabs/kora-labs-common/aws';
import { DISABLE_HANDLES_SNAPSHOT, NODE_ENV, getSnapshotUrl } from '../../config';
import { handleEraBoundaries, MAX_SETS_PER_PIPE, META_INDEXES, ORDERED_SLOTS } from '../../config/constants';
import { getHandleNameFromAssetName } from '../../services/ogmios/utils';
import { canonicalJsonStringify } from '../../utils/helpers';
import { getSnapshotScannerOwner } from '../../utils/snapshotOwnership';
import { validateSnapshot } from '../../utils/verifiedSnapshot';
import { getApiCacheTag, getApiIndexKey, getApiIndexRootKey, getApiIndexScanPattern, getApiMetricsKey, getApiMptRootHashKey, getApiNamespaceScanPattern, getApiRegistryLabelsKey, getApiScannedBlocksKey } from './keys';

// const glideClient = await GlideClient.createClient({
//       addresses: [{ host: 'https://localhost', port: 6379 }],
//       useTLS: process.env.REDIS_USE_TLS ? process.env.REDIS_USE_TLS == 'true' : true
// });

// glideClient.zremRangeByScore('', {value: 0, isInclusive: true})

const redisTimings: Record<string, number> = {};
export class RedisHandlesStore implements IApiStore {
    private static _worker: any;
    private static _id = 0;
    private snapshotFence?: { key: string; owner: string; scannerKey: string; scannerOwner: string; ownsScannerLease: boolean };
    private static _pipeline: [string, any[]][] | undefined = undefined;
    // Per-active-pipeline count of HOLDER SREMs queued (keyed by holder). scard is
    // pipeline-safe but reflects PRE-batch cardinality — it cannot see sibling SREMs queued
    // earlier in the same pipeline. The reverse-list DEL guard subtracts these pending
    // removals so multiple handles of one holder burned in one block don't leave an orphan
    // HOLDER_COUNT entry (or wrongly keep an emptied key). Lives and dies with _pipeline.
    private static _pipelinePendingHolderRemovals: Map<string, number> | undefined = undefined;

    // #region SETUP **************************
    public initialize(): IApiStore {
        objectStoreConfig();
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
        RedisHandlesStore._pipelinePendingHolderRemovals = new Map();
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
            RedisHandlesStore._pipelinePendingHolderRemovals = undefined;
        }
    }

    // Count of HOLDER SREMs queued for `holderAddress` in the active pipeline (0 outside a
    // pipeline). The reverse-list DEL guard subtracts this from the pre-batch scard so it
    // decides "does the live set hold handles beyond the ones this pipeline is removing".
    public getPipelinePendingHolderRemovals(holderAddress: string | number): number {
        return RedisHandlesStore._pipelinePendingHolderRemovals?.get(`${holderAddress}`) ?? 0;
    }

    public destroy(): void {
        this.clearNamespace();
        this.redisClientCall('close');
        RedisHandlesStore._pipeline = undefined;
        RedisHandlesStore._pipelinePendingHolderRemovals = undefined;
        if (RedisHandlesStore._worker.terminate) RedisHandlesStore._worker.terminate();
        RedisHandlesStore._worker = undefined;
    }

    public rollBackToGenesis(): void {
        Logger.log({ message: 'Clearing scoped cache namespace', category: LogCategory.INFO, event: 'this.rollBackToGenesis' });
        this.clearNamespace();
        RedisHandlesStore._pipeline = undefined;
        RedisHandlesStore._pipelinePendingHolderRemovals = undefined;
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
        const url = getSnapshotUrl(NETWORK, currentUTxOSchemaVersion);

        const progressKey = `${getApiCacheTag(NETWORK)}:snapshot_loader:progress`;
        const ownerKey = `${getApiCacheTag(NETWORK)}:snapshot_loader:owner`;
        const scannerKey = `${getApiCacheTag(NETWORK)}:scanner:lease`;
        const readHash = (key: string): Record<string, string> => {
            const raw = this.redisClientCall('hgetall', key);
            return Object.fromEntries(Array.isArray(raw)
                ? raw.map(entry => [String(entry.field ?? entry.key), String(entry.value)])
                : Object.entries(raw ?? {}).map(([key, value]) => [key, String(value)]));
        };
        // Capture before the asynchronous fetch; admission compares these exact images atomically.
        const originalMetrics = readHash(getApiMetricsKey());
        const originalProgress = readHash(progressKey);
        const scannerOwner = this.redisClientCall('get', scannerKey) ?? null;
        if (scannerOwner !== null && scannerOwner !== getSnapshotScannerOwner()) {
            throw new Error('Snapshot scanner lease belongs to another invocation; original cache preserved');
        }
        const existing = Object.keys(originalProgress).length ? originalProgress : null;
        const response = await fetch(url);
        let id: string;
        let slot: number;
        let snapshot: import('../../utils/verifiedSnapshot').VerifiedHandleFileContent | undefined;
        let digest = '';
        if (response.status === 200) {
            const bytes = Buffer.from(await response.arrayBuffer());
            digest = createHash('sha256').update(bytes).digest('hex');
            const candidate: unknown = JSON.parse((await promisify(inflate)(bytes)).toString('utf8'));
            validateSnapshot(candidate, currentUTxOSchemaVersion);
            snapshot = candidate;
            id = candidate.hash;
            slot = candidate.slot;
        } else if (response.status === 404 && !existing && Object.keys(originalMetrics).length === 0) {
            id = handleEraBoundaries[NETWORK].id;
            slot = handleEraBoundaries[NETWORK].slot;
        } else {
            throw new Error(`Snapshot unavailable (${response.status}); original cache preserved`);
        }
        const mintingChunks = snapshot ? chunk(Object.entries(snapshot.mintingData), MAX_SETS_PER_PIPE) : [];
        const utxoChunks = snapshot ? chunk([...snapshot.utxos].sort((a, b) => a.slot - b.slot), MAX_SETS_PER_PIPE) : [];
        let mdIdx = 0;
        let utxoIdx = 0;
        if (existing) {
            mdIdx = Number(existing.mdIdx);
            utxoIdx = Number(existing.utxoIdx);
            if (existing.snapshotDigest !== digest || existing.snapshotHash !== id ||
                Number(existing.utxoSchemaVersion) !== currentUTxOSchemaVersion ||
                !/^\d+$/.test(existing.mdIdx) || !/^\d+$/.test(existing.utxoIdx) ||
                !Number.isSafeInteger(mdIdx) || mdIdx < 0 || mdIdx > mintingChunks.length ||
                !Number.isSafeInteger(utxoIdx) || utxoIdx < 0 || utxoIdx > utxoChunks.length ||
                (utxoIdx > 0 && mdIdx !== mintingChunks.length)) {
                throw new Error('Snapshot progress does not match the complete candidate; original cache preserved');
            }
        }
        const owner = randomUUID();
        const fence = { key: ownerKey, owner, scannerKey, scannerOwner: scannerOwner ?? owner, ownsScannerLease: scannerOwner === null };
        const admitted = this.redisClientCall('snapshotClaim', {
            fence, scannerOriginal: scannerOwner, metricsKey: getApiMetricsKey(), progressKey, originalMetrics, originalProgress,
            // A missing snapshot may initialize genesis ONLY when no original data exists.
            requireEmpty: !snapshot, pattern: getApiNamespaceScanPattern(), dataRoots: this.snapshotDataRoots()
        });
        if (!admitted) throw new Error('Snapshot original image or ownership changed; original cache preserved');
        this.snapshotFence = fence;
        const writeProgress = () => this.redisClientCall('hset', progressKey, {
            mdIdx: String(mdIdx), utxoIdx: String(utxoIdx), utxoSchemaVersion: String(currentUTxOSchemaVersion),
            snapshotHash: id, snapshotDigest: digest
        });
        try {
            if (snapshot) {
                if (!existing) {
                    this.clearNamespace();
                    writeProgress();
                }
                for (; mdIdx < mintingChunks.length;) {
                    this.pipeline(() => {
                        for (const [handle, entries] of mintingChunks[mdIdx]) {
                            for (const md of entries) this.addValueToIndexedSet(IndexNames.MINT, handle, canonicalJsonStringify(md));
                        }
                    });
                    mdIdx++;
                    writeProgress();
                }
                const handles = new Map<string, StoredHandle>();
                const holders = new Map<string, HolderHandleNames>();
                const mintData = new Map(Object.entries(snapshot.mintingData));
                for (; utxoIdx < utxoChunks.length;) {
                    this.pipeline(() => {
                        for (const utxo of utxoChunks[utxoIdx]) {
                            utxoFunctions[UTxOFunctionName.ADD_UTXO](utxo);
                            utxoFunctions[UTxOFunctionName.UPDATE_HANDLE_INDEXES](utxo, mintData, handles, holders);
                        }
                    });
                    utxoIdx++;
                    writeProgress();
                }
                for (const blocks of chunk(snapshot.scannedBlocks ?? [], MAX_SETS_PER_PIPE)) this.addScannedBlocks(blocks);
            }
            this.setMetrics({ utxoSchemaVersion: currentUTxOSchemaVersion, indexSchemaVersion: this.getIndexSchemaVersion(), currentBlockHash: id, currentSlot: slot, startTimestamp: Date.now() });
            this.redisClientCall('del', [progressKey]);
        } finally {
            this.snapshotFence = undefined;
            this.redisClientCall('snapshotRelease', fence);
        }
        const endTime = Date.now();
        const pad = (num: number) => num.toString().padStart(2, '0');
        const seconds = (endTime - startTime) / 1000;
        Logger.log(`Populate from S3 took ${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`);

        const metrics = this.getMetrics();
        Logger.log(`UTxO storage starting at slot: ${slot} and hash: ${id} with ${metrics.handleCount} Handles`);

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

            // An unavailable or invalid candidate is not permission to reset to genesis.
            // Propagate refusal so legacy callers cannot turn it into a destructive fallback.
            return this.tryPopulateFromS3UTxOs(utxoFunctions);
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
            // Record HOLDER removals queued in the active pipeline so the reverse-list DEL
            // guard can subtract them from the pre-batch scard (see _pipelinePendingHolderRemovals).
            if (index === IndexNames.HOLDER && RedisHandlesStore._pipelinePendingHolderRemovals) {
                const pending = RedisHandlesStore._pipelinePendingHolderRemovals;
                pending.set(`${key}`, (pending.get(`${key}`) ?? 0) + 1);
            }
        }
    }

    // Live cardinality of a set index for a specific key (SCARD). Unlike
    // getValuesFromIndexedSet (SMEMBERS), scard is pipeline-safe: redisClientCall lets
    // scard through synchronously even inside a batch (see redisClientCall), so this
    // reflects the live set size mid-pipeline where SMEMBERS would return an empty
    // deferred result. In a batch it reflects state BEFORE the batch's queued SREM/SADD.
    public getIndexedSetSize(index: IndexNames, key: string | number): number {
        if (key == null) return 0;
        return (this.redisClientCall('scard', getApiIndexKey(index, key)) as number) ?? 0;
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

    // WS1 asset-label registry. The derived hash carries only handles with a non-empty label set;
    // an empty set HDELs the field so the map stays small and the root build never pays for the
    // (vast) majority of handles that hold none.
    public setHandleRegistryLabels(name: string, labels: string): void {
        if (labels) {
            this.redisClientCall('hset', getApiRegistryLabelsKey(), { [name]: labels });
        } else {
            this.redisClientCall('hdel', getApiRegistryLabelsKey(), name);
        }
    }

    public getAllHandleRegistryLabels(): Record<string, string> {
        // valkey-glide's hgetall returns HashDataType — a { field, value }[] array of GlideString
        // (Buffer) members, NOT a Record (see rehydrateObjectFromCache, which iterates the same
        // shape). The original code cast it to Record and did registryLabels[handleName], which on
        // an array is always undefined, so buildHandleSetTrie applied no label values and the
        // MPT-root build produced the pre-registry root (calculated == legacy, never matching chain).
        // Iterate the array and decode each field/value to a plain string into a null-prototype map
        // (so a handle named like an Object.prototype member can't resolve to an inherited function).
        // The `else` branch tolerates a Record shape too (batch hgetall returns one — see line ~705).
        const raw = this.redisClientCall('hgetall', getApiRegistryLabelsKey()) as HashDataType | Record<string, GlideString> | null;
        const out: Record<string, string> = Object.create(null);
        if (Array.isArray(raw)) {
            for (const { field, value } of raw) {
                out[`${field}`] = `${value ?? ''}`;
            }
        } else if (raw) {
            for (const [name, value] of Object.entries(raw)) {
                out[name] = `${value ?? ''}`;
            }
        }
        return out;
    }

    public count(): number {
        return this.redisClientCall('scard', getApiIndexRootKey(IndexNames.HANDLE));
    }

    public holderCount(): number {
        return this.redisClientCall('scard', getApiIndexRootKey(IndexNames.HOLDER));
    }

    public getUTxOSchemaVersion(): number {
        return this.requireSchemaVersion('UTXO_SCHEMA_VERSION');
    }

    public getIndexSchemaVersion(): number {
        return this.requireSchemaVersion('INDEX_SCHEMA_VERSION');
    }

    // Resolve a schema-version env var, throwing if it is unset/invalid instead of returning
    // NaN. An unset UTXO_SCHEMA_VERSION previously made tryPopulateFromS3UTxOs() build the URL
    // `${SNAPSHOT_BASE_URL}/${NETWORK}/utxo-snapshot/NaN/handles_utxos.gz`, fetch an empty
    // object, and clearNamespace() — silently WIPING the handle index. Failing loud here
    // aborts before clearNamespace() runs, so a misconfigured deploy can't destroy the index.
    private requireSchemaVersion(envName: 'UTXO_SCHEMA_VERSION' | 'INDEX_SCHEMA_VERSION'): number {
        const raw = process.env[envName];
        const value = Number(raw);
        if (raw === undefined || raw === '' || !Number.isInteger(value) || value < 1) {
            throw new Error(
                `${envName} must be a positive integer (got ${JSON.stringify(raw)}). ` +
                    `Refusing to proceed: an unset/invalid schema version resolves the snapshot URL to ` +
                    `'.../utxo-snapshot/NaN/...', which loads an empty snapshot and wipes the handle index.`
            );
        }
        return value;
    }

    // #endregion

    // #region PRIVATE *******************************

    private snapshotDataRoots(): string[] {
        return [...Object.values(IndexNames).map(index => getApiIndexRootKey(index)), getApiMetricsKey(),
            getApiMptRootHashKey(), getApiRegistryLabelsKey(), getApiScannedBlocksKey()];
    }

    private clearNamespace() {
        let cursor = '0';
        do {
            const [nextCursor, keys] = (this.redisClientCall('scan', cursor, { match: getApiNamespaceScanPattern(), count: 1000 })) as [string, string[]];
            cursor = nextCursor;
            const dataKeys = (keys ?? []).filter(key => this.snapshotDataRoots().some(root => key === root || key.startsWith(`${root}:`)));
            if (dataKeys.length > 0) this.redisClientCall('del', dataKeys);
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
        RedisHandlesStore._worker.postMessage({ id, sab, payload: { id, cmd, args, fence: this.snapshotFence }, reply: port2 }, [port2]);

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

// Shared factory for contexts without an Express `req.app` registry to reach
// through (Lambda entrypoints, scripts, snapshot verification utilities).
// Returns a fresh instance per call to preserve the original construction
// semantics — heavy state (worker, pipeline) is class-static so multiple
// instances coexist cheaply. Tests can swap the factory via
// setHandlesStoreFactory.
let _handlesStoreFactory: () => RedisHandlesStore = () => new RedisHandlesStore();

export const getHandlesStore = (): RedisHandlesStore => _handlesStoreFactory();

export const setHandlesStoreFactory = (factory: () => RedisHandlesStore): void => {
    _handlesStoreFactory = factory;
};

export const resetHandlesStoreForTest = (): void => {
    _handlesStoreFactory = () => new RedisHandlesStore();
};
