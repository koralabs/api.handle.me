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
    handlesStore: () => ({
        getHashFromIndex: (_index: string, key: string) => handles[key],
        getKeysFromIndex: () => Object.keys(handles),
        getValuesFromIndexedSet: () => undefined,
        getMetrics: () => ({
            currentSlot: 10,
            lastSlot: 10,
            currentBlockHash: 'a',
            tipBlockHash: 'a'
        })
    })
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
                'hal-mint-proxy2@handlecontracts': {
                    name: 'hal-mint-proxy2@handlecontracts',
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
                    handle: 'hal-mint-proxy2@handlecontracts',
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
                'hal-mint-proxy2@handlecontracts': {
                    name: 'hal-mint-proxy2@handlecontracts',
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
                    handle: 'hal-mint-proxy2@handlecontracts',
                    type: ScriptType.HAL_MINT_PROXY,
                    latest: true,
                    cbor: 'ordinalcbor'
                })
            );
        });
    });
});
