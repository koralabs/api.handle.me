import { IndexNames, LockedLambdaReason, UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import { HandlesRepository } from '../repositories/handlesRepository';
import { RedisHandlesStore } from '../stores/redis';

const lambda = require('./snapshot');

const policy = 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a';
const handleHex = '000de14070617061676f6f7365';

jest.mock('@aws-sdk/client-s3', () => {
    const mockedS3Instance = {
        send: jest.fn(() => Promise.resolve('success'))
    };
    return {
        S3Client: jest.fn(() => mockedS3Instance),
        PutObjectCommand: jest.fn((params) => params)
    };
});

const buildMintedUTxO = (): UTxOWithTxInfo => ({
    id: 'snapshot_tx#0',
    tx_id: 'snapshot_tx',
    index: 0,
    blockHash: 'snapshot_block',
    blockNum: 99,
    slot: 100,
    address: 'addr_test1qzdzhdzf9ud8k2suzryvcdl78l3tfesnwp962vcuh99k8z834r3hjynmsy2cxpc04a6dkqxcsr29qfl7v9cmrd5mm89qfmc97q',
    lovelace: 1176630,
    handles: [[policy, [handleHex]]],
    mint: [[policy, [handleHex]]],
    burn: [],
    metadata: {
        '721': {
            [policy]: {
                [handleHex]: {
                    name: '$papagoose',
                    image: 'ipfs://some-image',
                    mediaType: 'image/jpeg',
                    og: 0,
                    og_number: 0,
                    rarity: 'basic',
                    length: 9,
                    characters: 'letters',
                    numeric_modifiers: '',
                    version: 1
                }
            }
        }
    }
});

describe('Snapshot lambda e2e', () => {
    const store = new RedisHandlesStore();
    const repo = new HandlesRepository(store);
    let mockedS3Instance: any;

    beforeAll(async () => {
        await repo.initialize();
        const AWS = require('@aws-sdk/client-s3');
        mockedS3Instance = new AWS.S3Client();
    });

    afterAll(() => {
        repo.destroy();
    });

    beforeEach(() => {
        repo.rollBackToGenesis();
        repo.addUTxOsWithMintDataAndUpdateIndexes([buildMintedUTxO()]);
        repo.setMetrics({
            currentSlot: 105,
            currentBlockHash: 'snapshot_block',
            utxoSchemaVersion: 7,
            lockLambdas: LockedLambdaReason.UNLOCKED
        });
        jest.clearAllMocks();
    });

    it('creates and uploads snapshots for all networks', async () => {
        const sendSpy = jest.spyOn(mockedS3Instance, 'send');

        const result = await lambda.handler({});

        expect(result).toEqual({ body: '', statusCode: 200 });
        expect(sendSpy).toHaveBeenCalledTimes(3);
        expect(sendSpy).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                Bucket: 'api.handle.me',
                Key: 'mainnet/utxo-snapshot/7/handles_utxos.gz',
                Body: expect.any(Object)
            })
        );
        expect(sendSpy).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                Bucket: 'api.handle.me',
                Key: 'preview/utxo-snapshot/7/handles_utxos.gz',
                Body: expect.any(Object)
            })
        );
        expect(sendSpy).toHaveBeenNthCalledWith(
            3,
            expect.objectContaining({
                Bucket: 'api.handle.me',
                Key: 'preprod/utxo-snapshot/7/handles_utxos.gz',
                Body: expect.any(Object)
            })
        );

        const storedUtxo = repo.getUTxO('snapshot_tx#0');
        expect(storedUtxo).not.toBeNull();
        expect(store.getValuesFromIndexedSet(IndexNames.MINT, 'papagoose')?.size).toBe(1);
        expect(repo.getMetrics().lockLambdas).toBe(LockedLambdaReason.UNLOCKED);
    });

    it('skips snapshot generation when lambdas are already locked', async () => {
        jest.useFakeTimers();
        try {
            const sendSpy = jest.spyOn(mockedS3Instance, 'send');
            repo.setMetrics({ lockLambdas: LockedLambdaReason.SCANNING });

            const pending = lambda.handler({});
            await jest.advanceTimersByTimeAsync(15_000 * 4);
            const result = await pending;

            expect(result).toEqual({ body: '', statusCode: 200 });
            expect(sendSpy).not.toHaveBeenCalled();
        } finally {
            jest.useRealTimers();
        }
    });

    it('retries lock checks and continues once unlocked', async () => {
        jest.useFakeTimers();
        try {
            const sendSpy = jest.spyOn(mockedS3Instance, 'send');
            repo.setMetrics({ lockLambdas: LockedLambdaReason.SCANNING });
            setTimeout(() => {
                repo.setMetrics({ lockLambdas: LockedLambdaReason.UNLOCKED });
            }, 20_000);

            const pending = lambda.handler({});
            await jest.advanceTimersByTimeAsync(45_000);
            const result = await pending;

            expect(result).toEqual({ body: '', statusCode: 200 });
            expect(sendSpy).toHaveBeenCalledTimes(3);
        } finally {
            jest.useRealTimers();
        }
    });

    it('initializes the redis worker before lock checks on cold starts', async () => {
        const sendSpy = jest.spyOn(mockedS3Instance, 'send');
        (RedisHandlesStore as any)._worker = undefined;

        const result = await lambda.handler({});

        expect(result).toEqual({ body: '', statusCode: 200 });
        expect(sendSpy).toHaveBeenCalledTimes(3);
    });
});
