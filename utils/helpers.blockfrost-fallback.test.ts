import { NETWORK } from '@koralabs/kora-labs-common';
import { fetchBlockfrostTxHashes, fetchBlockfrostTxInfo, fetchBlockfrostDatumCbor } from './helpers';

describe('Blockfrost fallback functions', () => {
    const originalFetch = global.fetch;
    const originalBlockfrostApiKey = process.env.BLOCKFROST_API_KEY;

    beforeEach(() => {
        process.env.BLOCKFROST_API_KEY = 'test-key';
    });

    afterEach(() => {
        process.env.BLOCKFROST_API_KEY = originalBlockfrostApiKey;
        global.fetch = originalFetch;
        jest.restoreAllMocks();
    });

    describe('fetchBlockfrostTxHashes', () => {
        it('returns tx hashes for multiple blocks via Blockfrost pagination', async () => {
            const fetchMock = jest.fn().mockImplementation(async (url: string) => {
                if (url.includes('blocks/block1/txs')) {
                    return { status: 200, json: async () => ['tx1', 'tx2'] };
                }
                if (url.includes('blocks/block2/txs')) {
                    return { status: 200, json: async () => ['tx3'] };
                }
                return { status: 200, json: async () => [] };
            });
            global.fetch = fetchMock as any;

            const result = await fetchBlockfrostTxHashes(['block1', 'block2']);

            expect(result).toEqual(['tx1', 'tx2', 'tx3']);
        });

        it('returns empty array when blocks have no transactions', async () => {
            global.fetch = jest.fn().mockResolvedValue({
                status: 404,
                json: async () => []
            }) as any;

            const result = await fetchBlockfrostTxHashes(['empty-block']);
            expect(result).toEqual([]);
        });
    });

    describe('fetchBlockfrostTxInfo', () => {
        const mockTxData = {
            block: 'block_hash_abc',
            block_height: 12345,
            slot: 67890,
            asset_mint_or_burn_count: 1
        };

        const mockUtxoData = {
            hash: 'tx_abc',
            inputs: [
                {
                    tx_hash: 'prev_tx',
                    output_index: 0,
                    amount: [
                        { unit: 'lovelace', quantity: '5000000' },
                        { unit: 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a68616e646c65', quantity: '1' }
                    ],
                    collateral: false,
                    reference: false
                }
            ],
            outputs: [
                {
                    address: 'addr_test1qz...',
                    output_index: 0,
                    amount: [
                        { unit: 'lovelace', quantity: '2000000' },
                        { unit: 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a68616e646c65', quantity: '1' }
                    ],
                    data_hash: null,
                    inline_datum: null,
                    collateral: false,
                    reference_script_hash: null
                },
                {
                    address: 'addr_test1qz...change',
                    output_index: 1,
                    amount: [
                        { unit: 'lovelace', quantity: '3000000' }
                    ],
                    data_hash: 'datum_hash_123',
                    inline_datum: null,
                    collateral: false,
                    reference_script_hash: null
                }
            ]
        };

        const mockMetadata = [
            {
                label: '721',
                json_metadata: {
                    f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                        handle: { name: 'test' }
                    }
                }
            }
        ];

        it('maps Blockfrost tx data to KoiosTxInfo format', async () => {
            const fetchMock = jest.fn().mockImplementation(async (url: string) => {
                if (url.includes('/txs/tx_abc/utxos')) {
                    return { ok: true, status: 200, json: async () => mockUtxoData };
                }
                if (url.includes('/txs/tx_abc/metadata')) {
                    return { ok: true, status: 200, json: async () => mockMetadata };
                }
                if (url.includes('/txs/tx_abc')) {
                    return { ok: true, status: 200, json: async () => mockTxData };
                }
                return { ok: false, status: 404, statusText: 'Not Found' };
            });
            global.fetch = fetchMock as any;

            const result = await fetchBlockfrostTxInfo('tx_abc');

            expect(result.tx_hash).toBe('tx_abc');
            expect(result.block_hash).toBe('block_hash_abc');
            expect(result.block_height).toBe(12345);
            expect(result.absolute_slot).toBe(67890);
            expect(result.inputs).toEqual([{ tx_hash: 'prev_tx', tx_index: 0 }]);
            expect(result.outputs).toHaveLength(2);
            expect(result.outputs[0].payment_addr.bech32).toBe('addr_test1qz...');
            expect(result.outputs[0].value).toBe('2000000');
            expect(result.outputs[0].asset_list).toHaveLength(1);
            expect(result.outputs[0].asset_list[0].policy_id).toBe('f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a');
            expect(result.outputs[0].asset_list[0].asset_name).toBe('68616e646c65');
            expect(result.outputs[1].datum_hash).toBe('datum_hash_123');
            expect(result.metadata).toHaveProperty('721');
        });

        it('computes minted assets from input/output difference', async () => {
            const mintUtxoData = {
                hash: 'tx_mint',
                inputs: [
                    {
                        tx_hash: 'prev',
                        output_index: 0,
                        amount: [{ unit: 'lovelace', quantity: '5000000' }],
                        collateral: false,
                        reference: false
                    }
                ],
                outputs: [
                    {
                        address: 'addr_test1...',
                        output_index: 0,
                        amount: [
                            { unit: 'lovelace', quantity: '2000000' },
                            { unit: 'aabb' + '00'.repeat(25) + 'cc', quantity: '3' }
                        ],
                        data_hash: null,
                        inline_datum: null,
                        collateral: false,
                        reference_script_hash: null
                    }
                ]
            };

            const fetchMock = jest.fn().mockImplementation(async (url: string) => {
                if (url.includes('/utxos')) {
                    return { ok: true, status: 200, json: async () => mintUtxoData };
                }
                if (url.includes('/metadata')) {
                    return { ok: false, status: 404, statusText: 'Not Found' };
                }
                return { ok: true, status: 200, json: async () => ({ block: 'b', block_height: 1, slot: 1, asset_mint_or_burn_count: 1 }) };
            });
            global.fetch = fetchMock as any;

            const result = await fetchBlockfrostTxInfo('tx_mint');

            expect(result.assets_minted).toHaveLength(1);
            expect(result.assets_minted[0].quantity).toBe('3');
        });

        it('skips metadata fetch when no assets minted or burned', async () => {
            const noMintUtxoData = {
                hash: 'tx_transfer',
                inputs: [
                    {
                        tx_hash: 'prev',
                        output_index: 0,
                        amount: [{ unit: 'lovelace', quantity: '5000000' }],
                        collateral: false,
                        reference: false
                    }
                ],
                outputs: [
                    {
                        address: 'addr...',
                        output_index: 0,
                        amount: [{ unit: 'lovelace', quantity: '3000000' }],
                        data_hash: null,
                        inline_datum: null,
                        collateral: false,
                        reference_script_hash: null
                    }
                ]
            };

            const fetchMock = jest.fn().mockImplementation(async (url: string) => {
                if (url.includes('/utxos')) {
                    return { ok: true, status: 200, json: async () => noMintUtxoData };
                }
                return { ok: true, status: 200, json: async () => ({ block: 'b', block_height: 1, slot: 1, asset_mint_or_burn_count: 0 }) };
            });
            global.fetch = fetchMock as any;

            const result = await fetchBlockfrostTxInfo('tx_transfer');

            expect(result.metadata).toEqual({});
            // Should NOT have called /metadata endpoint
            const metadataCalls = (fetchMock as jest.Mock).mock.calls.filter(
                (call: any[]) => call[0].includes('/metadata')
            );
            expect(metadataCalls).toHaveLength(0);
        });

        it('handles inline datums from Blockfrost', async () => {
            const inlineDatumUtxoData = {
                hash: 'tx_datum',
                inputs: [],
                outputs: [
                    {
                        address: 'addr...',
                        output_index: 0,
                        amount: [{ unit: 'lovelace', quantity: '2000000' }],
                        data_hash: null,
                        inline_datum: 'd87980',
                        collateral: false,
                        reference_script_hash: null
                    }
                ]
            };

            const fetchMock = jest.fn().mockImplementation(async (url: string) => {
                if (url.includes('/utxos')) {
                    return { ok: true, status: 200, json: async () => inlineDatumUtxoData };
                }
                return { ok: true, status: 200, json: async () => ({ block: 'b', block_height: 1, slot: 1, asset_mint_or_burn_count: 0 }) };
            });
            global.fetch = fetchMock as any;

            const result = await fetchBlockfrostTxInfo('tx_datum');

            expect(result.outputs[0].inline_datum).toEqual({ bytes: 'd87980', value: {} });
        });

        it('excludes collateral inputs and outputs', async () => {
            const collateralUtxoData = {
                hash: 'tx_collateral',
                inputs: [
                    { tx_hash: 'real_input', output_index: 0, amount: [{ unit: 'lovelace', quantity: '5000000' }], collateral: false, reference: false },
                    { tx_hash: 'collateral_input', output_index: 1, amount: [{ unit: 'lovelace', quantity: '10000000' }], collateral: true, reference: false }
                ],
                outputs: [
                    { address: 'addr1', output_index: 0, amount: [{ unit: 'lovelace', quantity: '3000000' }], data_hash: null, inline_datum: null, collateral: false, reference_script_hash: null },
                    { address: 'addr2', output_index: 1, amount: [{ unit: 'lovelace', quantity: '7000000' }], data_hash: null, inline_datum: null, collateral: true, reference_script_hash: null }
                ]
            };

            const fetchMock = jest.fn().mockImplementation(async (url: string) => {
                if (url.includes('/utxos')) return { ok: true, status: 200, json: async () => collateralUtxoData };
                return { ok: true, status: 200, json: async () => ({ block: 'b', block_height: 1, slot: 1, asset_mint_or_burn_count: 0 }) };
            });
            global.fetch = fetchMock as any;

            const result = await fetchBlockfrostTxInfo('tx_collateral');

            expect(result.inputs).toHaveLength(1);
            expect(result.inputs[0].tx_hash).toBe('real_input');
            expect(result.outputs).toHaveLength(1);
            expect(result.outputs[0].payment_addr.bech32).toBe('addr1');
        });

        it('maps reference inputs separately', async () => {
            const refInputUtxoData = {
                hash: 'tx_ref',
                inputs: [
                    { tx_hash: 'normal', output_index: 0, amount: [{ unit: 'lovelace', quantity: '5000000' }], collateral: false, reference: false },
                    { tx_hash: 'ref_script', output_index: 1, amount: [], collateral: false, reference: true }
                ],
                outputs: [
                    { address: 'addr1', output_index: 0, amount: [{ unit: 'lovelace', quantity: '3000000' }], data_hash: null, inline_datum: null, collateral: false, reference_script_hash: null }
                ]
            };

            const fetchMock = jest.fn().mockImplementation(async (url: string) => {
                if (url.includes('/utxos')) return { ok: true, status: 200, json: async () => refInputUtxoData };
                return { ok: true, status: 200, json: async () => ({ block: 'b', block_height: 1, slot: 1, asset_mint_or_burn_count: 0 }) };
            });
            global.fetch = fetchMock as any;

            const result = await fetchBlockfrostTxInfo('tx_ref');

            expect(result.inputs).toHaveLength(1);
            expect(result.reference_inputs).toHaveLength(1);
            expect(result.reference_inputs[0].tx_hash).toBe('ref_script');
        });
    });

    describe('fetchBlockfrostDatumCbor', () => {
        it('returns datum CBOR for valid hash', async () => {
            global.fetch = jest.fn().mockResolvedValue({
                ok: true,
                status: 200,
                json: async () => ({ cbor: 'd87980' })
            }) as any;

            const result = await fetchBlockfrostDatumCbor('datum_hash_abc');

            expect(result).toBe('d87980');
        });

        it('returns null when datum is not found', async () => {
            global.fetch = jest.fn().mockResolvedValue({
                ok: false,
                status: 404,
                statusText: 'Not Found'
            }) as any;

            const result = await fetchBlockfrostDatumCbor('nonexistent');

            expect(result).toBeNull();
        });
    });
});
