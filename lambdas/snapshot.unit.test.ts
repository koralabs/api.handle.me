import { IndexNames } from '@koralabs/kora-labs-common';
import { getApiIndexKey, getApiIndexScanPattern } from '../stores/redis/keys';

const mockAwsSdk = () => {
    jest.doMock('@aws-sdk/client-s3', () => ({
        S3Client: jest.fn(() => ({ send: jest.fn().mockResolvedValue('ok') })),
        PutObjectCommand: jest.fn((params) => params),
        ListObjectsV2Command: jest.fn((params) => params),
        DeleteObjectsCommand: jest.fn((params) => params)
    }));
};

const loadSnapshotModule = async (storeFactory: () => any) => {
    jest.resetModules();
    mockAwsSdk();
    jest.doMock('../stores/redis', () => {
        const mockStore = storeFactory();
        return {
            RedisHandlesStore: jest.fn().mockImplementation(() => mockStore),
            getHandlesStore: jest.fn(() => mockStore)
        };
    });
    jest.doMock('../repositories/handlesRepository', () => ({
        HandlesRepository: jest.fn().mockImplementation(() => ({
            initialize: jest.fn().mockResolvedValue(undefined),
            getMetrics: jest.fn().mockReturnValue({ lockLambdas: undefined }),
            setMetrics: jest.fn()
        }))
    }));

    let snapshot: any;
    await jest.isolateModulesAsync(async () => {
        snapshot = await import('./snapshot');
    });
    return snapshot;
};

describe('snapshot unit branches', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('processSnapshot hits progress logging branches during large scans', async () => {
        let scanCall = 0;
        let pipelineCall = 0;
        const writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
        const redisClientCall = jest.fn().mockImplementation(() => {
            scanCall += 1;
            if (scanCall === 1) return ['0', Array.from({ length: 10001 }, (_, i) => getApiIndexKey(IndexNames.UTXO, i))];
            if (scanCall === 2) return ['0', Array.from({ length: 10001 }, (_, i) => getApiIndexKey(IndexNames.MINT, i))];
            return ['0', []];
        });

        const snapshot = await loadSnapshotModule(() => ({
            initialize: jest.fn().mockResolvedValue(undefined),
            getMetrics: jest.fn().mockReturnValue({
                currentSlot: 10,
                currentBlockHash: 'head',
                utxoSchemaVersion: 2
            }),
            redisClientCall,
            pipeline: jest.fn().mockImplementation((commands: CallableFunction) => {
                commands();
                pipelineCall += 1;
                if (pipelineCall === 1) {
                    return [{ id: 'u1', slot: 1 }];
                }
                return [new Set([JSON.stringify({ created_slot: 1, txHash: 'tx', metadata: {} })])];
            }),
            getHashFromIndex: jest.fn(),
            getValuesFromIndexedSet: jest.fn(),
            getKeysFromIndex: jest.fn().mockReturnValue(['papagoose']),
            listAllScannedBlocks: jest.fn().mockReturnValue([])
        }));

        const result = await snapshot.processSnapshot('preview');

        expect(result.slot).toBe(10);
        expect(result.hash).toBe('head');
        expect(result.utxos).toHaveLength(1);
        expect(writeSpy).toHaveBeenCalled();
        expect(redisClientCall).toHaveBeenCalledWith('scan', '0', { match: getApiIndexScanPattern(IndexNames.UTXO), count: 10000 });
        expect(redisClientCall).toHaveBeenCalledWith('scan', '0', { match: getApiIndexScanPattern(IndexNames.MINT), count: 10000 });
    });

    // Regression: previously a redis-init failure was caught, logged at ERROR
    // (not NOTIFY), and getRedisItems returned partial/empty state. processSnapshot
    // would then write that partial state to S3, silently shipping a corrupted
    // snapshot. We now throw to halt the snapshot publish.
    it('throws (does not silently return empty) when redis enumeration fails', async () => {
        const snapshot = await loadSnapshotModule(() => ({
            initialize: jest.fn().mockRejectedValue('redis down'),
            getKeysFromIndex: jest.fn().mockReturnValue([]),
            listAllScannedBlocks: jest.fn().mockReturnValue([])
        }));

        await expect(snapshot.processSnapshot('preview')).rejects.toBeDefined();
    });

    // Regression: a corrupt mint JSON used to throw inside .map(JSON.parse) and
    // hit the function-scope catch which logged ERROR and returned PARTIAL state,
    // then processSnapshot wrote it to S3. Now the catch re-throws so the publish
    // is aborted — even one unparseable record halts the whole process.
    it('throws when a mint record cannot be parsed', async () => {
        let scanCall = 0;
        const snapshot = await loadSnapshotModule(() => ({
            initialize: jest.fn().mockResolvedValue(undefined),
            getMetrics: jest.fn().mockReturnValue({
                currentSlot: 10,
                currentBlockHash: 'head',
                utxoSchemaVersion: 2
            }),
            redisClientCall: jest.fn().mockImplementation(() => {
                scanCall += 1;
                if (scanCall === 1) return ['0', []];
                if (scanCall === 2) return ['0', [getApiIndexKey(IndexNames.MINT, 'corruptHandle')]];
                return ['0', []];
            }),
            pipeline: jest.fn().mockImplementation((commands: CallableFunction) => {
                commands();
                return [new Set(['{this is not json'])];
            }),
            getHashFromIndex: jest.fn(),
            getValuesFromIndexedSet: jest.fn(),
            getKeysFromIndex: jest.fn().mockReturnValue(['corruptHandle']),
            listAllScannedBlocks: jest.fn().mockReturnValue([])
        }));

        await expect(snapshot.processSnapshot('preview')).rejects.toThrow(SyntaxError);
    });

    it('handles undefined mint pipeline entries by emitting empty arrays', async () => {
        let scanCall = 0;
        const snapshot = await loadSnapshotModule(() => ({
            initialize: jest.fn().mockResolvedValue(undefined),
            getMetrics: jest.fn().mockReturnValue({
                currentSlot: 10,
                currentBlockHash: 'head',
                utxoSchemaVersion: 2
            }),
            redisClientCall: jest.fn().mockImplementation(() => {
                scanCall += 1;
                if (scanCall === 1) return ['0', [getApiIndexKey(IndexNames.UTXO, '1')]];
                if (scanCall === 2) return ['0', [getApiIndexKey(IndexNames.MINT, '1')]];
                return ['0', []];
            }),
            pipeline: jest.fn().mockImplementation((commands: CallableFunction) => {
                commands();
                return [undefined];
            }),
            getHashFromIndex: jest.fn(),
            getValuesFromIndexedSet: jest.fn(),
            getKeysFromIndex: jest.fn().mockReturnValue(['papagoose']),
            listAllScannedBlocks: jest.fn().mockReturnValue([])
        }));

        const result = await snapshot.processSnapshot('preview');

        expect(result.mintingData).toEqual({ '1': [] });
    });
});
