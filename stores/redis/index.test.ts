import { IndexNames, Logger, UTxOFunctionName } from '@koralabs/kora-labs-common';
import { deflateSync } from 'zlib';
import { ORDERED_SLOTS } from '../../config/constants';
import { RedisHandlesStore } from './index';
import { Worker } from 'worker_threads';

jest.mock('worker_threads', () => {
    const actual = jest.requireActual('worker_threads');
    return {
        ...actual,
        Worker: jest.fn().mockImplementation(() => ({
            on: jest.fn(),
            terminate: jest.fn(),
            postMessage: jest.fn()
        }))
    };
});

describe('RedisHandlesStore critical path tests', () => {
    const originalFetch = global.fetch;
    const originalOrderedSlots = [...ORDERED_SLOTS];

    afterEach(() => {
        global.fetch = originalFetch;
        ORDERED_SLOTS.splice(0, ORDERED_SLOTS.length, ...originalOrderedSlots);
        (RedisHandlesStore as any)._worker = undefined;
        (RedisHandlesStore as any)._pipeline = undefined;
        jest.restoreAllMocks();
    });

    it('initializes a worker once and handles worker lifecycle hooks', () => {
        const store = new RedisHandlesStore();
        const redisSpy = jest.spyOn(store as any, 'redisClientCall').mockImplementation(jest.fn());
        const loggerSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());
        const workerCtor = Worker as unknown as jest.Mock;

        expect(store.initialize()).toBe(store);
        expect(workerCtor).toHaveBeenCalledWith('./workers/redisSync.worker.js');

        const worker = (RedisHandlesStore as any)._worker;
        const errorHandler = worker.on.mock.calls.find((call: any[]) => call[0] === 'error')?.[1];
        const exitHandler = worker.on.mock.calls.find((call: any[]) => call[0] === 'exit')?.[1];

        errorHandler('boom');
        exitHandler(1);
        expect(loggerSpy).toHaveBeenCalledWith(expect.objectContaining({ event: 'ValkeySyncWorker.Error' }));
        expect(loggerSpy).not.toHaveBeenCalledWith(expect.objectContaining({ event: 'ValkeySyncWorker.Exit' }));

        exitHandler(2);
        expect(loggerSpy).toHaveBeenCalledWith(expect.objectContaining({ event: 'ValkeySyncWorker.Exit' }));

        store.initialize();
        expect(workerCtor).toHaveBeenCalledTimes(1);

        store.rollBackToGenesis();
        store.destroy();
        expect(redisSpy).toHaveBeenCalledWith('flushdb');
        expect(redisSpy).toHaveBeenCalledWith('close');
        expect(worker.terminate).toHaveBeenCalled();
        expect((RedisHandlesStore as any)._worker).toBeUndefined();
    });

    it('returns empty results when a pipeline has no commands', () => {
        const store = new RedisHandlesStore();
        const redisSpy = jest.spyOn(store as any, 'redisClientCall').mockImplementation(jest.fn());

        const results = store.pipeline(() => {});

        expect(results).toEqual([]);
        expect(redisSpy).not.toHaveBeenCalled();
    });

    it('falls back to an empty command list when pipeline queue is cleared mid-call', () => {
        const store = new RedisHandlesStore();
        const redisSpy = jest.spyOn(store as any, 'redisClientCall').mockImplementation(jest.fn());

        const result = store.pipeline(() => {
            (RedisHandlesStore as any)._pipeline = undefined;
        });

        expect(result).toEqual([]);
        expect(redisSpy).not.toHaveBeenCalled();
    });

    it('rehydrates hgetall results returned from batch pipeline calls', () => {
        const store = new RedisHandlesStore();
        const redisSpy = jest.spyOn(store as any, 'redisClientCall').mockImplementation((...args: any[]) => {
            const [cmd] = args as [string];
            if (cmd === 'batch') {
                return [[{ key: { toString: () => 'name' }, value: { toString: () => '"alpha"' } }], 'ok'];
            }
            return undefined;
        });
        const rehydrateSpy = jest.spyOn(store as any, 'rehydrateObject').mockReturnValue({ name: 'alpha' });

        const result = store.pipeline(() => {
            (RedisHandlesStore as any)._pipeline.push(['hgetall', ['{root}:handle:alpha']]);
            (RedisHandlesStore as any)._pipeline.push(['set', ['x', '1']]);
        });

        expect(redisSpy).toHaveBeenCalledWith('batch', [
            ['hgetall', ['{root}:handle:alpha']],
            ['set', ['x', '1']]
        ]);
        expect(rehydrateSpy).toHaveBeenCalledWith('{root}:handle:alpha', expect.any(Array));
        expect(result).toEqual([{ name: 'alpha' }, 'ok']);
    });

    it('repopulates indexes from stored UTxOs', () => {
        const store = new RedisHandlesStore();
        jest.spyOn(store as any, 'redisClientCall').mockImplementation((cmd: any) => {
            if (cmd === 'scan') return ['0', []];
            return undefined;
        });
        jest.spyOn(store, 'getValuesFromOrderedSet').mockReturnValue(['utxo#0'] as any);
        jest.spyOn(store, 'getHashFromIndex').mockReturnValue({ id: 'utxo#0', slot: 1 } as any);
        jest.spyOn(store, 'getKeysFromIndex').mockReturnValue(['alpha'] as any);

        let callCount = 0;
        jest.spyOn(store, 'pipeline').mockImplementation((commands: CallableFunction) => {
            callCount += 1;
            commands();
            if (callCount === 1) return [{ id: 'utxo#0', slot: 1, handles: [['policy', ['616c706861']]] }];
            if (callCount === 2) return [new Set([JSON.stringify({ created_slot: 1, metadata: {}, txHash: 'txhash' })])];
            return [];
        });

        const updateHandleIndexes = jest.fn();
        store.repopulateIndexesFromUTxOs({
            [UTxOFunctionName.UPDATE_HANDLE_INDEXES]: updateHandleIndexes
        } as any);

        expect(updateHandleIndexes).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'utxo#0' }),
            expect.objectContaining({
                get: expect.any(Function)
            }),
            expect.any(Map),
            expect.any(Map)
        );
        const mintingDataArg = updateHandleIndexes.mock.calls[0][1] as Map<string, any[]>;
        expect(mintingDataArg.get('alpha')).toEqual([
            expect.objectContaining({
                created_slot: 1,
                txHash: 'txhash'
            })
        ]);
    });

    it('repopulates indexes when mint data lookup returns undefined values', () => {
        const store = new RedisHandlesStore();
        jest.spyOn(store as any, 'redisClientCall').mockImplementation((cmd: any) => {
            if (cmd === 'scan') return ['0', []];
            return undefined;
        });
        jest.spyOn(store, 'getValuesFromOrderedSet').mockReturnValue(['utxo#0'] as any);

        let callCount = 0;
        jest.spyOn(store, 'pipeline').mockImplementation((commands: CallableFunction) => {
            callCount += 1;
            commands();
            if (callCount === 1) {
                return [{ id: 'utxo#0', slot: 1, handles: [['policy', [Buffer.from('alpha').toString('hex')]]] }];
            }
            if (callCount === 2) return [undefined];
            return [];
        });

        const updateHandleIndexes = jest.fn();
        store.repopulateIndexesFromUTxOs({
            [UTxOFunctionName.UPDATE_HANDLE_INDEXES]: updateHandleIndexes
        } as any);

        const mintingDataArg = updateHandleIndexes.mock.calls[0][1] as Map<string, any[]>;
        expect(mintingDataArg.get('alpha')).toEqual([]);
    });

    it('populates from S3 snapshot and replays UTxOs through callbacks', async () => {
        const store = new RedisHandlesStore();
        const setMetricsSpy = jest.spyOn(store, 'setMetrics').mockImplementation(jest.fn());
        jest.spyOn(store, 'getMetrics').mockReturnValue({ handleCount: 1 } as any);
        jest.spyOn(store, 'getUTxOSchemaVersion').mockReturnValue(1);
        jest.spyOn(store as any, 'redisClientCall').mockImplementation(() => undefined);
        jest.spyOn(store, 'pipeline').mockImplementation((commands: CallableFunction) => {
            commands();
            return [];
        });

        const snapshot = {
            utxos: [
                {
                    id: 'utxo_s3#0',
                    tx_id: 'utxo_s3',
                    index: 0,
                    slot: 11,
                    address: 'addr_test1xyz',
                    lovelace: 1,
                    handles: [],
                    mint: [],
                    metadata: {},
                    blockHash: 'hash',
                    blockNum: 1
                }
            ],
            slot: 11,
            hash: 's3_block_hash',
            mintingData: {
                alpha: [{ created_slot: 11, metadata: {}, txHash: 'txhash' }]
            },
            utxoSchemaVersion: 1
        };
        const compressed = deflateSync(Buffer.from(JSON.stringify(snapshot)));
        const ab = compressed.buffer.slice(compressed.byteOffset, compressed.byteOffset + compressed.byteLength);

        global.fetch = jest.fn().mockResolvedValue({
            status: 200,
            arrayBuffer: async () => ab
        }) as any;

        const addUtxo = jest.fn();
        const updateHandleIndexes = jest.fn();
        const result = await store.tryPopulateFromS3UTxOs({
            [UTxOFunctionName.ADD_UTXO]: addUtxo,
            [UTxOFunctionName.UPDATE_HANDLE_INDEXES]: updateHandleIndexes
        } as any);

        expect(result).toEqual({ id: 's3_block_hash', slot: 11 });
        expect(addUtxo).toHaveBeenCalledWith(expect.objectContaining({ id: 'utxo_s3#0' }));
        expect(updateHandleIndexes).toHaveBeenCalled();
        expect(setMetricsSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                currentBlockHash: 's3_block_hash',
                currentSlot: 11,
                utxoSchemaVersion: 1
            })
        );
    });

    it('getStartingPoint uses snapshot path when schema/version requires refresh', async () => {
        const store = new RedisHandlesStore();
        jest.spyOn(store, 'getMetrics').mockReturnValue({
            utxoSchemaVersion: 0,
            currentSlot: 0,
            currentBlockHash: ''
        } as any);
        jest.spyOn(store, 'getUTxOSchemaVersion').mockReturnValue(1);
        const snapshotSpy = jest.spyOn(store, 'tryPopulateFromS3UTxOs').mockResolvedValue({ id: 'snapshot_hash', slot: 25 });

        const startingPoint = await store.getStartingPoint({} as any, false);

        expect(snapshotSpy).toHaveBeenCalled();
        expect(startingPoint).toEqual({ id: 'snapshot_hash', slot: 25 });
    });

    it('getStartingPoint uses default failed=false and schema fallback values', async () => {
        const store = new RedisHandlesStore();
        jest.spyOn(store, 'getMetrics').mockReturnValue({
            currentSlot: 5,
            currentBlockHash: 'existing_hash'
        } as any);
        jest.spyOn(store, 'getUTxOSchemaVersion').mockReturnValue(1);
        const snapshotSpy = jest.spyOn(store, 'tryPopulateFromS3UTxOs').mockResolvedValue({ id: 'snapshot_hash', slot: 25 });

        const startingPoint = await store.getStartingPoint({} as any);

        expect(snapshotSpy).toHaveBeenCalled();
        expect(startingPoint).toEqual({ id: 'snapshot_hash', slot: 25 });
    });

    it('getStartingPoint repopulates indexes when only index schema changed', async () => {
        const store = new RedisHandlesStore();
        jest.spyOn(store, 'getMetrics').mockReturnValue({
            indexSchemaVersion: 1,
            utxoSchemaVersion: 2,
            currentSlot: 99,
            currentBlockHash: 'current_hash'
        } as any);
        jest.spyOn(store, 'getUTxOSchemaVersion').mockReturnValue(2);
        jest.spyOn(store, 'getIndexSchemaVersion').mockReturnValue(3);
        const repopulateSpy = jest.spyOn(store, 'repopulateIndexesFromUTxOs').mockImplementation(jest.fn());
        const setMetricsSpy = jest.spyOn(store, 'setMetrics').mockImplementation(jest.fn());

        const startingPoint = await store.getStartingPoint({} as any, false);

        expect(repopulateSpy).toHaveBeenCalled();
        expect(setMetricsSpy).toHaveBeenCalledWith({ indexSchemaVersion: 3 });
        expect(startingPoint).toEqual({ id: 'current_hash', slot: 99 });
    });

    it('repopulates indexes when index schema fallback defaults to zero', async () => {
        const store = new RedisHandlesStore();
        jest.spyOn(store, 'getMetrics').mockReturnValue({
            utxoSchemaVersion: 2,
            currentSlot: 99,
            currentBlockHash: 'current_hash'
        } as any);
        jest.spyOn(store, 'getUTxOSchemaVersion').mockReturnValue(2);
        jest.spyOn(store, 'getIndexSchemaVersion').mockReturnValue(1);
        const repopulateSpy = jest.spyOn(store, 'repopulateIndexesFromUTxOs').mockImplementation(jest.fn());
        const setMetricsSpy = jest.spyOn(store, 'setMetrics').mockImplementation(jest.fn());

        const startingPoint = await store.getStartingPoint({} as any);

        expect(repopulateSpy).toHaveBeenCalled();
        expect(setMetricsSpy).toHaveBeenCalledWith({ indexSchemaVersion: 1 });
        expect(startingPoint).toEqual({ id: 'current_hash', slot: 99 });
    });

    it('getStartingPoint returns null on failed retry snapshot error', async () => {
        const store = new RedisHandlesStore();
        jest.spyOn(store, 'tryPopulateFromS3UTxOs').mockRejectedValue(new Error('network down'));

        const startingPoint = await store.getStartingPoint({} as any, true);

        expect(startingPoint).toBeNull();
    });

    it('getStartingPoint returns retry snapshot point when failed path succeeds', async () => {
        const store = new RedisHandlesStore();
        jest.spyOn(store, 'tryPopulateFromS3UTxOs').mockResolvedValue({ id: 'retry_hash', slot: 123 });

        const startingPoint = await store.getStartingPoint({} as any, true);

        expect(startingPoint).toEqual({ id: 'retry_hash', slot: 123 });
    });

    it('getStartingPoint returns null on failed path when snapshots are disabled', async () => {
        let startingPoint: { id: string; slot: number } | null = { id: 'unexpected', slot: -1 };

        await jest.isolateModulesAsync(async () => {
            jest.doMock('../../config', () => ({
                ...jest.requireActual('../../config'),
                NODE_ENV: 'test',
                DISABLE_HANDLES_SNAPSHOT: 'true'
            }));
            const { RedisHandlesStore: IsolatedStore } = await import('./index');
            const isolatedStore = new IsolatedStore();
            startingPoint = await isolatedStore.getStartingPoint({} as any, true);
            jest.dontMock('../../config');
        });

        expect(startingPoint).toBeNull();
    });

    it('parses ordered-slot indexes and ordered-slot lookups', () => {
        const store = new RedisHandlesStore();
        ORDERED_SLOTS.push(IndexNames.SLOT);
        const redisSpy = jest.spyOn(store as any, 'redisClientCall').mockImplementation((...args: any[]) => {
            const [cmd] = args as [string];
            if (cmd === 'zrangeWithScores') {
                return [{ score: 10, element: { toString: () => '10|{"id":"some_handle"}' } }];
            }
            return [];
        });

        const fullIndex = store.getIndex(IndexNames.SLOT);
        const slotValues = store.getValuesFromOrderedSet(IndexNames.SLOT, 10);

        expect(fullIndex.get(10)).toEqual({ id: 'some_handle' });
        expect(slotValues).toEqual([{ id: 'some_handle' }]);
        expect(redisSpy).toHaveBeenCalledWith('zrangeWithScores', '{root}:slot', expect.any(Object));
    });

    it('uses sort with default alpha and set/hash helper methods', () => {
        const store = new RedisHandlesStore();
        const redisSpy = jest.spyOn(store as any, 'redisClientCall').mockImplementation((...args: any[]) => {
            const [cmd, key] = args as [string, string];
            if (cmd === 'sort' && key === '{root}:handle') return ['a', 'b'];
            if (cmd === 'sort' && key === '{root}:holder') return ['1', '2'];
            if (cmd === 'get') return 'value';
            return [];
        });
        jest.spyOn(store, 'getHashFromIndex').mockImplementation((index: IndexNames, key: string | number) => {
            if (index === IndexNames.HANDLE && key === 'a') return { id: 'alpha' } as any;
            if (index === IndexNames.HANDLE && key === 'b') return undefined;
            return undefined;
        });

        const index = store.getIndex(IndexNames.HANDLE, { orderBy: 'ASC' } as any);
        const keys = store.getKeysFromIndex(IndexNames.HOLDER, { orderBy: 'ASC' } as any);
        const value = store.getValueFromIndex(IndexNames.RARITY, 'basic');
        store.setValueOnIndex(IndexNames.RARITY, 'basic', '1');

        expect(index).toEqual(new Map([['a', { id: 'alpha' }]]));
        expect(keys).toEqual([1, 2]);
        expect(value).toBe('value');
        expect(redisSpy).toHaveBeenCalledWith('sort', '{root}:handle', expect.objectContaining({ isAlpha: true }));
        expect(redisSpy).toHaveBeenCalledWith('set', '{root}:rarity:basic', '1');
    });

    it('uses smembers and keeps string values for handle keys without sort options', () => {
        const store = new RedisHandlesStore();
        const redisSpy = jest.spyOn(store as any, 'redisClientCall').mockImplementation((...args: any[]) => {
            const [cmd] = args as [string];
            if (cmd === 'smembers') return ['1', 'alpha'];
            return [];
        });

        const keys = store.getKeysFromIndex(IndexNames.HANDLE);

        expect(keys).toEqual(['1', 'alpha']);
        expect(redisSpy).toHaveBeenCalledWith('smembers', '{root}:handle', undefined);
    });

    it('handles ordered-set add/remove and schema-version getters', () => {
        const store = new RedisHandlesStore();
        ORDERED_SLOTS.push(IndexNames.SLOT);
        const redisSpy = jest.spyOn(store as any, 'redisClientCall').mockImplementation(jest.fn());
        process.env.UTXO_SCHEMA_VERSION = '9';
        process.env.INDEX_SCHEMA_VERSION = '4';

        store.addValueToOrderedSet(IndexNames.SLOT, 15, 'handle_name');
        store.removeValuesFromOrderedSet(IndexNames.SLOT, 15);
        store.addValueToOrderedSet(IndexNames.HOLDER, 1, 'holder');
        store.removeValuesFromOrderedSet(IndexNames.HOLDER, 'holder');

        expect(store.getUTxOSchemaVersion()).toBe(9);
        expect(store.getIndexSchemaVersion()).toBe(4);
        expect(redisSpy).toHaveBeenCalledWith('zremRangeByScore', '{root}:slot', { value: 15, isInclusive: true }, { value: 15, isInclusive: true });
        expect(redisSpy).toHaveBeenCalledWith('zremRangeByScore', '{root}:slot', '-', { value: 15, isInclusive: false });
        expect(redisSpy).toHaveBeenCalledWith('zrem', '{root}:holder', 'holder');
    });

    it('rehydrates hash objects with json and non-json values', () => {
        const store = new RedisHandlesStore();
        jest.spyOn(store as any, 'redisClientCall').mockImplementation((...args: any[]) => {
            const [cmd] = args as [string];
            if (cmd === 'hgetall') {
                return [
                    { field: { toString: () => 'name' }, value: { toString: () => 'alpha' } },
                    { field: { toString: () => 'enabled' }, value: { toString: () => 'true' } },
                    { field: { toString: () => 'raw' }, value: { toString: () => 'plain-value' } }
                ];
            }
            return undefined;
        });

        const value = store.getHashFromIndex(IndexNames.HANDLE, 'alpha');

        expect(value).toEqual({ name: 'alpha', enabled: true, raw: 'plain-value' });
    });

    it('formats metrics and primitive hash fields before saving', () => {
        const store = new RedisHandlesStore();
        const redisSpy = jest.spyOn(store as any, 'redisClientCall').mockImplementation((...args: any[]) => {
            const [cmd, key] = args as [string, string];
            if (cmd === 'scard' && key === '{root}:handle') return 9;
            if (cmd === 'scard' && key === '{root}:holder') return 4;
            return undefined;
        });

        store.setMetrics({ currentSlot: 1, currentBlockHash: 'abc' });
        (store as any).saveObjectToCache('custom:key', { count: 1, active: true, label: 'x' });
        expect(store.count()).toBe(9);
        expect(store.holderCount()).toBe(4);
        expect(redisSpy).toHaveBeenCalledWith('hset', 'metrics', { currentSlot: '1', currentBlockHash: 'abc' });
        expect(redisSpy).toHaveBeenCalledWith('hset', 'custom:key', { count: '1', active: 'true', label: 'x' });
    });

    it('throws when trying to save non-object values into hash cache', () => {
        const store = new RedisHandlesStore();
        jest.spyOn(store as any, 'redisClientCall').mockImplementation(jest.fn());

        expect(() => (store as any).saveObjectToCache('bad:key', ['not', 'object'])).toThrow('saveObjectToCache only supports plain objects');
    });

    it('removes set values and prunes meta indexes when sets are emptied', () => {
        const store = new RedisHandlesStore();
        const redisSpy = jest.spyOn(store as any, 'redisClientCall').mockImplementation((...args: any[]) => {
            const [cmd] = args as [string];
            if (cmd === 'scard') return 0;
            return undefined;
        });

        store.removeValueFromIndexedSet(IndexNames.HANDLE, 'alpha', 'handle-id');

        expect(redisSpy).toHaveBeenCalledWith('srem', '{root}:handle:alpha', ['handle-id']);
        expect(redisSpy).toHaveBeenCalledWith('srem', '{root}:handle', ['alpha']);
    });

    it('adds meta keys when writing to indexed sets under meta indexes', () => {
        const store = new RedisHandlesStore();
        const redisSpy = jest.spyOn(store as any, 'redisClientCall').mockImplementation(jest.fn());

        store.addValueToIndexedSet(IndexNames.HANDLE, 'alpha', 'alpha-id');

        expect(redisSpy).toHaveBeenCalledWith('sadd', '{root}:handle:alpha', ['alpha-id']);
        expect(redisSpy).toHaveBeenCalledWith('sadd', '{root}:handle', ['alpha']);
    });

    it('removes handle meta entries without scard checks on hash keys', () => {
        const store = new RedisHandlesStore();
        (RedisHandlesStore as any)._pipeline = [];
        const redisSpy = jest.spyOn(store as any, 'redisClientCall').mockImplementation(jest.fn());

        store.removeKeyFromIndex(IndexNames.HANDLE, 'alpha');

        expect(redisSpy).toHaveBeenCalledWith('del', ['{root}:handle:alpha']);
        expect(redisSpy).toHaveBeenCalledWith('srem', '{root}:handle', ['alpha']);
        expect(redisSpy).not.toHaveBeenCalledWith('scard', '{root}:handle:alpha');
    });

    it('repopulates indexes when scan returns deletable keys', () => {
        const store = new RedisHandlesStore();
        const scannedKeys = Array.from({ length: 100000 }, (_, index) => `{root}:character:${index}`);
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation(jest.fn());
        let scanCount = 0;
        const redisSpy = jest.spyOn(store as any, 'redisClientCall').mockImplementation((...args: any[]) => {
            const [cmd] = args as [string];
            if (cmd === 'scan') {
                scanCount += 1;
                return scanCount === 1 ? ['0', scannedKeys] : ['0', []];
            }
            return undefined;
        });
        jest.spyOn(store, 'getValuesFromOrderedSet').mockReturnValue([] as any);
        jest.spyOn(store, 'getKeysFromIndex').mockReturnValue([] as any);
        jest.spyOn(store, 'pipeline').mockImplementation((commands: CallableFunction) => {
            commands();
            return [];
        });

        store.repopulateIndexesFromUTxOs({
            [UTxOFunctionName.UPDATE_HANDLE_INDEXES]: jest.fn()
        } as any);

        expect(redisSpy).toHaveBeenCalledWith('del', [`{root}:${IndexNames.HOLDER_COUNT}`]);
        expect(redisSpy).toHaveBeenCalledWith('del', scannedKeys);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Deleted: 100,000 keys'));
    });

    it('logs scan deletion progress when modulo threshold is crossed by key batch size', () => {
        const store = new RedisHandlesStore();
        const keysA = Array.from({ length: 99999 }, (_, index) => `{root}:character:${index}`);
        const keysB = Array.from({ length: 5 }, (_, index) => `{root}:character:b${index}`);
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation(jest.fn());
        let scanCount = 0;
        jest.spyOn(store as any, 'redisClientCall').mockImplementation((...args: any[]) => {
            const [cmd] = args as [string];
            if (cmd === 'scan') {
                scanCount += 1;
                if (scanCount === 1) return ['1', keysA];
                if (scanCount === 2) return ['0', keysB];
                return ['0', []];
            }
            return undefined;
        });
        jest.spyOn(store, 'getValuesFromOrderedSet').mockReturnValue([] as any);
        jest.spyOn(store, 'getKeysFromIndex').mockReturnValue([] as any);
        jest.spyOn(store, 'pipeline').mockImplementation((commands: CallableFunction) => {
            commands();
            return [];
        });

        store.repopulateIndexesFromUTxOs({
            [UTxOFunctionName.UPDATE_HANDLE_INDEXES]: jest.fn()
        } as any);

        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Deleted: 100,004 keys'));
    });

    it('handles repopulation with no indexed UTxO slots', () => {
        const store = new RedisHandlesStore();
        const consoleSpy = jest.spyOn(console, 'log').mockImplementation(jest.fn());
        const updateHandleIndexes = jest.fn();
        jest.spyOn(store as any, 'redisClientCall').mockImplementation((...args: any[]) => {
            const [cmd] = args as [string];
            if (cmd === 'scan') return ['0', []];
            return undefined;
        });
        jest.spyOn(store, 'getValuesFromOrderedSet').mockReturnValue(undefined as any);
        jest.spyOn(store, 'getKeysFromIndex').mockReturnValue([] as any);
        jest.spyOn(store, 'pipeline').mockImplementation((commands: CallableFunction) => {
            commands();
            return [];
        });

        store.repopulateIndexesFromUTxOs({
            [UTxOFunctionName.UPDATE_HANDLE_INDEXES]: updateHandleIndexes
        } as any);

        expect(updateHandleIndexes).not.toHaveBeenCalled();
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Added: 0 keys'));
    });

    it('uses smembers when retrieving index keys without sort options', () => {
        const store = new RedisHandlesStore();
        const redisSpy = jest.spyOn(store as any, 'redisClientCall').mockImplementation((...args: any[]) => {
            const [cmd, key] = args as [string, string];
            if (cmd === 'smembers' && key === '{root}:handle') return ['alpha'];
            return [];
        });
        jest.spyOn(store, 'getHashFromIndex').mockReturnValue({ id: 'alpha' } as any);

        const index = store.getIndex(IndexNames.HANDLE);

        expect(index).toEqual(new Map([['alpha', { id: 'alpha' }]]));
        expect(redisSpy).toHaveBeenCalledWith('smembers', '{root}:handle', undefined);
    });

    it('uses sorted indexed-set lookup with default alpha', () => {
        const store = new RedisHandlesStore();
        const redisSpy = jest.spyOn(store as any, 'redisClientCall').mockImplementation((...args: any[]) => {
            const [cmd] = args as [string];
            if (cmd === 'sort') return ['beta', 'alpha'];
            return [];
        });

        const values = store.getValuesFromIndexedSet(IndexNames.HOLDER, 'stake1', { orderBy: 'ASC' } as any);

        expect(values).toEqual(new Set(['beta', 'alpha']));
        expect(redisSpy).toHaveBeenCalledWith('sort', '{root}:holder:stake1', expect.objectContaining({ isAlpha: true }));
    });

    it('adds holder hashes to ordered holder index', () => {
        const store = new RedisHandlesStore();
        jest.spyOn(store as any, 'redisClientCall').mockImplementation(jest.fn());
        const addValueToOrderedSetSpy = jest.spyOn(store, 'addValueToOrderedSet').mockImplementation(jest.fn());

        store.setHashOnIndex(IndexNames.HOLDER, 'stake1', { handles: ['a', 'b'] } as any);

        expect(addValueToOrderedSetSpy).toHaveBeenCalledWith(IndexNames.HOLDER, 2, 'stake1');
    });

    it('uses ordered-set start and end defaults for asc and desc queries', () => {
        const store = new RedisHandlesStore();
        const redisSpy = jest.spyOn(store as any, 'redisClientCall').mockImplementation((...args: any[]) => {
            const [cmd] = args as [string];
            if (cmd === 'zrange') return ['holder_a'];
            return [];
        });

        store.getValuesFromOrderedSet(IndexNames.HOLDER, 0);
        store.getValuesFromOrderedSet(IndexNames.HOLDER, 0, { orderBy: 'DESC' } as any);

        expect(redisSpy).toHaveBeenNthCalledWith(
            1,
            'zrange',
            '{root}:holder',
            expect.objectContaining({
                start: { value: -Infinity },
                end: { value: Infinity }
            }),
            { reverse: false }
        );
        expect(redisSpy).toHaveBeenNthCalledWith(
            2,
            'zrange',
            '{root}:holder',
            expect.objectContaining({
                start: { value: Infinity },
                end: { value: -Infinity }
            }),
            { reverse: true }
        );
    });

    it('converts numeric ordered-set values and supports numeric zrem keys', () => {
        const store = new RedisHandlesStore();
        const redisSpy = jest.spyOn(store as any, 'redisClientCall').mockImplementation((...args: any[]) => {
            const [cmd] = args as [string];
            if (cmd === 'zrange') return ['42'];
            return undefined;
        });

        const values = store.getValuesFromOrderedSet(IndexNames.HOLDER, 0);
        store.removeValuesFromOrderedSet(IndexNames.HOLDER, 7);

        expect(values).toEqual([42]);
        expect(redisSpy).toHaveBeenCalledWith('zrem', '{root}:holder', '7');
    });

    it('reads ordered-set scores for members', () => {
        const store = new RedisHandlesStore();
        const redisSpy = jest.spyOn(store as any, 'redisClientCall').mockImplementation((...args: any[]) => {
            const [cmd] = args as [string];
            if (cmd === 'zmscore') return ['4', null, '11'];
            return [];
        });

        const scores = store.getScoresFromOrderedSet(IndexNames.HOLDER_COUNT, ['holder_a', 'holder_b', 'holder_c']);

        expect(scores).toEqual([4, 0, 11]);
        expect(redisSpy).toHaveBeenCalledWith('zmscore', '{root}:holdercount', ['holder_a', 'holder_b', 'holder_c']);
    });

    it('builds metrics from defaults when cache is empty', () => {
        const store = new RedisHandlesStore();
        jest.spyOn(store as any, 'rehydrateObjectFromCache').mockReturnValue(undefined);
        jest.spyOn(store, 'count').mockReturnValue(9);
        jest.spyOn(store, 'holderCount').mockReturnValue(4);

        expect(store.getMetrics()).toEqual({ handleCount: 9, holderCount: 4 });
    });

    it('rehydrates nested references stored as key pointers', () => {
        const store = new RedisHandlesStore();
        jest.spyOn(store as any, 'rehydrateObjectFromCache').mockImplementation((...args: any[]) => {
            const [key] = args as [string];
            if (key === 'parent:child') return { nested: true };
            return undefined;
        });

        const result = (store as any).rehydrateObject('parent', [
            {
                field: { toString: () => 'child' },
                value: { toString: () => 'parent:child' }
            }
        ]);

        expect(result).toEqual({ child: { nested: true } });
    });

    it('handles missing hash fields and key-based field names during rehydration', () => {
        const store = new RedisHandlesStore();

        expect((store as any).rehydrateObject('missing:key', undefined)).toBeUndefined();
        expect(
            (store as any).rehydrateObject('parent', [
                {
                    key: { toString: () => 'alt' },
                    value: { toString: () => '1' }
                }
            ])
        ).toEqual({ alt: 1 });
    });

    it('stringifies nested bigint values when saving objects', () => {
        const store = new RedisHandlesStore();
        const redisSpy = jest.spyOn(store as any, 'redisClientCall').mockImplementation(jest.fn());

        (store as any).saveObjectToCache('bigint:key', { details: { total: BigInt(2) } });

        expect(redisSpy).toHaveBeenCalledWith('hset', 'bigint:key', {
            details: '{"total":"2"}'
        });
    });

    it('handles redis worker timeout and reply error branches', () => {
        const store = new RedisHandlesStore();
        const loggerSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());
        const atomicsSpy = jest.spyOn(Atomics, 'wait');

        (RedisHandlesStore as any)._worker = {
            postMessage: jest.fn()
        };

        atomicsSpy.mockReturnValueOnce('timed-out' as never);
        expect(() => store.redisClientCall('get', 'key')).toThrow('GlideClient get timed out');

        atomicsSpy.mockReturnValueOnce('ok' as never);
        (RedisHandlesStore as any)._worker.postMessage = ({ id, reply }: any) => {
            reply.postMessage({ id: id + 1, ok: true, result: 'wrong-id' });
        };
        expect(store.redisClientCall('get', 'key')).toBeUndefined();
        expect(loggerSpy).toHaveBeenCalledWith(expect.objectContaining({ event: 'redisClientCall.incorrectMessageResponse' }));

        atomicsSpy.mockReturnValueOnce('ok' as never);
        (RedisHandlesStore as any)._worker.postMessage = ({ id, reply }: any) => {
            reply.postMessage({ id, ok: false, result: 'fallback', error: { message: 'worker-failed' } });
        };
        expect(() => store.redisClientCall('get', 'key')).toThrow('worker-failed');
        expect(loggerSpy).toHaveBeenCalledWith(expect.objectContaining({ event: 'redisClientCall.errorFromPostMessage' }));
    });

    it('queues calls during pipeline mode and returns successful worker results', () => {
        const store = new RedisHandlesStore();
        (RedisHandlesStore as any)._pipeline = [];

        const queuedResult = store.redisClientCall('get', 'queued-key');
        expect(queuedResult).toBeUndefined();
        expect((RedisHandlesStore as any)._pipeline).toEqual([['get', ['queued-key']]]);

        (RedisHandlesStore as any)._pipeline = undefined;
        jest.spyOn(Atomics, 'wait').mockReturnValue('ok' as never);
        (RedisHandlesStore as any)._worker = {
            postMessage: ({ id, reply }: any) => {
                reply.postMessage({ id, ok: true, result: 'ok-value' });
            }
        };

        const result = store.redisClientCall('get', 'live-key');
        expect(result).toBe('ok-value');
    });

    it('throws default worker failure message when postMessage error payload is missing', () => {
        const store = new RedisHandlesStore();
        const loggerSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());
        const atomicsSpy = jest.spyOn(Atomics, 'wait');

        (RedisHandlesStore as any)._worker = {
            postMessage: ({ id, reply }: any) => {
                reply.postMessage({ id, ok: false, result: 'fallback' });
            }
        };

        atomicsSpy.mockReturnValueOnce('ok' as never);
        expect(() => store.redisClientCall('get', 'key')).toThrow('GlideClient get failed');
        expect(loggerSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                event: 'redisClientCall.errorFromPostMessage',
                message: 'GlideClient get failed'
            })
        );
    });

    it('always clears pipeline state when a pipeline callback throws', () => {
        const store = new RedisHandlesStore();

        expect(() => {
            store.pipeline(() => {
                throw new Error('pipeline failure');
            });
        }).toThrow('pipeline failure');

        expect((RedisHandlesStore as any)._pipeline).toBeUndefined();
    });
});
