import { CardanoTxEvent } from '@utxorpc/sdk';
import { consumeCompleteDemeterBlocks, convertDemeterTx, DemeterBlock, DemeterRollbackError, getDemeterConfig, isDemeterScannerEnabled } from './utxorpc.service';

const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));
const hash = (byte: string) => bytes(byte.repeat(64));
const policy = 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a';
const address = bytes(`60${'11'.repeat(28)}`);
const coin = (value: bigint) => ({ bigInt: { case: 'int', value } });
const quantity = (value: bigint) => ({ quantity: { case: 'mintCoin', value: coin(value) } });

const block = (slot: number, height: number, byte: string) => ({
    header: { slot: BigInt(slot), height: BigInt(height), hash: hash(byte) }
});

const tx = (byte: string, overrides: Record<string, unknown> = {}) => ({
    successful: true,
    hash: hash(byte),
    inputs: [{ txHash: hash('a'), outputIndex: 2 }],
    referenceInputs: [{ txHash: hash('b'), outputIndex: 3 }],
    outputs: [{
        address,
        coin: coin(3_000_000n),
        assets: [{ policyId: bytes(policy), assets: [{ name: bytes('000de140616c696365'), ...quantity(1n) }] }],
        datum: { hash: hash('c'), originalCbor: bytes('d87980') },
        script: { script: { case: 'plutusV3', value: bytes('4e4d01000033222220051200120011') } }
    }],
    mint: [{
        policyId: bytes(policy),
        assets: [
            { name: bytes('000de140616c696365'), ...quantity(1n) },
            { name: bytes('000643b0616c696365'), ...quantity(-2n) }
        ]
    }],
    auxiliary: {
        metadata: [{
            label: 721n,
            value: {
                metadatum: {
                    case: 'map',
                    value: {
                        pairs: [{
                            key: { metadatum: { case: 'text', value: policy } },
                            value: {
                                metadatum: {
                                    case: 'map',
                                    value: {
                                        pairs: [{
                                            key: { metadatum: { case: 'text', value: 'alice' } },
                                            value: { metadatum: { case: 'text', value: 'ipfs://metadata' } }
                                        }]
                                    }
                                }
                            }
                        }]
                    }
                }
            }
        }]
    },
    ...overrides
});

const apply = (slot: number, height: number, blockByte: string, txByte: string): CardanoTxEvent => ({
    action: 'apply',
    Block: block(slot, height, blockByte),
    Tx: tx(txByte)
} as unknown as CardanoTxEvent);

const idle = (slot: number, height: number, byte: string): CardanoTxEvent => ({
    action: 'idle',
    BlockRef: { slot: BigInt(slot), height: BigInt(height), hash: hash(byte) }
} as unknown as CardanoTxEvent);

const events = async function* (items: CardanoTxEvent[]) {
    yield* items;
};

describe('Demeter UTxORPC conversion', () => {
    it('preserves transaction references, output data, metadata, scripts, mint quantities, and block identity', () => {
        // Invariant: a UTxORPC transaction has the same scanner payload as the existing Koios path.
        // Failure caught: changing any conversion (for example burn sign or script language) breaks these external values.
        const converted = convertDemeterTx(tx('1'), block(100, 50, '2'))!;

        expect(converted).toMatchObject({
            tx_hash: '1'.repeat(64),
            block_hash: '2'.repeat(64),
            block_height: 50,
            absolute_slot: 100,
            inputs: [{ tx_hash: 'a'.repeat(64), tx_index: 2 }],
            reference_inputs: [{ tx_hash: 'b'.repeat(64), tx_index: 3 }],
            assets_minted: [
                expect.objectContaining({ asset_name: '000de140616c696365', quantity: '1', policy_id: policy }),
                expect.objectContaining({ asset_name: '000643b0616c696365', quantity: '-2', policy_id: policy })
            ],
            metadata: { '721': { [policy]: { alice: 'ipfs://metadata' } } }
        });
        expect(converted.outputs[0]).toMatchObject({
            value: '3000000',
            datum_hash: 'c'.repeat(64),
            inline_datum: { bytes: 'd87980' },
            reference_script: { type: 'plutusV3', bytes: '4e4d01000033222220051200120011' },
            asset_list: [expect.objectContaining({ policy_id: policy, asset_name: '000de140616c696365', quantity: '1' })]
        });
        expect(converted.outputs[0].payment_addr.bech32).toMatch(/^addr_test1/);
    });

    it('excludes failed transactions instead of indexing collateral-era outputs or mint data', () => {
        // Invariant: failed on-chain transactions never mutate Handle state.
        // Failure caught: removing the successful check makes this negative control return an indexable transaction.
        expect(convertDemeterTx(tx('1', { successful: false }), block(100, 50, '2'))).toBeNull();
    });

    it('fails closed for unsupported reference-script versions', () => {
        // Invariant: script hashes are never derived with an invented Plutus language tag.
        // Failure caught: a permissive fallback would silently index this V4 script as V2/V3.
        const unsupported = tx('1', {
            outputs: [{ address, coin: coin(1n), assets: [], script: { script: { case: 'plutusV4', value: bytes('01') } } }]
        });
        expect(() => convertDemeterTx(unsupported, block(100, 50, '2'))).toThrow('unsupported reference script type plutusV4');
    });
});

