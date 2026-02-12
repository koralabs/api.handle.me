import { IndexNames, UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import { HandlesRepository } from '../repositories/handlesRepository';
import { RedisHandlesStore } from '../stores/redis';
import * as helpers from '../utils/helpers';

jest.mock('../utils/helpers');
const { lambdaHandler } = require('./scanner');

const policy = 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a';
const buildMintedUTxO = (handleName: string): UTxOWithTxInfo => {
    const handleHex = `000de140${Buffer.from(handleName).toString('hex')}`;
    return {
    id: 'scan_tx#0',
    tx_id: 'scan_tx',
    index: 0,
    blockHash: 'next_hash',
    blockNum: 123,
    slot: 101,
    address: 'addr_test1qzdzhdzf9ud8k2suzryvcdl78l3tfesnwp962vcuh99k8z834r3hjynmsy2cxpc04a6dkqxcsr29qfl7v9cmrd5mm89qfmc97q',
    lovelace: 1176630,
    handles: [[policy, [handleHex]]],
    mint: [[policy, [handleHex]]],
    burn: [],
    metadata: {
        '721': {
            [policy]: {
                [handleHex]: {
                    name: `$${handleName}`,
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
    };
};

describe('Scanner lambda e2e', () => {
    const store = new RedisHandlesStore();
    const repo = new HandlesRepository(store);

    beforeAll(async () => {
        await repo.initialize();
    });

    afterAll(() => {
        repo.destroy();
    });

    beforeEach(() => {
        repo.rollBackToGenesis();
        repo.setMetrics({
            currentSlot: 100,
            lastSlot: 200,
            currentBlockHash: 'start_hash',
            tipBlockHash: 'start_hash'
        });
        jest.clearAllMocks();
    });

    it('scans block updates and persists handle + metrics', async () => {
        const handleName = `scanner-${Date.now()}`;

        jest.mocked(helpers.fetchPaginatedResults).mockResolvedValue([
            { hash: 'next_hash', slot: 101, confirmations: 21 }
        ] as never);

        jest.mocked(helpers.fetchTxList).mockResolvedValue([
            {
                inputs: []
            }
        ] as never);

        jest.mocked(helpers.buildUTxOsFromKoiosTxs).mockReturnValue([buildMintedUTxO(handleName)]);

        const result = await lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context);

        expect(result).toEqual({ isBase64Encoded: false, statusCode: 200, body: '' });

        const handle = repo.getHandle(handleName);
        expect(handle).toEqual(
            expect.objectContaining({
                name: handleName,
                utxo: 'scan_tx#0',
                image: 'ipfs://some-image',
                policy,
                has_datum: false
            })
        );

        const indexedHandles = store.getValuesFromIndexedSet(IndexNames.HOLDER, handle!.holder) as Set<string>;
        expect(indexedHandles.has(handleName)).toBe(true);

        expect(repo.getMetrics().currentSlot).toBeGreaterThanOrEqual(101);
    });
});
