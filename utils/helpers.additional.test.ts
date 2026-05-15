import { AssetNameLabel } from '@koralabs/kora-labs-common';
import { buildUTxOsFromKoiosTxs, fetchKoios } from './helpers';

describe('helpers additional tests', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
        global.fetch = originalFetch;
        jest.restoreAllMocks();
    });

    it('fetchKoios returns null on an empty successful response body', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            text: async () => ''
        }) as any;

        await expect(fetchKoios('tip')).resolves.toBeNull();
    });

    it('fetchKoios attaches parsed error response payload when json parsing succeeds', async () => {
        global.fetch = jest.fn().mockResolvedValue({
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
            text: async () => JSON.stringify({ message: 'upstream unavailable', code: 'X123' })
        }) as any;

        await expect(fetchKoios('tip')).rejects.toMatchObject({
            status: 503,
            statusText: 'Service Unavailable',
            koiosResponse: { message: 'upstream unavailable', code: 'X123' }
        });
    });

    it('buildUTxOsFromKoiosTxs keeps metadata version, maps reference scripts, and sorts CIP67 owner tokens first', () => {
        const policy = 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a';
        const ownerToken = `${AssetNameLabel.LBL_222}616263`; // "abc"
        const plainHexName = '6e616d65'; // "name"

        const txs = [
            {
                tx_hash: 'tx-1',
                block_hash: 'block-1',
                block_height: 10,
                absolute_slot: 100,
                assets_minted: [
                    { policy_id: policy, asset_name: ownerToken, quantity: '1' },
                    { policy_id: policy, asset_name: plainHexName, quantity: '-1' }
                ],
                outputs: [
                    {
                        tx_hash: 'tx-1',
                        tx_index: 0,
                        value: '1',
                        asset_list: [{ policy_id: policy, asset_name: plainHexName }],
                        payment_addr: { bech32: 'addr_test1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' },
                        inline_datum: { bytes: 'abcd' },
                        reference_script: { bytes: 'ef01' }
                    },
                    {
                        tx_hash: 'tx-1',
                        tx_index: 1,
                        value: '1',
                        asset_list: [{ policy_id: policy, asset_name: ownerToken }],
                        payment_addr: { bech32: 'addr_test1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq' },
                        inline_datum: null,
                        reference_script: null
                    }
                ],
                metadata: {
                    '721': {
                        version: '2',
                        [policy]: {
                            name: { image: 'ipfs://name' },
                            abc: { image: 'ipfs://abc' }
                        }
                    }
                }
            }
        ] as any;

        const utxos = buildUTxOsFromKoiosTxs(txs);

        expect(utxos).toHaveLength(2);
        expect(utxos[0].handles?.[0]?.[1]?.[0]).toBe(ownerToken);
        expect(utxos.some((utxo) => utxo.metadata?.['721']?.version === '2')).toBe(true);
        expect(utxos[1].script).toEqual({
            type: 'plutusV2',
            cbor: 'ef01'
        });
    });

    // Regression: previously `for (const o of t.outputs)` threw if Koios ever
    // returned outputs:undefined for a tx — the surrounding scanner caught the
    // throw and silently advanced the cursor past the block.
    it('buildUTxOsFromKoiosTxs treats a tx with no outputs as zero UTxOs (no throw)', () => {
        const txs = [
            {
                tx_hash: 'tx-no-outputs',
                block_hash: 'block-1',
                block_height: 10,
                absolute_slot: 100,
                assets_minted: [],
                outputs: undefined,
                metadata: {}
            }
        ] as any;

        expect(() => buildUTxOsFromKoiosTxs(txs)).not.toThrow();
        expect(buildUTxOsFromKoiosTxs(txs)).toEqual([]);
    });
});
