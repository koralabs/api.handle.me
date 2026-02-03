import { KoiosAssetUTxO } from '../interfaces/provider.interface';
import * as rollbackModule from './rollback';

// Mock the dependencies
jest.mock('../utils/helpers');
jest.mock('../stores/redis');
jest.mock('../repositories/handlesRepository');

// Now import mocked modules

describe('Rollback Lambda', () => {
    describe('buildUtxoWithTxInfoFromKoiosUtxo', () => {
        it('should convert KoiosAssetUTxO to UTxOWithTxInfo', () => {
            const koiosUtxo: KoiosAssetUTxO = {
                asset_list: [],
                block_height: 1,
                reference_script: null,
                inline_datum: null,
                value: '2000000',
                address: 'addr_test123',
                tx_hash: 'txhash123',
                tx_index: 0
            };

            const result = (rollbackModule as any).buildUtxoWithTxInfoFromKoiosUtxo(koiosUtxo);

            expect(result.id).toBe('txhash123#0');
            expect(result.tx_id).toBe('txhash123');
            expect(result.index).toBe(0);
            expect(result.address).toBe('addr_test123');
            expect(result.lovelace).toBe(2000000);
            expect(result.blockNum).toBe(1);
            expect(result.datum).toBeUndefined();
            expect(result.script).toBeUndefined();
        });

        it('should include inline datum when present', () => {
            const koiosUtxo: KoiosAssetUTxO = {
                asset_list: [],
                block_height: 1,
                reference_script: null,
                inline_datum: {
                    bytes: 'd8799f581c'
                },
                value: '2000000',
                address: 'addr_test123',
                tx_hash: 'txhash123',
                tx_index: 1
            };

            const result = (rollbackModule as any).buildUtxoWithTxInfoFromKoiosUtxo(koiosUtxo);

            expect(result.datum).toBe('d8799f581c');
        });

        it('should include reference script when present', () => {
            const koiosUtxo: KoiosAssetUTxO = {
                asset_list: [],
                block_height: 1,
                reference_script: {
                    bytes: 'scriptbytes123',
                    type: 'PlutusScriptV3'
                },
                inline_datum: null,
                value: '2000000',
                address: 'addr_test123',
                tx_hash: 'txhash123',
                tx_index: 2
            };

            const result = (rollbackModule as any).buildUtxoWithTxInfoFromKoiosUtxo(koiosUtxo);

            expect(result.script).toEqual({
                type: 'PlutusScriptV3',
                cbor: 'scriptbytes123'
            });
        });

        it('should handle large lovelace values', () => {
            const koiosUtxo: KoiosAssetUTxO = {
                asset_list: [],
                block_height: 1,
                reference_script: null,
                inline_datum: null,
                value: '9223372036854775807', // Max safe integer
                address: 'addr_test123',
                tx_hash: 'txhash123',
                tx_index: 0
            };

            const result = (rollbackModule as any).buildUtxoWithTxInfoFromKoiosUtxo(koiosUtxo);

            expect(result.lovelace).toBe(9223372036854775807);
        });

        it('should use default PlutusScriptV2 type when reference script type is not provided', () => {
            const koiosUtxo: KoiosAssetUTxO = {
                asset_list: [],
                block_height: 1,
                reference_script: {
                    bytes: 'scriptbytes123',
                    type: ''
                },
                inline_datum: null,
                value: '2000000',
                address: 'addr_test123',
                tx_hash: 'txhash123',
                tx_index: 0
            };

            const result = (rollbackModule as any).buildUtxoWithTxInfoFromKoiosUtxo(koiosUtxo);

            expect(result.script?.type).toBe('PlutusScriptV2');
        });
    });

    describe('lambdaHandler', () => {
        // Note: Testing lambdaHandler fully requires proper module-level dependency injection
        // For now, we primarily test the buildUtxoWithTxInfoFromKoiosUtxo helper function
        // A full test would require refactoring the module to allow dependency injection

        it('should export lambdaHandler as a function', () => {
            expect(typeof (rollbackModule as any).lambdaHandler).toBe('function');
        });
    });
});
