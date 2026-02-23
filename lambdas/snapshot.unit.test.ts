const mockAwsSdk = () => {
    jest.doMock('@aws-sdk/client-s3', () => ({
        S3Client: jest.fn(() => ({ send: jest.fn().mockResolvedValue('ok') })),
        PutObjectCommand: jest.fn((params) => params)
    }));
};

const loadSnapshotModule = async (storeFactory: () => any) => {
    jest.resetModules();
    mockAwsSdk();
    jest.doMock('../stores/redis', () => ({
        RedisHandlesStore: jest.fn().mockImplementation(storeFactory)
    }));
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

        const snapshot = await loadSnapshotModule(() => ({
            initialize: jest.fn().mockResolvedValue(undefined),
            getMetrics: jest.fn().mockReturnValue({
                currentSlot: 10,
                currentBlockHash: 'head',
                utxoSchemaVersion: 2
            }),
            redisClientCall: jest.fn().mockImplementation(() => {
                scanCall += 1;
                if (scanCall === 1) return ['0', Array.from({ length: 10001 }, (_, i) => `{root}:utxo:${i}`)];
                if (scanCall === 2) return ['0', Array.from({ length: 10001 }, (_, i) => `{root}:mint:${i}`)];
                return ['0', []];
            }),
            pipeline: jest.fn().mockImplementation((commands: CallableFunction) => {
                commands();
                pipelineCall += 1;
                if (pipelineCall === 1) {
                    return [{ id: 'u1', slot: 1 }];
                }
                return [new Set([JSON.stringify({ created_slot: 1, txHash: 'tx', metadata: {} })])];
            }),
            getHashFromIndex: jest.fn(),
            getValuesFromIndexedSet: jest.fn()
        }));

        const result = await snapshot.processSnapshot('preview');

        expect(result.slot).toBe(10);
        expect(result.hash).toBe('head');
        expect(result.utxos).toHaveLength(1);
        expect(writeSpy).toHaveBeenCalled();
    });

    it('logs and returns empty snapshot content when redis enumeration fails', async () => {
        const snapshot = await loadSnapshotModule(() => ({
            initialize: jest.fn().mockRejectedValue('redis down')
        }));

        const result = await snapshot.processSnapshot('preview');

        expect(result.slot).toBe(0);
        expect(result.hash).toBe('');
        expect(result.utxos).toEqual([]);
        expect(result.mintingData).toEqual({});
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
                if (scanCall === 1) return ['0', ['{root}:utxo:1']];
                if (scanCall === 2) return ['0', ['{root}:mint:1']];
                return ['0', []];
            }),
            pipeline: jest.fn().mockImplementation((commands: CallableFunction) => {
                commands();
                return [undefined];
            }),
            getHashFromIndex: jest.fn(),
            getValuesFromIndexedSet: jest.fn()
        }));

        const result = await snapshot.processSnapshot('preview');

        expect(result.mintingData).toEqual({ '1': [] });
    });
});
