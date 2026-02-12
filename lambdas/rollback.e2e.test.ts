import { UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import { HandlesRepository } from '../repositories/handlesRepository';
import { RedisHandlesStore } from '../stores/redis';
import * as helpers from '../utils/helpers';

jest.mock('../utils/helpers');

const mockedHelpers = helpers as jest.Mocked<typeof helpers>;

const policy = 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a';
const handleHex = '000de140726f6c6c6261636b';

const buildTrackedUtxo = (): UTxOWithTxInfo =>
    ({
        id: 'rollback_tx#0',
        tx_id: 'rollback_tx',
        index: 0,
        slot: 100,
        address: 'addr_test1qzdzhdzf9ud8k2suzryvcdl78l3tfesnwp962vcuh99k8z834r3hjynmsy2cxpc04a6dkqxcsr29qfl7v9cmrd5mm89qfmc97q',
        lovelace: 1_000_000,
        handles: [[policy, [handleHex]]],
        mint: [[policy, [handleHex]]],
        metadata: {
            '721': {
                [policy]: {
                    [handleHex]: {
                        name: '$rollback',
                        image: 'ipfs://rollback',
                        mediaType: 'image/png',
                        og: 0,
                        og_number: 0,
                        rarity: 'basic',
                        length: 8,
                        characters: 'letters',
                        numeric_modifiers: '',
                        version: 1
                    }
                }
            }
        },
        blockHash: 'provider_block',
        blockNum: 1000
    }) as UTxOWithTxInfo;

describe('Rollback lambda e2e', () => {
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
        repo.addUTxO(buildTrackedUtxo());
        repo.setMetrics({
            currentSlot: 140,
            currentBlockHash: 'provider_block',
            lastMaxRollbackCheck: Date.now(),
            lockLambdas: false
        });
        jest.clearAllMocks();
    });

    it('keeps lock healthy and skips replay when hashes match', async () => {
        mockedHelpers.blockfrostApiCall.mockResolvedValue({ ok: true, json: async () => ({ height: 5000 }) } as never);
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'provider_block', slot: 100 }] as never);
        mockedHelpers.fetchTxList.mockResolvedValue([] as never);
        mockedHelpers.buildUTxOsFromKoiosTxs.mockReturnValue([] as never);
        mockedHelpers.fetchKoios.mockResolvedValue([] as never);

        const rollback = require('./rollback');
        await rollback.lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context);

        expect(repo.getMetrics().lockLambdas).toBe(false);
        expect(mockedHelpers.fetchPaginatedResults).toHaveBeenCalledWith('blocks/4980/next');
        expect(mockedHelpers.fetchTxList).not.toHaveBeenCalled();
        expect(mockedHelpers.fetchKoios).not.toHaveBeenCalled();
    });
});
