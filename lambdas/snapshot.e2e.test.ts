import { IndexNames, LockedLambdaReason, LogCategory, Logger, UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import { HandlesRepository } from '../repositories/handlesRepository';
import { RedisHandlesStore } from '../stores/redis';
import { buildHandleSetMptRootHash } from '../utils/snapshotVerification';
import { inflateSync } from 'zlib';

const lambda = require('./snapshot');

const policy = 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a';
const handleHex = '000de14070617061676f6f7365';
const mintingDataHandleName = 'handle_root@handle_settings';

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
    const originalFetch = global.fetch;
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

    beforeEach(async () => {
        repo.rollBackToGenesis();
        repo.addUTxOsWithMintDataAndUpdateIndexes([buildMintedUTxO()]);
        const rootHash = await buildHandleSetMptRootHash(['papagoose', mintingDataHandleName]);
        store.setHashOnIndex(IndexNames.HANDLE, mintingDataHandleName, {
            name: mintingDataHandleName,
            datum: `d8799f5820${rootHash}ff`,
            has_datum: true
        } as any);
        repo.setMetrics({
            currentSlot: 105,
            currentBlockHash: 'snapshot_block',
            utxoSchemaVersion: 7,
            lockLambdas: LockedLambdaReason.UNLOCKED
        });
        jest.clearAllMocks();
    });

    afterEach(() => {
        global.fetch = originalFetch;
    });

    it('creates and uploads a snapshot for the configured network only', async () => {
        const sendSpy = jest.spyOn(mockedS3Instance, 'send');
        const network = `${process.env.NETWORK ?? 'mainnet'}`.toLowerCase();
        const rootHash = await buildHandleSetMptRootHash(['papagoose', mintingDataHandleName]);

        const result = await lambda.handler({});

        expect(result).toEqual({ body: '', statusCode: 200 });
        expect(sendSpy).toHaveBeenCalledTimes(1);
        expect(sendSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                Bucket: 'api.handle.me',
                Key: `${network}/utxo-snapshot/7/handles_utxos.gz`,
                Body: expect.any(Object)
            })
        );
        const uploadedBody = (sendSpy.mock.calls[0]?.[0] as { Body: Buffer }).Body;
        const uploadedSnapshot = JSON.parse(inflateSync(uploadedBody).toString('utf8'));
        expect(uploadedSnapshot.verification).toEqual(expect.objectContaining({
            verifiedAgainstChain: true,
            snapshotMptRootHash: rootHash,
            chainMptRootHash: rootHash,
            network
        }));

        const storedUtxo = repo.getUTxO('snapshot_tx#0');
        expect(storedUtxo).not.toBeNull();
        expect(store.getValuesFromIndexedSet(IndexNames.MINT, 'papagoose')?.size).toBe(1);
        expect(repo.getMetrics().lockLambdas).toBe(LockedLambdaReason.UNLOCKED);
    });

    it('publishes snapshot with verifiedAgainstChain=false when MPT roots mismatch', async () => {
        const loggerSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());
        const sendSpy = jest.spyOn(mockedS3Instance, 'send');
        const network = `${process.env.NETWORK ?? 'mainnet'}`.toLowerCase();
        store.setHashOnIndex(IndexNames.HANDLE, mintingDataHandleName, {
            name: mintingDataHandleName,
            datum: `d8799f5820${'00'.repeat(32)}ff`,
            has_datum: true
        } as any);

        const result = await lambda.handler({});

        expect(result).toEqual({ body: '', statusCode: 200 });
        expect(loggerSpy).toHaveBeenCalledWith(expect.objectContaining({
            category: LogCategory.WARN,
            event: 'snapshotVerification.mptRootMismatch'
        }));
        expect(sendSpy).toHaveBeenCalledTimes(1);
        const uploadedBody = (sendSpy.mock.calls[0]?.[0] as { Body: Buffer }).Body;
        const uploadedSnapshot = JSON.parse(inflateSync(uploadedBody).toString('utf8'));
        expect(uploadedSnapshot.verification.verifiedAgainstChain).toBe(false);
        expect(uploadedSnapshot.verification.network).toBe(network);
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
            expect(sendSpy).toHaveBeenCalledTimes(1);
        } finally {
            jest.useRealTimers();
        }
    });

    it('initializes the redis worker before lock checks on cold starts', async () => {
        const sendSpy = jest.spyOn(mockedS3Instance, 'send');
        (RedisHandlesStore as any)._worker = undefined;

        const result = await lambda.handler({});

        expect(result).toEqual({ body: '', statusCode: 200 });
        expect(sendSpy).toHaveBeenCalledTimes(1);
    });
});
