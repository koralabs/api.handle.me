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

const mockFetch = (cbors: Record<string, string>) => jest.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
    const url = `${input}`;
    const match = url.match(/\/([^/]+)\.unoptimized\.cbor$/);
    const slug = match?.[1];
    const cbor = slug ? cbors[slug] : undefined;

    return {
        ok: typeof cbor === 'string',
        text: async () => cbor ?? ''
    } as Response;
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
        jest.restoreAllMocks();
    });

    describe('[GET] /scripts', () => {
        it('returns handle-backed scripts keyed by derived validator-hash address', async () => {
            // Feature: `/scripts` should derive the response key from the validator hash while keeping the ref script UTxO address in `refScriptAddress`.
            // Failure mode: using the handle ADA address as the key would break the contract and conflate script and reference addresses.
            // Negative control: if the controller keyed by `resolved_addresses.ada`, the object keys asserted below would not match.
            mockFetch({ pers: 'unp1', subh: 'unp3' });
            const handles = {
                'pers1@handlecontract': buildHandle('pers1@handlecontract', 'addr_test1xqvz92m0wjyd6tk2g7khfr2rsy4m2v8wu7ctv4jlr8mxl6ccy24k7aygm5hv53adwjx58qftk5cwaeasket97x0kdl4smpxnjx', 'cbor1'),
                'pers2@handlecontract': buildHandle('pers2@handlecontract', 'addr_test1wr97aqagfyj68389dw3xwaefndftae9ua8mpv07vsjdg7jgh8mxmh', 'cbor2'),
                'subh3@handlecontract': buildHandle('subh3@handlecontract', 'addr_test1wqufkpfr0cfg9k430terz8gl0yqv8r8gep82tv9086yv3cck0h26m', 'cbor3')
            };

            const response = mockResponse();
            await new ScriptsController().index(
                mockRequest({}, { get: () => mockRegistry(handles) }),
                response as any,
                () => {}
            );

            expect(response.json).toHaveBeenCalledWith({
                [buildScriptAddress(handles['pers1@handlecontract'].resolved_addresses.ada)]: expect.objectContaining({
                    handle: 'pers1@handlecontract',
                    refScriptAddress: handles['pers1@handlecontract'].resolved_addresses.ada,
                    latest: false,
                    type: ScriptType.PZ_CONTRACT,
                    cbor: 'cbor1',
                    unoptimizedCbor: 'unp1'
                }),
                [buildScriptAddress(handles['pers2@handlecontract'].resolved_addresses.ada)]: expect.objectContaining({
                    handle: 'pers2@handlecontract',
                    refScriptAddress: handles['pers2@handlecontract'].resolved_addresses.ada,
                    latest: true,
                    type: ScriptType.PZ_CONTRACT,
                    cbor: 'cbor2',
                    unoptimizedCbor: 'unp1'
                }),
                [buildScriptAddress(handles['subh3@handlecontract'].resolved_addresses.ada)]: expect.objectContaining({
                    handle: 'subh3@handlecontract',
                    refScriptAddress: handles['subh3@handlecontract'].resolved_addresses.ada,
                    latest: true,
                    type: ScriptType.SUB_HANDLE_SETTINGS,
                    cbor: 'cbor3',
                    unoptimizedCbor: 'unp3'
                })
            });
        });

        it('returns latest pz_contract script when only latest is requested', async () => {
            // Feature: `/scripts?latest=true` should preserve the current default of returning the latest `pz_contract`.
            // Failure mode: removing the static file could change the implicit default type or pick the wrong ordinal.
            // Negative control: lowering the highest ordinal below `pers2` would change the expected handle and key.
            mockFetch({ pers: 'unp2' });
            const handles = {
                'pers1@handlecontract': buildHandle('pers1@handlecontract', 'addr_test1xqvz92m0wjyd6tk2g7khfr2rsy4m2v8wu7ctv4jlr8mxl6ccy24k7aygm5hv53adwjx58qftk5cwaeasket97x0kdl4smpxnjx', 'cbor1'),
                'pers2@handlecontract': buildHandle('pers2@handlecontract', 'addr_test1wr97aqagfyj68389dw3xwaefndftae9ua8mpv07vsjdg7jgh8mxmh', 'cbor2')
            };

            const response = mockResponse();
            await new ScriptsController().index(
                mockRequest({latest: true}, { get: () => mockRegistry(handles) }),
                response as any,
                () => {}
            );

            expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
                scriptAddress: buildScriptAddress(handles['pers2@handlecontract'].resolved_addresses.ada),
                handle: 'pers2@handlecontract',
                refScriptAddress: handles['pers2@handlecontract'].resolved_addresses.ada,
                latest: true,
                type: ScriptType.PZ_CONTRACT,
                cbor: 'cbor2',
                unoptimizedCbor: 'unp2'
            }));
        });

        it('returns latest script for the requested type', async () => {
            // Feature: `/scripts?latest=true&type=...` should return the highest ordinal only within that exact script type.
            // Failure mode: substring matching could leak a different type such as `demi_mint_proxy` when `demi_mint` is requested.
            // Negative control: if exact slug filtering were removed, this assertion could match the wrong handle.
            mockFetch({ demimnt: 'mint-unoptimized', demimntprx: 'proxy-unoptimized' });
            const handles = {
                'demimnt1@handlecontract': buildHandle('demimnt1@handlecontract', 'addr_test1wqufkpfr0cfg9k430terz8gl0yqv8r8gep82tv9086yv3cck0h26m', 'mint1'),
                'demimnt2@handlecontract': buildHandle('demimnt2@handlecontract', 'addr_test1wr97aqagfyj68389dw3xwaefndftae9ua8mpv07vsjdg7jgh8mxmh', 'mint2'),
                'demimntprx9@handlecontract': buildHandle('demimntprx9@handlecontract', 'addr_test1xqvz92m0wjyd6tk2g7khfr2rsy4m2v8wu7ctv4jlr8mxl6ccy24k7aygm5hv53adwjx58qftk5cwaeasket97x0kdl4smpxnjx', 'proxy9')
            };

            const response = mockResponse();
            await new ScriptsController().index(
                mockRequest({ latest: true, type: ScriptType.DEMI_MINT }, { get: () => mockRegistry(handles) }),
                response as any,
                () => {}
            );

            expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
                scriptAddress: buildScriptAddress(handles['demimnt2@handlecontract'].resolved_addresses.ada),
                handle: 'demimnt2@handlecontract',
                type: ScriptType.DEMI_MINT,
                latest: true,
                cbor: 'mint2',
                unoptimizedCbor: 'mint-unoptimized'
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
            mockFetch({ pers: 'unp-preview' });
            const handles = {
                'pers1@handlecontract': buildHandle('pers1@handlecontract', 'addr_test1xqvz92m0wjyd6tk2g7khfr2rsy4m2v8wu7ctv4jlr8mxl6ccy24k7aygm5hv53adwjx58qftk5cwaeasket97x0kdl4smpxnjx', 'cbor1')
            };

            const response = mockResponse();
            await new ScriptsController().index(
                mockRequest({latest: true}, { get: () => mockRegistry(handles) }),
                response as any,
                () => {}
            );

            expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
                scriptAddress: expect.stringMatching(/^addr_test1/),
                handle: 'pers1@handlecontract',
                unoptimizedCbor: 'unp-preview'
            }));
        });

        it('ignores handles without required ordinals or inline scripts', async () => {
            // Feature: only `<slug><ordinal>@handlecontract` handles with inline script CBOR should appear in the catalog.
            // Failure mode: malformed names or missing script payloads could produce unusable catalog entries.
            // Negative control: adding an ordinal to `pers@handlecontract` or a script to `pers2@handlecontract` would increase the result count.
            mockFetch({ pers: 'unp3' });
            const handles = {
                'pers@handlecontract': buildHandle('pers@handlecontract', 'addr_test1xqvz92m0wjyd6tk2g7khfr2rsy4m2v8wu7ctv4jlr8mxl6ccy24k7aygm5hv53adwjx58qftk5cwaeasket97x0kdl4smpxnjx', 'cbor1'),
                'pers2@handlecontract': {
                    ...buildHandle('pers2@handlecontract', 'addr_test1wr97aqagfyj68389dw3xwaefndftae9ua8mpv07vsjdg7jgh8mxmh', 'cbor2'),
                    script: undefined
                },
                'pers3@handlecontract': buildHandle('pers3@handlecontract', 'addr_test1wqufkpfr0cfg9k430terz8gl0yqv8r8gep82tv9086yv3cck0h26m', 'cbor3')
            };

            const response = mockResponse();
            await new ScriptsController().index(
                mockRequest({}, { get: () => mockRegistry(handles) }),
                response as any,
                () => {}
            );

            expect(response.json).toHaveBeenCalledWith({
                [buildScriptAddress(handles['pers3@handlecontract'].resolved_addresses.ada)]: expect.objectContaining({
                    handle: 'pers3@handlecontract',
                    unoptimizedCbor: 'unp3',
                    latest: true
                })
            });
        });

        it('omits unoptimized cbor when the repo artifact does not exist', async () => {
            // Feature: missing repo-hosted `*.unoptimized.cbor` artifacts should not break `/scripts`; the field should just be absent.
            // Failure mode: a 404 from GitHub could fail the whole catalog instead of preserving the rest of the script metadata.
            // Negative control: returning `ok: true` with text would make `unoptimizedCbor` appear and fail this check.
            jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, text: async () => '' } as Response);
            const handles = {
                'mkpl7@handlecontract': buildHandle('mkpl7@handlecontract', 'addr_test1wr97aqagfyj68389dw3xwaefndftae9ua8mpv07vsjdg7jgh8mxmh', 'mkpl-cbor')
            };

            const response = mockResponse();
            await new ScriptsController().index(
                mockRequest({}, { get: () => mockRegistry(handles) }),
                response as any,
                () => {}
            );

            expect(response.json).toHaveBeenCalledWith({
                [buildScriptAddress(handles['mkpl7@handlecontract'].resolved_addresses.ada)]: expect.not.objectContaining({
                    unoptimizedCbor: expect.anything()
                })
            });
        });
    });
});
