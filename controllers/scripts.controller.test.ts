import { bech32AddressFromHashes, decodeAddress, IndexNames, ScriptType } from '@koralabs/kora-labs-common';
import ScriptsController from './scripts.controller';

const mockResponse = () => {
    const res = {json: jest.fn(), status: jest.fn(), send: jest.fn()};
    res.json = jest.fn().mockReturnValue(res);
    res.send = jest.fn().mockReturnValue(res);
    res.status = jest.fn().mockReturnValue(res);
    return res;
}

const mockRequest = (query = {}, app?: any) =>
    ({ query, app } as any);

const buildScriptAddress = (refScriptAddress: string) => {
    const validatorHash = decodeAddress(refScriptAddress)?.slice(2, 58);
    if (!validatorHash) {
        throw new Error(`Unable to derive validator hash from ${refScriptAddress}`);
    }

    return bech32AddressFromHashes(
        validatorHash,
        'script',
        '',
        'key',
        'addr',
        (process.env.NETWORK?.toLowerCase() ?? 'preview') !== 'mainnet'
    );
};

const buildHandle = (name: string, refScriptAddress: string, cbor = 'a247') => ({
    name,
    hex: Buffer.from(name).toString('hex'),
    utxo: `${Buffer.from(name).toString('hex').slice(0, 16)}#0`,
    resolved_addresses: { ada: refScriptAddress },
    script: { cbor, type: 'plutus_v2' }
});

const mockRegistry = (handles: Record<string, any>) => ({
    handlesStore: class {
        private pipelineResults: any[] | null = null;

        getHashFromIndex(_index: string, key: string) {
            const result = handles[key];
            if (this.pipelineResults) {
                this.pipelineResults.push(result);
            }
            return result;
        }

        getKeysFromIndex() {
            return Object.keys(handles);
        }

        getValuesFromIndexedSet(index: string, key: string) {
            let result;
            if (index === IndexNames.SUBHANDLE && key === 'handlecontract') {
                result = new Set(Object.keys(handles).filter((handleName) => handleName.endsWith('@handlecontract')));
            }

            if (this.pipelineResults) {
                this.pipelineResults.push(result);
            }

            return result;
        }

        getMetrics() {
            return {
                currentSlot: 10,
                lastSlot: 10,
                currentBlockHash: 'a',
                tipBlockHash: 'a'
            };
        }

        pipeline(commands: () => void) {
            this.pipelineResults = [];
            commands();
            const results = [...this.pipelineResults];
            this.pipelineResults = null;
            return results;
        }
    }
});

afterAll(async () => {
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 500));
});

