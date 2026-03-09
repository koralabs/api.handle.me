import { scripts } from '../config/scripts';
import { ScriptDetails, ScriptType } from '@koralabs/kora-labs-common';
import ScriptsController from './scripts.controller'

const mockResponse = () => {
    const res = {json: jest.fn(), status: jest.fn(), send: jest.fn()};
    res.json = jest.fn().mockReturnValue(res);
    res.send = jest.fn().mockReturnValue(res);
    res.status = jest.fn().mockReturnValue(res);
    return res;
}

const mockRequest = (query = {}, app?: any) =>
    ({ query, app } as any);

const mockRegistry = (handles: Record<string, any>) => ({
    handlesStore: class {
        getHashFromIndex(_index: string, key: string) {
            return handles[key];
        }

        getKeysFromIndex() {
            return Object.keys(handles);
        }

        getValuesFromIndexedSet() {
            return undefined;
        }

        getMetrics() {
            return {
                currentSlot: 10,
                lastSlot: 10,
                currentBlockHash: 'a',
                tipBlockHash: 'a'
            };
        }
    }
});

afterAll(async () => {
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 500));
});

describe('Scripts Routes Test', () => {
    const originalNetwork = process.env.NETWORK;

    afterAll(() => {
        process.env.NETWORK = originalNetwork;
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('[GET] /scripts', () => {
        it('Should only find 1 latest script for each type and network', async () => {
            const mainnet = scripts.mainnet;
            const preprod = scripts.preprod;
            const preview = scripts.preview;

            expect(Object.values(mainnet).filter((script) => script.latest && script.type === ScriptType.PZ_CONTRACT).length).toEqual(1);
            expect(Object.values(preprod).filter((script) => script.latest && script.type === ScriptType.PZ_CONTRACT).length).toEqual(1);
            expect(Object.values(preview).filter((script) => script.latest && script.type === ScriptType.PZ_CONTRACT).length).toEqual(1);
            // types
            // expect(Object.values(mainnet).filter((script) => script.latest && script.type === ScriptType.SUB_HANDLE_SETTINGS).length).toEqual(1);
            // expect(Object.values(preprod).filter((script) => script.latest && script.type === ScriptType.SUB_HANDLE_SETTINGS).length).toEqual(1);
            expect(Object.values(preview).filter((script) => script.latest && script.type === ScriptType.SUB_HANDLE_SETTINGS).length).toEqual(1);
        });

        it('Should point mainnet legacy scripts at the migrated multisig outputs', async () => {
            const migratedWalletAddress = 'addr1x8gyj64hexlrex28va3j3kavxlwt88g0qkr2yt6wa8zff9pwn0ud438rhxc06hnnsl8jxa6xdnc60dgqrqm0n5nre4ws0qt2wn';
            const expectedRefs = {
                'mint_proxy@handle_settings': '2ffdbfdcebc7be19c9258749b3ceb063c627eb9363ff5f7992baa70e09124b65#1',
                'mint_v1@handle_settings': 'ddbd12828488243e1403edaa879674461595c88d502e70067f99cba8e1b6a167#3',
                'mint_data@handle_settings': 'ddbd12828488243e1403edaa879674461595c88d502e70067f99cba8e1b6a167#0',
                'orders@handle_settings': 'd10782b107ed1c21766d604b198df7ca17938b125a3b59e495126e0792c8797a#1',
                'pz_contract_04': 'd87a84bcb75aaf3356c088f95a3e69650e207e04184e5684ff7faf9c8ed7bc03#0',
                'sub_settings_01': 'b6456be5d07446fad8c4fe06cfe22965d98c7e3a9da19d3cb8eab5019d957fda#3',
                'marketplace@handle_scripts': 'b6456be5d07446fad8c4fe06cfe22965d98c7e3a9da19d3cb8eab5019d957fda#2',
                pz_contract_3: '7c7230bb0a41c01d2bb5fff77c6927f0420efe74ef75509265370daa4cbb5bd2#0',
                pz_contract_2: 'cd7516c20e44b31f956e290ac70a2807d0a94a432d49cd5a2f8e341f4c4aeff9#0',
                pz_contract_1: '4e0a972232acd55e57a4e8b74a2587da743fee54f3d3f5006551168d01ecde93#0',
                pz_contract: '2ffdbfdcebc7be19c9258749b3ceb063c627eb9363ff5f7992baa70e09124b65#0',
                pz_contract_v2: 'd10782b107ed1c21766d604b198df7ca17938b125a3b59e495126e0792c8797a#0'
            };

            for (const [handle, refScriptUtxo] of Object.entries(expectedRefs)) {
                const entry = Object.values(scripts.mainnet).find((script) => script.handle === handle);

                expect(entry).toBeDefined();
                expect(entry?.refScriptAddress).toEqual(migratedWalletAddress);
                expect(entry?.refScriptUtxo).toEqual(refScriptUtxo);
            }
        });

        it('Should point preview pz contract refs at the migrated multisig outputs', async () => {
            const migratedWalletAddress = 'addr_test1xp5gahy5jpx99p4vtnq2mfsmnjz84rfrqxyznqewp62mzy2tqcwlsq95pxz027092fzsjgpfzzaunne0qa9glmj38dfqafd0cf';
            const expectedRefs = {
                pz_contract_04: '93bcbc0281d43ded0ea10e0178f60a61b1bdc01729fcfb05039c8fd5715649f5#0',
                pz_contract_3: '4a0535b225f7d6d5589afc1260e491b937da58fa2718bedfc21ed2935314f42b#0',
                pz_contract_2: 'd055154b7d09ede9a1458c6cdfcd970bac83a9ea6642557eee2221ff27c558f7#0',
                pz_contract_1: '5ea0b5b3d2cb2306377ac00d4ac72df29a210cfddfbbc55983fb7753b399fd9f#0'
            };

            for (const [handle, refScriptUtxo] of Object.entries(expectedRefs)) {
                const entry = Object.values(scripts.preview).find((script) => script.handle === handle);

                expect(entry).toBeDefined();
                expect(entry?.refScriptAddress).toEqual(migratedWalletAddress);
                expect(entry?.refScriptUtxo).toEqual(refScriptUtxo);
            }
        });

        it('Should keep preprod legacy script refs aligned with the current live outputs', async () => {
            const expectedRefs = {
                'mint_proxy@handle_settings': {
                    refScriptAddress: 'addr_test1xrs2yysvp95rj065a8763cnha4s7xghlqkqhz0mzxddjknyyuxk7y483dmwpls9gv3zjk2rfevdhkku7w0f5v56g2yhs70r6j5',
                    refScriptUtxo: '5a86b49175043ec496e3b993a29bb5825ad205ca41ec22156ed6ac3109fbd927#1'
                },
                'mint_v1@handle_settings': {
                    refScriptAddress: 'addr_test1xrs2yysvp95rj065a8763cnha4s7xghlqkqhz0mzxddjknyyuxk7y483dmwpls9gv3zjk2rfevdhkku7w0f5v56g2yhs70r6j5',
                    refScriptUtxo: 'd4fc8a9d7510f40d4e931ee55a08d9863379ddeeb09a69038d993cfb7cbf6d37#3'
                },
                'mint_data@handle_settings': {
                    refScriptAddress: 'addr_test1xrs2yysvp95rj065a8763cnha4s7xghlqkqhz0mzxddjknyyuxk7y483dmwpls9gv3zjk2rfevdhkku7w0f5v56g2yhs70r6j5',
                    refScriptUtxo: '70078412adbe1a0d9faa7261bacaf3f8627bee92ee4b8e65d54b0f7e68ff3ae4#0'
                },
                'orders@handle_settings': {
                    refScriptAddress: 'addr_test1xrs2yysvp95rj065a8763cnha4s7xghlqkqhz0mzxddjknyyuxk7y483dmwpls9gv3zjk2rfevdhkku7w0f5v56g2yhs70r6j5',
                    refScriptUtxo: '70078412adbe1a0d9faa7261bacaf3f8627bee92ee4b8e65d54b0f7e68ff3ae4#2'
                },
                pz_contract_04: {
                    refScriptAddress: 'addr_test1xqvz92m0wjyd6tk2g7khfr2rsy4m2v8wu7ctv4jlr8mxl6ccy24k7aygm5hv53adwjx58qftk5cwaeasket97x0kdl4smpxnjx',
                    refScriptUtxo: '1d4dc99c6839ce913c4fa371bcc5961febc0e47476e65ece5073a85d08739717#0'
                }
            };

            for (const [handle, expected] of Object.entries(expectedRefs)) {
                const entry = Object.values(scripts.preprod).find((script) => script.handle === handle);

                expect(entry).toBeDefined();
                expect(entry?.refScriptAddress).toEqual(expected.refScriptAddress);
                expect(entry?.refScriptUtxo).toEqual(expected.refScriptUtxo);
            }
        });

        it('Should return scripts data', async () => {
            const scriptsController = new ScriptsController();
            const response = mockResponse();
            await scriptsController.index(
                mockRequest({}),
                response as any,
                () => {}
            );
            expect(response.status).toHaveBeenCalledTimes(0);
            expect(response.json).toHaveBeenCalledWith(scripts[process.env.NETWORK ?? 'preview']);
        });

        it('Should return latest pz_contract script with only latest param', async () => {
            const network = process.env.NETWORK ?? 'preview';
            const [key, latestScript] = Object.entries(scripts[network]).find(([_, value]) => value.latest && value.type === ScriptType.PZ_CONTRACT) as [string, ScriptDetails];
            delete latestScript.cbor;
            delete latestScript.refScriptAddress;
            delete latestScript.refScriptUtxo;
            const scriptsController = new ScriptsController();
            const response = mockResponse();
            await scriptsController.index(
                mockRequest({latest: true}),
                response as any,
                () => {}
            );

            expect(response.status).toHaveBeenCalledTimes(0);
            expect(response.json).toHaveBeenCalledWith({
                ...latestScript,
                scriptAddress: key
            });
        });

        it('Should return latest sub_handle_settings script', async () => {
            const network = process.env.NETWORK ?? 'preview';
            const [key, latestScript] = Object.entries(scripts[network]).find(([_, value]) => value.latest && value.type === ScriptType.SUB_HANDLE_SETTINGS) as [string, ScriptDetails];
            delete latestScript.cbor;
            delete latestScript.refScriptAddress;
            delete latestScript.refScriptUtxo;
            const scriptsController = new ScriptsController();
            const response = mockResponse();
            await scriptsController.index(
                mockRequest({latest: true, type: ScriptType.SUB_HANDLE_SETTINGS}),
                response as any,
                () => {}
            );

            expect(response.status).toHaveBeenCalledTimes(0);
            expect(response.json).toHaveBeenCalledWith({
                ...latestScript,
                scriptAddress: key
            });
        });

        it('Should return 404 when latest script is requested for unknown type', async () => {
            const scriptsController = new ScriptsController();
            const response = mockResponse();
            await scriptsController.index(
                mockRequest({latest: true, type: 'unknown'}),
                response as any,
                () => {}
            );

            expect(response.status).toHaveBeenCalledWith(404);
            expect(response.send).toHaveBeenCalledWith({ message: 'Latest script not found' });
        });

        it('Should fall back to preview network when NETWORK env is missing', async () => {
            delete process.env.NETWORK;
            const scriptsController = new ScriptsController();
            const response = mockResponse();

            await scriptsController.index(
                mockRequest({}),
                response as any,
                () => {}
            );

            expect(response.json).toHaveBeenCalledWith(scripts.preview);
        });

        it('Should synthesize HAL scripts from handle-backed registry and keep only the highest ordinal latest', async () => {
            const network = process.env.NETWORK ?? 'preview';
            const [legacyAddress, ordinalAddress] = Object.keys(scripts[network]);
            const handles = {
                'hal_mnt_prxy@handle_contract': {
                    name: 'hal_mnt_prxy@handle_contract',
                    hex: 'legacyhex',
                    utxo: 'a'.repeat(64) + '#0',
                    resolved_addresses: { ada: legacyAddress },
                    script: { cbor: 'legacycbor' }
                },
                'halmntprx2@handlecontract': {
                    name: 'halmntprx2@handlecontract',
                    hex: 'ordinalhex',
                    utxo: 'b'.repeat(64) + '#1',
                    resolved_addresses: { ada: ordinalAddress },
                    script: { cbor: 'ordinalcbor' }
                }
            };

            const scriptsController = new ScriptsController();
            const response = mockResponse();
            await scriptsController.index(
                mockRequest({ type: ScriptType.HAL_MINT_PROXY }, { get: () => mockRegistry(handles) }),
                response as any,
                () => {}
            );

            expect(response.status).toHaveBeenCalledTimes(0);
            expect(response.json).toHaveBeenCalledWith({
                [legacyAddress]: expect.objectContaining({
                    handle: 'hal_mnt_prxy@handle_contract',
                    handleHex: 'legacyhex',
                    refScriptAddress: legacyAddress,
                    refScriptUtxo: 'a'.repeat(64) + '#0',
                    cbor: 'legacycbor',
                    type: ScriptType.HAL_MINT_PROXY,
                    latest: false
                }),
                [ordinalAddress]: expect.objectContaining({
                    handle: 'halmntprx2@handlecontract',
                    handleHex: 'ordinalhex',
                    refScriptAddress: ordinalAddress,
                    refScriptUtxo: 'b'.repeat(64) + '#1',
                    cbor: 'ordinalcbor',
                    type: ScriptType.HAL_MINT_PROXY,
                    latest: true
                })
            });
        });

        it('Should return latest HAL script from handle-backed registry', async () => {
            const network = process.env.NETWORK ?? 'preview';
            const [legacyAddress, ordinalAddress] = Object.keys(scripts[network]);
            const handles = {
                'hal_mnt_prxy@handle_contract': {
                    name: 'hal_mnt_prxy@handle_contract',
                    hex: 'legacyhex',
                    utxo: 'a'.repeat(64) + '#0',
                    resolved_addresses: { ada: legacyAddress },
                    script: { cbor: 'legacycbor' }
                },
                'halmntprx2@handlecontract': {
                    name: 'halmntprx2@handlecontract',
                    hex: 'ordinalhex',
                    utxo: 'b'.repeat(64) + '#1',
                    resolved_addresses: { ada: ordinalAddress },
                    script: { cbor: 'ordinalcbor' }
                }
            };

            const scriptsController = new ScriptsController();
            const response = mockResponse();
            await scriptsController.index(
                mockRequest({ latest: true, type: ScriptType.HAL_MINT_PROXY }, { get: () => mockRegistry(handles) }),
                response as any,
                () => {}
            );

            expect(response.status).toHaveBeenCalledTimes(0);
            expect(response.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    scriptAddress: ordinalAddress,
                    handle: 'halmntprx2@handlecontract',
                    type: ScriptType.HAL_MINT_PROXY,
                    latest: true,
                    cbor: 'ordinalcbor'
                })
            );
        });

        it('Should instantiate the registry handlesStore class for handle-backed scripts', async () => {
            const network = process.env.NETWORK ?? 'preview';
            const [legacyAddress, ordinalAddress] = Object.keys(scripts[network]);
            const handles = {
                'hal_mnt_prxy@handle_contract': {
                    name: 'hal_mnt_prxy@handle_contract',
                    hex: 'legacyhex',
                    utxo: 'a'.repeat(64) + '#0',
                    resolved_addresses: { ada: legacyAddress },
                    script: { cbor: 'legacycbor' }
                },
                'halmntprx2@handlecontract': {
                    name: 'halmntprx2@handlecontract',
                    hex: 'ordinalhex',
                    utxo: 'b'.repeat(64) + '#1',
                    resolved_addresses: { ada: ordinalAddress },
                    script: { cbor: 'ordinalcbor' }
                }
            };

            const scriptsController = new ScriptsController();
            const response = mockResponse();

            await scriptsController.index(
                mockRequest({ latest: true, type: ScriptType.HAL_MINT_PROXY }, { get: () => mockRegistry(handles) }),
                response as any,
                () => {}
            );

            expect(response.status).toHaveBeenCalledTimes(0);
            expect(response.json).toHaveBeenCalledWith(
                expect.objectContaining({
                    scriptAddress: ordinalAddress,
                    handle: 'halmntprx2@handlecontract',
                    type: ScriptType.HAL_MINT_PROXY,
                    latest: true
                })
            );
        });
    });
});