describe('Demeter complete-block buffering', () => {
    it('commits matching transactions in stream order only after the following block begins', async () => {
        // Invariant: all matching transactions from one block are committed atomically and in chain order.
        // Failure caught: processing the first apply eagerly would expose a partial block before the second transaction arrives.
        const committed: DemeterBlock[] = [];
        await consumeCompleteDemeterBlocks(
            events([apply(100, 50, '2', '1'), apply(100, 50, '2', '3'), idle(120, 51, '4')]),
            { slot: 120, hash: '4'.repeat(64) },
            async (value) => { committed.push(value); }
        );

        expect(committed).toHaveLength(1);
        expect(committed[0].ref).toEqual({ slot: 100, height: 50, hash: '2'.repeat(64) });
        expect(committed[0].transactions.map((value) => value.tx_hash)).toEqual(['1'.repeat(64), '3'.repeat(64)]);
    });

    it('deduplicates repeated events without advancing through a skipped block height', async () => {
        // Invariant: Demeter retries are idempotent, while an actual gap halts the scanner.
        // Failure caught: without duplicate suppression this block would contain the same tx twice.
        const committed: DemeterBlock[] = [];
        await consumeCompleteDemeterBlocks(
            events([apply(100, 50, '2', '1'), apply(100, 50, '2', '1'), idle(120, 51, '4')]),
            { slot: 120, hash: '4'.repeat(64) },
            async (value) => { committed.push(value); }
        );
        expect(committed[0].transactions).toHaveLength(1);

        await expect(consumeCompleteDemeterBlocks(
            events([idle(100, 50, '2'), idle(140, 52, '4')]),
            { slot: 160, hash: '5'.repeat(64) },
            async () => undefined
        )).rejects.toThrow('skipped height 51');
    });

    it('halts on undo without committing the incomplete block', async () => {
        // Invariant: rollback events enter canonical recovery; they are never reversed piecemeal.
        // Failure caught: treating undo like apply/idle would advance the persisted scanner cursor on a fork.
        const committed: DemeterBlock[] = [];
        const undo = { ...apply(100, 50, '2', '1'), action: 'undo' } as CardanoTxEvent;
        await expect(consumeCompleteDemeterBlocks(
            events([undo]),
            { slot: 120, hash: '4'.repeat(64) },
            async (value) => { committed.push(value); }
        )).rejects.toBeInstanceOf(DemeterRollbackError);
        expect(committed).toEqual([]);
    });
});

describe('Demeter configuration', () => {
    const originalEnv = process.env;

    beforeEach(() => {
        process.env = { ...originalEnv };
    });

    afterAll(() => {
        process.env = originalEnv;
    });

    it('normalizes a host-only endpoint and enables Demeter only by explicit source selection', () => {
        // Invariant: credentials alone do not cut over a scanner, and Demeter accepts the host format issued by the provider.
        // Failure caught: implicit activation would unexpectedly mutate environments where credentials were staged for shadowing.
        process.env.DEMETER_UTXORPC_ENDPOINT = 'example.demeter.run:443';
        process.env.DEMETER_UTXORPC_API_KEY = 'secret';
        expect(getDemeterConfig()).toEqual({ endpoint: 'https://example.demeter.run:443', apiKey: 'secret' });
        expect(isDemeterScannerEnabled()).toBe(false);
        process.env.SCANNER_CHAIN_SOURCE = 'demeter';
        expect(isDemeterScannerEnabled()).toBe(true);
    });

    it('rejects incomplete credentials', () => {
        // Invariant: an explicitly selected chain source fails closed when its authentication is incomplete.
        // Failure caught: silently falling back here would hide a broken preview cutover.
        delete process.env.DEMETER_UTXORPC_ENDPOINT;
        process.env.DEMETER_UTXORPC_API_KEY = 'secret';
        expect(() => getDemeterConfig()).toThrow('requires DEMETER_UTXORPC_ENDPOINT and DEMETER_UTXORPC_API_KEY');
    });
});