describe('Scripts Routes Test', () => {
    const originalNetwork = process.env.NETWORK;

    beforeEach(() => {
        process.env.NETWORK = 'preview';
    });

    afterAll(() => {
        process.env.NETWORK = originalNetwork;
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('[GET] /scripts', () => {
        it('returns handle-backed scripts keyed by derived validator-hash address', async () => {
            // Feature: `/scripts` should derive the response key from the validator hash while keeping the ref script UTxO address in `refScriptAddress`.
            // Failure mode: using the handle ADA address as the key would break the contract and conflate script and reference addresses.
            // Negative control: if the controller keyed by `resolved_addresses.ada`, the object keys asserted below would not match.
            const handles = {
                'pz_contract1@handlecontract': buildHandle('pz_contract1@handlecontract', 'addr_test1xqvz92m0wjyd6tk2g7khfr2rsy4m2v8wu7ctv4jlr8mxl6ccy24k7aygm5hv53adwjx58qftk5cwaeasket97x0kdl4smpxnjx', 'cbor1'),
                'pz_contract2@handlecontract': buildHandle('pz_contract2@handlecontract', 'addr_test1wr97aqagfyj68389dw3xwaefndftae9ua8mpv07vsjdg7jgh8mxmh', 'cbor2'),
                'sub_handle_settings3@handlecontract': buildHandle('sub_handle_settings3@handlecontract', 'addr_test1wqufkpfr0cfg9k430terz8gl0yqv8r8gep82tv9086yv3cck0h26m', 'cbor3')
            };

            const response = mockResponse();
            await new ScriptsController().index(
                mockRequest({}, { get: () => mockRegistry(handles) }),
                response as any,
                () => {}
            );

            expect(response.json).toHaveBeenCalledWith({
                [buildScriptAddress(handles['pz_contract1@handlecontract'].resolved_addresses.ada)]: expect.objectContaining({
                    handle: 'pz_contract1@handlecontract',
                    refScriptAddress: handles['pz_contract1@handlecontract'].resolved_addresses.ada,
                    latest: false,
                    type: ScriptType.PZ_CONTRACT,
                    cbor: 'cbor1'
                }),
                [buildScriptAddress(handles['pz_contract2@handlecontract'].resolved_addresses.ada)]: expect.objectContaining({
                    handle: 'pz_contract2@handlecontract',
                    refScriptAddress: handles['pz_contract2@handlecontract'].resolved_addresses.ada,
                    latest: true,
                    type: ScriptType.PZ_CONTRACT,
                    cbor: 'cbor2'
                }),
                [buildScriptAddress(handles['sub_handle_settings3@handlecontract'].resolved_addresses.ada)]: expect.objectContaining({
                    handle: 'sub_handle_settings3@handlecontract',
                    refScriptAddress: handles['sub_handle_settings3@handlecontract'].resolved_addresses.ada,
                    latest: true,
                    type: ScriptType.SUB_HANDLE_SETTINGS,
                    cbor: 'cbor3'
                })
            });
        });

        it('returns latest pz_contract script when only latest is requested', async () => {
            // Feature: `/scripts?latest=true` should preserve the current default of returning the latest `pz_contract`.
            // Failure mode: removing the static file could change the implicit default type or pick the wrong ordinal.
            // Negative control: lowering the highest ordinal below `pz_contract2` would change the expected handle and key.
            const handles = {
                'pz_contract1@handlecontract': buildHandle('pz_contract1@handlecontract', 'addr_test1xqvz92m0wjyd6tk2g7khfr2rsy4m2v8wu7ctv4jlr8mxl6ccy24k7aygm5hv53adwjx58qftk5cwaeasket97x0kdl4smpxnjx', 'cbor1'),
                'pz_contract2@handlecontract': buildHandle('pz_contract2@handlecontract', 'addr_test1wr97aqagfyj68389dw3xwaefndftae9ua8mpv07vsjdg7jgh8mxmh', 'cbor2')
            };

            const response = mockResponse();
            await new ScriptsController().index(
                mockRequest({latest: true}, { get: () => mockRegistry(handles) }),
                response as any,
                () => {}
            );

            expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
                scriptAddress: buildScriptAddress(handles['pz_contract2@handlecontract'].resolved_addresses.ada),
                handle: 'pz_contract2@handlecontract',
                refScriptAddress: handles['pz_contract2@handlecontract'].resolved_addresses.ada,
                latest: true,
                type: ScriptType.PZ_CONTRACT,
                cbor: 'cbor2'
            }));
        });

        it('returns latest script for the requested type', async () => {
            // Feature: `/scripts?latest=true&type=...` should return the highest ordinal only within that exact script type.
            // Failure mode: substring matching could leak a different type such as `demi_mint_proxy` when `demi_mint` is requested.
            // Negative control: if exact slug filtering were removed, this assertion could match the wrong handle.
            const handles = {
                'demi_mint1@handlecontract': buildHandle('demi_mint1@handlecontract', 'addr_test1wqufkpfr0cfg9k430terz8gl0yqv8r8gep82tv9086yv3cck0h26m', 'mint1'),
                'demi_mint2@handlecontract': buildHandle('demi_mint2@handlecontract', 'addr_test1wr97aqagfyj68389dw3xwaefndftae9ua8mpv07vsjdg7jgh8mxmh', 'mint2'),
                'demi_mint_proxy9@handlecontract': buildHandle('demi_mint_proxy9@handlecontract', 'addr_test1xqvz92m0wjyd6tk2g7khfr2rsy4m2v8wu7ctv4jlr8mxl6ccy24k7aygm5hv53adwjx58qftk5cwaeasket97x0kdl4smpxnjx', 'proxy9')
            };

            const response = mockResponse();
            await new ScriptsController().index(
                mockRequest({ latest: true, type: ScriptType.DEMI_MINT }, { get: () => mockRegistry(handles) }),
                response as any,
                () => {}
            );

            expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
                scriptAddress: buildScriptAddress(handles['demi_mint2@handlecontract'].resolved_addresses.ada),
                handle: 'demi_mint2@handlecontract',
                type: ScriptType.DEMI_MINT,
                latest: true,
                cbor: 'mint2'
            }));
        });

        it('returns 404 when latest script is requested for an unknown type', async () => {
            // Feature: invalid `type` values should still fail cleanly when `latest=true` requests a non-existent script.
            // Failure mode: an unknown type could accidentally fall back to a default script instead of surfacing the miss.
            // Negative control: changing the type to `pz_contract` would make this request succeed.
            const response = mockResponse();
            await new ScriptsController().index(
                mockRequest({latest: true, type: 'unknown'}, { get: () => mockRegistry({}) }),
                response as any,
                () => {}
            );

            expect(response.status).toHaveBeenCalledWith(404);
            expect(response.send).toHaveBeenCalledWith({ message: 'Latest script not found' });
        });

        it('falls back to preview address encoding when NETWORK is missing', async () => {
            // Feature: without `NETWORK`, derived script addresses should still default to preview encoding.
            // Failure mode: address derivation could flip to mainnet prefixes when env is absent.
            // Negative control: setting `NETWORK=mainnet` would change the expected bech32 prefix and fail this check.
            delete process.env.NETWORK;
            const handles = {
                'pz_contract1@handlecontract': buildHandle('pz_contract1@handlecontract', 'addr_test1xqvz92m0wjyd6tk2g7khfr2rsy4m2v8wu7ctv4jlr8mxl6ccy24k7aygm5hv53adwjx58qftk5cwaeasket97x0kdl4smpxnjx', 'cbor1')
            };

            const response = mockResponse();
            await new ScriptsController().index(
                mockRequest({latest: true}, { get: () => mockRegistry(handles) }),
                response as any,
                () => {}
            );

            expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
                scriptAddress: expect.stringMatching(/^addr_test1/),
                handle: 'pz_contract1@handlecontract'
            }));
        });

        it('ignores handles without required ordinals or inline scripts', async () => {
            // Feature: only `<slug><ordinal>@handlecontract` handles with inline script CBOR should appear in the catalog.
            // Failure mode: malformed names or missing script payloads could produce unusable catalog entries.
            // Negative control: adding an ordinal to `pz_contract@handlecontract` or a script to `pz_contract2@handlecontract` would increase the result count.
            const handles = {
                'pz_contract@handlecontract': buildHandle('pz_contract@handlecontract', 'addr_test1xqvz92m0wjyd6tk2g7khfr2rsy4m2v8wu7ctv4jlr8mxl6ccy24k7aygm5hv53adwjx58qftk5cwaeasket97x0kdl4smpxnjx', 'cbor1'),
                'pz_contract2@handlecontract': {
                    ...buildHandle('pz_contract2@handlecontract', 'addr_test1wr97aqagfyj68389dw3xwaefndftae9ua8mpv07vsjdg7jgh8mxmh', 'cbor2'),
                    script: undefined
                },
                'pz_contract3@handlecontract': buildHandle('pz_contract3@handlecontract', 'addr_test1wqufkpfr0cfg9k430terz8gl0yqv8r8gep82tv9086yv3cck0h26m', 'cbor3')
            };

            const response = mockResponse();
            await new ScriptsController().index(
                mockRequest({}, { get: () => mockRegistry(handles) }),
                response as any,
                () => {}
            );

            expect(response.json).toHaveBeenCalledWith({
                [buildScriptAddress(handles['pz_contract3@handlecontract'].resolved_addresses.ada)]: expect.objectContaining({
                    handle: 'pz_contract3@handlecontract',
                    latest: true
                })
            });
        });
    });
});
