import { UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import { HandlesRepository } from '../repositories/handlesRepository';
import { RedisHandlesStore } from '../stores/redis';
import * as helpers from '../utils/helpers';

jest.mock('../utils/helpers');

const mockedHelpers = helpers as jest.Mocked<typeof helpers>;

const policy = 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a';
const handleHex = '000de140726f6c6c6261636b';
const knownAddress = 'addr_test1qzdzhdzf9ud8k2suzryvcdl78l3tfesnwp962vcuh99k8z834r3hjynmsy2cxpc04a6dkqxcsr29qfl7v9cmrd5mm89qfmc97q';

const buildTrackedUtxo = ({
    id = 'rollback_tx#0',
    tx_id = 'rollback_tx',
    slot = 100,
    blockHash = 'provider_block'
}: {
    id?: string;
    tx_id?: string;
    slot?: number;
    blockHash?: string;
} = {}): UTxOWithTxInfo =>
    ({
        id,
        tx_id,
        index: Number(id.split('#')[1] ?? 0),
        slot,
        address: knownAddress,
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
        blockHash,
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

    it('replays divergent blocks and updates handle ownership state', async () => {
        repo.rollBackToGenesis();
        repo.addUTxOAndMintData(buildTrackedUtxo({ id: 'stale_tx#0', tx_id: 'stale_tx', blockHash: 'api_block' }));
        repo.setMetrics({
            currentSlot: 140,
            currentBlockHash: 'api_block',
            lastMaxRollbackCheck: Date.now(),
            lockLambdas: false
        });

        mockedHelpers.blockfrostApiCall.mockResolvedValue({ ok: true, json: async () => ({ height: 5000 }) } as never);
        mockedHelpers.fetchPaginatedResults.mockResolvedValue([{ hash: 'provider_block', slot: 100 }] as never);
        mockedHelpers.fetchTxList.mockResolvedValue([{ source: 'block' }] as never);
        mockedHelpers.fetchKoios.mockImplementation(async (path: string) => {
            if (path === 'asset_utxos') return [{ tx_hash: 'replay_tx' }] as never;
            if (path === 'tx_info') return [{ source: 'tx_info' }] as never;
            return [] as never;
        });
        mockedHelpers.buildUTxOsFromKoiosTxs.mockImplementation((txs: any[]) => {
            if (txs?.[0]?.source === 'block') {
                return [buildTrackedUtxo({ id: 'replay_tx#0', tx_id: 'replay_tx', slot: 101, blockHash: 'provider_block' })] as never;
            }
            if (txs?.[0]?.source === 'tx_info') {
                return [buildTrackedUtxo({ id: 'replay_tx#0', tx_id: 'replay_tx', slot: 101, blockHash: 'provider_block' })] as never;
            }
            return [] as never;
        });

        const rollback = require('./rollback');
        await rollback.lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context);

        expect(repo.getUTxO('stale_tx#0')).toBeUndefined();
        expect(repo.getUTxO('replay_tx#0')).toEqual(expect.objectContaining({ tx_id: 'replay_tx' }));
        expect(repo.getHandle('rollback')?.utxo).toBe('replay_tx#0');
        expect(repo.getMetrics().lockLambdas).toBe(false);
    });

    it('clears lock even when rollback provider call fails', async () => {
        mockedHelpers.blockfrostApiCall.mockResolvedValue({ ok: false } as never);

        const rollback = require('./rollback');
        await expect(rollback.lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context)).rejects.toThrow('Not good!');

        expect(repo.getMetrics().lockLambdas).toBe(false);
    });
});
