import { AssetNameLabel, buildNumericModifiers, getRarity, Logger } from '@koralabs/kora-labs-common';
import v8 from 'v8';
import { buildOnChainObject, getHandleNameFromAssetName, memoryWatcher } from '../utils';

type DoesZapCodeSpaceFlag = 0 | 1;

describe('Utils Tests', () => {
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
    });
});
