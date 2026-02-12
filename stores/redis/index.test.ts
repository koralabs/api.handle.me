import { IndexNames, Logger, UTxOFunctionName } from '@koralabs/kora-labs-common';
import { deflateSync } from 'zlib';
import { ORDERED_SLOTS } from '../../config/constants';
import { RedisHandlesStore } from './index';

describe('RedisHandlesStore critical path tests', () => {
    const originalFetch = global.fetch;
    const originalOrderedSlots = [...ORDERED_SLOTS];

    afterEach(() => {
        global.fetch = originalFetch;
        ORDERED_SLOTS.splice(0, ORDERED_SLOTS.length, ...originalOrderedSlots);
        jest.restoreAllMocks();
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
            if (callCount === 1) return [{ id: 'utxo#0', slot: 1 }];
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

    it('getStartingPoint returns null on failed retry snapshot error', async () => {
        const store = new RedisHandlesStore();
        jest.spyOn(store, 'tryPopulateFromS3UTxOs').mockRejectedValue(new Error('network down'));

        const startingPoint = await store.getStartingPoint({} as any, true);

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

    it('throws when trying to save non-object values into hash cache', () => {
        const store = new RedisHandlesStore();
        jest.spyOn(store as any, 'redisClientCall').mockImplementation(jest.fn());

        expect(() => (store as any).saveObjectToCache('bad:key', ['not', 'object'])).toThrow('saveObjectToCache only supports plain objects');
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

        expect(redisSpy).toHaveBeenCalledWith('del', scannedKeys);
        expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Deleted: 100,000 keys'));
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
        expect(store.redisClientCall('get', 'key')).toBe('fallback');
        expect(loggerSpy).toHaveBeenCalledWith(expect.objectContaining({ event: 'redisClientCall.errorFromPostMessage' }));
    });

    it('logs default worker failure message when postMessage error payload is missing', () => {
        const store = new RedisHandlesStore();
        const loggerSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());
        const atomicsSpy = jest.spyOn(Atomics, 'wait');

        (RedisHandlesStore as any)._worker = {
            postMessage: ({ id, reply }: any) => {
                reply.postMessage({ id, ok: false, result: 'fallback' });
            }
        };

        atomicsSpy.mockReturnValueOnce('ok' as never);
        expect(store.redisClientCall('get', 'key')).toBe('fallback');
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
