import { AssetNameLabel, buildNumericModifiers, getRarity, Logger } from '@koralabs/kora-labs-common';
import v8 from 'v8';
import { buildOgmiosTransaction, buildOnChainObject, fetchHealth, getHandleNameFromAssetName, memoryWatcher } from '../utils';

type DoesZapCodeSpaceFlag = 0 | 1;

describe('Utils Tests', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
        jest.restoreAllMocks();
        if (originalFetch) global.fetch = originalFetch;
        else delete (global as any).fetch;
    });

    describe('buildOnChainObject tests', () => {
        const cborObject = {
            map: [
                {
                    k: {
                        string: '123'
                    },
                    v: {
                        map: [
                            {
                                k: {
                                    string: 'burritos'
                                },
                                v: {
                                    map: [
                                        {
                                            k: {
                                                string: 'image'
                                            },
                                            v: {
                                                string: `ifps://some_hash`
                                            }
                                        },
                                        {
                                            k: {
                                                string: 'core'
                                            },
                                            v: {
                                                map: [
                                                    {
                                                        k: {
                                                            string: 'og'
                                                        },
                                                        v: {
                                                            int: BigInt(1)
                                                        }
                                                    }
                                                ]
                                            }
                                        }
                                    ]
                                }
                            }
                        ]
                    }
                }
            ]
        };

        const results = buildOnChainObject(cborObject);
        expect(results).toEqual({ '123': { burritos: { core: { og: 1 }, image: 'ifps://some_hash' } } });

        it('returns null and logs when parsing fails', () => {
            const loggerSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());
            const invalidCborObject = {
                map: [
                    {
                        k: { string: '123' },
                        v: { string: 'value-with-"quote' }
                    }
                ]
            };

            const result = buildOnChainObject(invalidCborObject);

            expect(result).toBeNull();
            expect(loggerSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    event: 'buildOnChainObject',
                    message: expect.stringContaining('Error building metadata:')
                })
            );
        });

        it('parses non-map objects with numeric values and key commas', () => {
            const result = buildOnChainObject<{ name: string; count: number }>({
                name: 'plain',
                count: 7
            });

            expect(result).toEqual({ name: 'plain', count: 7 });
        });

        it('parses list-based map values and empty fallback values', () => {
            const result = buildOnChainObject<{ listy: unknown; empty: string }>({
                map: [
                    {
                        k: { string: 'listy' },
                        v: { list: [1, 2] }
                    },
                    {
                        k: { string: 'empty' },
                        v: {}
                    }
                ]
            });

            expect(result).toEqual({ listy: { '0': 1, '1': 2 }, empty: '' });
        });
    });

    describe('fetchHealth', () => {
        it('returns parsed ogmios health response', async () => {
            const mockedFetch = jest.fn();
            global.fetch = mockedFetch as any;
            mockedFetch.mockResolvedValue({
                json: jest.fn().mockResolvedValue({ networkSynchronization: 100 })
            } as any);

            const result = await fetchHealth();

            expect(mockedFetch).toHaveBeenCalledWith(expect.stringContaining('/health'));
            expect(result).toEqual({ networkSynchronization: 100 });
        });

        it('logs and returns null on fetch failure', async () => {
            const mockedFetch = jest.fn();
            global.fetch = mockedFetch as any;
            mockedFetch.mockRejectedValue(new Error('health-check failed'));
            const loggerSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());

            const result = await fetchHealth();

            expect(result).toBeNull();
            expect(loggerSpy).toHaveBeenCalledWith({
                message: 'health-check failed',
                category: 'ERROR',
                event: 'fetchOgmiosHealth.error'
            });
        });
    });

    describe('buildOgmiosTransaction', () => {
        it('converts koios transaction shape to ogmios transaction', () => {
            const tx = buildOgmiosTransaction({
                tx_hash: 'tx_hash_1',
                assets_minted: [
                    { policy_id: 'policy_1', asset_name: 'asset_a', quantity: '1' },
                    { policy_id: 'policy_1', asset_name: 'asset_b', quantity: '2' }
                ],
                outputs: [
                    {
                        payment_addr: { bech32: 'addr_test1abc' },
                        value: '1000000',
                        asset_list: [{ policy_id: 'policy_2', asset_name: 'asset_c', quantity: '3' }],
                        inline_datum: { bytes: 'd87980' },
                        reference_script: null
                    },
                    {
                        payment_addr: { bech32: 'addr_test1def' },
                        value: '2000000'
                    }
                ],
                metadata: {
                    '721': { some: 'metadata' }
                }
            });

            expect(tx).toEqual(
                expect.objectContaining({
                    id: 'tx_hash_1',
                    spends: 'inputs',
                    mint: {
                        policy_1: {
                            asset_a: BigInt(1),
                            asset_b: BigInt(2)
                        }
                    }
                })
            );
            expect(tx.outputs[0]).toEqual({
                address: 'addr_test1abc',
                value: {
                    ada: { lovelace: BigInt(1000000) },
                    policy_2: { asset_c: BigInt(3) }
                },
                datum: 'd87980',
                script: undefined
            });
            expect(tx.outputs[1]).toEqual({
                address: 'addr_test1def',
                value: { ada: { lovelace: BigInt(2000000) } },
                datum: undefined,
                script: undefined
            });
            expect(tx.metadata?.labels).toEqual({
                '721': { json: { some: 'metadata' } }
            });
        });

        it('handles missing metadata by returning empty labels', () => {
            const tx = buildOgmiosTransaction({
                tx_hash: 'tx_hash_no_meta',
                assets_minted: [],
                outputs: [
                    {
                        payment_addr: { bech32: 'addr_test1ghi' },
                        value: '1000000'
                    }
                ]
            });

            expect(tx.metadata?.labels).toEqual({});
        });
    });

    describe('buildNumericModifiers tests', () => {
        it('should be negative', () => {
            const result = buildNumericModifiers('-1');
            expect(result).toEqual('negative');
        });

        it('should be decimal', () => {
            const result = buildNumericModifiers('0.1');
            expect(result).toEqual('decimal');
        });

        it('should be negative decimal', () => {
            const result = buildNumericModifiers('-0.1');
            expect(result).toEqual('negative,decimal');
        });

        it('should be blank for characters', () => {
            const blankSets = ['1a', '1', '-.-', '--1', '1.2.'];

            blankSets.forEach((set) => {
                const result = buildNumericModifiers(set);
                expect(`${set} should be "${result}"`).toEqual(`${set} should be ""`);
            });
        });
    });

    describe('getRarity', () => {
        it('should return basic rarity', () => {
            const rarity = getRarity('will_be_common');
            expect(rarity).toEqual('basic');
        });

        it('should return common rarity', () => {
            const rarity = getRarity('common');
            expect(rarity).toEqual('common');
        });

        it('should return rare rarity', () => {
            const rarity = getRarity('_._');
            expect(rarity).toEqual('rare');
        });

        it('should return ultra rare rarity', () => {
            const rarity = getRarity('__');
            expect(rarity).toEqual('ultra_rare');
        });

        it('should return legendary rarity', () => {
            const rarity = getRarity('.');
            expect(rarity).toEqual('legendary');
        });
    });

    describe('memoryWatcher', () => {
        const buildHeapInfo = (usedSize?: number, sizeLimit?: number): v8.HeapInfo => ({
            total_heap_size: 0,
            total_heap_size_executable: 0,
            total_physical_size: 0,
            total_available_size: 0,
            used_heap_size: usedSize ?? 0,
            heap_size_limit: sizeLimit ?? 0,
            malloced_memory: 0,
            peak_malloced_memory: 0,
            does_zap_garbage: 0 as DoesZapCodeSpaceFlag,
            number_of_native_contexts: 0,
            number_of_detached_contexts: 0,
            total_global_handles_size: 0,
            used_global_handles_size: 0,
            external_memory: 0
        });

        it('should log a notification and kill the process', () => {
            // This is needed since Jest will error out if console.error is called
            const original = console.error;
            console.error = jest.fn();
            const loggerSpy = jest.spyOn(Logger, 'log');
            jest.spyOn(v8, 'getHeapStatistics').mockReturnValue(buildHeapInfo(2097815296, 2197815296));
            memoryWatcher();
            expect(loggerSpy).toHaveBeenCalledWith({
                category: 'NOTIFY',
                event: 'memoryWatcher.limit.reached',
                message: 'Memory usage has reached the limit (95%)'
            });
            console.error = original
        });

        it('should log a warning', () => {
            const loggerSpy = jest.spyOn(Logger, 'log');
            jest.spyOn(v8, 'getHeapStatistics').mockReturnValue(buildHeapInfo(1797815296, 2197815296));
            memoryWatcher();
            expect(loggerSpy).toHaveBeenCalledWith({
                category: 'INFO',
                event: 'memoryWatcher.limit.close',
                message: 'Memory usage close to the limit (82%)'
            });
        });

        it('should not log below warning threshold', () => {
            const loggerSpy = jest.spyOn(Logger, 'log');
            jest.spyOn(v8, 'getHeapStatistics').mockReturnValue(buildHeapInfo(879781529, 2197815296));

            memoryWatcher();

            expect(loggerSpy).not.toHaveBeenCalled();
        });

        it('kills process when usage is above 90 outside test environment', async () => {
            const exitSpy = jest.spyOn(process, 'exit').mockImplementation(jest.fn() as never);
            jest.spyOn(v8, 'getHeapStatistics').mockReturnValue(buildHeapInfo(2097815296, 2197815296));
            let isolatedWatcher: (() => void) | undefined;

            await jest.isolateModulesAsync(async () => {
                jest.doMock('../../../config', () => ({
                    ...jest.requireActual('../../../config'),
                    NODE_ENV: 'local'
                }));
                const mod = await import('../utils');
                isolatedWatcher = mod.memoryWatcher;
                jest.dontMock('../../../config');
            });

            isolatedWatcher?.();

            expect(isolatedWatcher).toEqual(expect.any(Function));
            expect(exitSpy).toHaveBeenCalledWith(1);
        });
    });

    describe('getHandleNameFromAssetName', () => {
        const asset1 = '6275727269746f'
        const expectedHandle = { name: 'burrito', isCip67: false, assetLabel: AssetNameLabel.NONE };
        it('should return handle name from hex', () => {
            const handle = getHandleNameFromAssetName(asset1);
            expect(handle).toEqual({
                ...expectedHandle,
                ownerTokenHex: asset1
            });
        });

        it('should return handle name from policyId.hex', () => {
            const asset2 = 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a.6275727269746f';
            const handle = getHandleNameFromAssetName(asset2);
            expect(handle).toEqual({
                ...expectedHandle,
                ownerTokenHex: '6275727269746f'
            });
        });

        it('should strip off 222 asset name label and return handle name', () => {
            const asset = `f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a.${AssetNameLabel.LBL_222}6275727269746f`;
            const handle = getHandleNameFromAssetName(asset);
            expect(handle).toEqual({
                assetLabel: AssetNameLabel.LBL_222,
                ownerTokenHex: `${AssetNameLabel.LBL_222}6275727269746f`,
                name: 'burrito',
                isCip67: true
            });
        });

        it('should strip off 100 asset name label and return handle name', () => {
            const asset = `f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a.${AssetNameLabel.LBL_100}6275727269746f`;
            const handle = getHandleNameFromAssetName(asset);
            expect(handle).toEqual({
                assetLabel: AssetNameLabel.LBL_100,
                ownerTokenHex: `${AssetNameLabel.LBL_222}6275727269746f`,
                name: 'burrito',
                isCip67: true
            });
        });

        it('should keep 000 asset label for owner token mapping', () => {
            const asset = `f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a.${AssetNameLabel.LBL_000}6275727269746f`;
            const handle = getHandleNameFromAssetName(asset);
            expect(handle).toEqual({
                assetLabel: AssetNameLabel.LBL_000,
                ownerTokenHex: `${AssetNameLabel.LBL_000}6275727269746f`,
                name: 'burrito',
                isCip67: true
            });
        });
    });
});
