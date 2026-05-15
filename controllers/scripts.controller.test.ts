import { bech32AddressFromHashes, blake2b, IndexNames } from '@koralabs/kora-labs-common';
import ScriptsController from './scripts.controller';

const mockResponse = () => {
    const res = { json: jest.fn(), status: jest.fn(), send: jest.fn() };
    res.json = jest.fn().mockReturnValue(res);
    res.send = jest.fn().mockReturnValue(res);
    res.status = jest.fn().mockReturnValue(res);
    return res;
};

const mockRequest = (query: Record<string, unknown> = {}, app?: any) => ({ query, app } as any);

const buildScriptAddress = (scriptCbor: string) => {
    const validatorHash = blake2b(Buffer.from(`02${scriptCbor}`, 'hex'), 28);
    return bech32AddressFromHashes(
        validatorHash,
        'script',
        '',
        'key',
        'addr',
        (process.env.NETWORK?.toLowerCase() ?? 'preview') !== 'mainnet'
    );
};

const buildHandle = (name: string, refScriptAddress: string, cbor = '4e4d0100', scriptType = 'plutus_v2') => ({
    name,
    hex: Buffer.from(name).toString('hex'),
    utxo: `${Buffer.from(name).toString('hex').slice(0, 16)}#0`,
    resolved_addresses: { ada: refScriptAddress },
    script: { cbor, type: scriptType }
});

const buildScriptAddressV3 = (scriptCbor: string) => {
    const validatorHash = blake2b(Buffer.from(`03${scriptCbor}`, 'hex'), 28);
    return bech32AddressFromHashes(
        validatorHash,
        'script',
        '',
        'key',
        'addr',
        (process.env.NETWORK?.toLowerCase() ?? 'preview') !== 'mainnet'
    );
};

// Default fetch mock so unoptimizedCbor lookups don't hit the network. Tests
// that care about unoptimizedCbor content override this with a per-test impl.
const mockFetch = (cbors: Record<string, string> = {}) => jest.spyOn(global, 'fetch').mockImplementation(async (input: any) => {
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

const ADDR_A = 'addr_test1xqvz92m0wjyd6tk2g7khfr2rsy4m2v8wu7ctv4jlr8mxl6ccy24k7aygm5hv53adwjx58qftk5cwaeasket97x0kdl4smpxnjx';
const ADDR_B = 'addr_test1wr97aqagfyj68389dw3xwaefndftae9ua8mpv07vsjdg7jgh8mxmh';
const ADDR_C = 'addr_test1wqufkpfr0cfg9k430terz8gl0yqv8r8gep82tv9086yv3cck0h26m';

describe('Scripts Routes Test', () => {
    const originalNetwork = process.env.NETWORK;

    beforeEach(() => {
        process.env.NETWORK = 'preview';
        mockFetch();
    });

    afterAll(() => {
        process.env.NETWORK = originalNetwork;
    });

    afterEach(() => {
        jest.clearAllMocks();
        jest.restoreAllMocks();
    });

    describe('[GET] /scripts', () => {
        it('catalogues every @handlecontract subhandle keyed by derived script address', async () => {
            // Every `<slug><digits>@handlecontract` handle with inline CBOR ends up
            // in /scripts. Highest ordinal per family is `latest`.
            const handles = {
                'pers1@handlecontract': buildHandle('pers1@handlecontract', ADDR_A, '4e4d0001'),
                'pers2@handlecontract': buildHandle('pers2@handlecontract', ADDR_B, '4e4d0002'),
                'subh3@handlecontract': buildHandle('subh3@handlecontract', ADDR_C, '4e4d0003')
            };

            const response = mockResponse();
            await new ScriptsController().index(
                mockRequest({}, { get: () => mockRegistry(handles) }),
                response as any,
                () => {}
            );

            expect(response.json).toHaveBeenCalledWith({
                [buildScriptAddress(handles['pers1@handlecontract'].script.cbor)]: expect.objectContaining({
                    handle: 'pers1@handlecontract',
                    refScriptAddress: ADDR_A,
                    refScriptUtxo: handles['pers1@handlecontract'].utxo,
                    cbor: '4e4d0001',
                    latest: false,
                    type: 'pers'
                }),
                [buildScriptAddress(handles['pers2@handlecontract'].script.cbor)]: expect.objectContaining({
                    handle: 'pers2@handlecontract',
                    cbor: '4e4d0002',
                    latest: true,
                    type: 'pers'
                }),
                [buildScriptAddress(handles['subh3@handlecontract'].script.cbor)]: expect.objectContaining({
                    handle: 'subh3@handlecontract',
                    cbor: '4e4d0003',
                    latest: true,
                    type: 'subh'
                })
            });
        });

        it('treats split-deployment slugs as their own families', async () => {
            // V3 personalization split — `persprx`, `perspz`, `perslfc`, `persdsg`
            // all coexist alongside the legacy `pers` family. Each family gets its
            // own latest based on highest ordinal within that family.
            const handles = {
                'pers1@handlecontract': buildHandle('pers1@handlecontract', ADDR_A, '4e4d1001'),
                'persprx1@handlecontract': buildHandle('persprx1@handlecontract', ADDR_A, '4e4d2001'),
                'perspz1@handlecontract': buildHandle('perspz1@handlecontract', ADDR_B, '4e4d3001'),
                'perslfc1@handlecontract': buildHandle('perslfc1@handlecontract', ADDR_C, '4e4d4001'),
                'persdsg1@handlecontract': buildHandle('persdsg1@handlecontract', ADDR_C, '4e4d5001')
            };

            const response = mockResponse();
            await new ScriptsController().index(
                mockRequest({}, { get: () => mockRegistry(handles) }),
                response as any,
                () => {}
            );

            const json = (response.json as jest.Mock).mock.calls[0][0];
            const byHandle: Record<string, any> = {};
            for (const v of Object.values(json) as any[]) byHandle[v.handle] = v;

            expect(byHandle['pers1@handlecontract']).toMatchObject({ latest: true, type: 'pers' });
            expect(byHandle['persprx1@handlecontract']).toMatchObject({ latest: true, type: 'persprx' });
            expect(byHandle['perspz1@handlecontract']).toMatchObject({ latest: true, type: 'perspz' });
            expect(byHandle['perslfc1@handlecontract']).toMatchObject({ latest: true, type: 'perslfc' });
            expect(byHandle['persdsg1@handlecontract']).toMatchObject({ latest: true, type: 'persdsg' });
        });

        it('returns only entries marked latest when latest=true', async () => {
            const handles = {
                'pers1@handlecontract': buildHandle('pers1@handlecontract', ADDR_A, '4e4d0101'),
                'pers2@handlecontract': buildHandle('pers2@handlecontract', ADDR_B, '4e4d0102'),
                'subh2@handlecontract': buildHandle('subh2@handlecontract', ADDR_C, '4e4d0103'),
                'subh3@handlecontract': buildHandle('subh3@handlecontract', ADDR_C, '4e4d0104')
            };

            const response = mockResponse();
            await new ScriptsController().index(
                mockRequest({ latest: true }, { get: () => mockRegistry(handles) }),
                response as any,
                () => {}
            );

            expect(response.json).toHaveBeenCalledWith({
                [buildScriptAddress(handles['pers2@handlecontract'].script.cbor)]: expect.objectContaining({
                    handle: 'pers2@handlecontract',
                    latest: true,
                    type: 'pers'
                }),
                [buildScriptAddress(handles['subh3@handlecontract'].script.cbor)]: expect.objectContaining({
                    handle: 'subh3@handlecontract',
                    latest: true,
                    type: 'subh'
                })
            });
        });

        it('type filter is a startsWith match on the slug', async () => {
            // `type=pers` returns every family whose slug begins with `pers` —
            // legacy `pers`, plus the V3 split observers.
            const handles = {
                'pers1@handlecontract': buildHandle('pers1@handlecontract', ADDR_A, '4e4d2001'),
                'persprx1@handlecontract': buildHandle('persprx1@handlecontract', ADDR_A, '4e4d2002'),
                'perspz1@handlecontract': buildHandle('perspz1@handlecontract', ADDR_B, '4e4d2003'),
                'subh3@handlecontract': buildHandle('subh3@handlecontract', ADDR_C, '4e4d2004')
            };

            const response = mockResponse();
            await new ScriptsController().index(
                mockRequest({ type: 'pers' }, { get: () => mockRegistry(handles) }),
                response as any,
                () => {}
            );

            const json = (response.json as jest.Mock).mock.calls[0][0];
            const handlesReturned = (Object.values(json) as any[]).map((v) => v.handle).sort();
            expect(handlesReturned).toEqual([
                'pers1@handlecontract',
                'persprx1@handlecontract',
                'perspz1@handlecontract'
            ]);
        });

        it('narrower type filter scopes to a single family', async () => {
            // `type=persprx` returns only `persprx<n>` entries.
            const handles = {
                'pers1@handlecontract': buildHandle('pers1@handlecontract', ADDR_A, '4e4d3001'),
                'persprx1@handlecontract': buildHandle('persprx1@handlecontract', ADDR_A, '4e4d3002'),
                'perspz1@handlecontract': buildHandle('perspz1@handlecontract', ADDR_B, '4e4d3003')
            };

            const response = mockResponse();
            await new ScriptsController().index(
                mockRequest({ type: 'persprx' }, { get: () => mockRegistry(handles) }),
                response as any,
                () => {}
            );

            const json = (response.json as jest.Mock).mock.calls[0][0];
            expect(Object.values(json)).toHaveLength(1);
            expect((Object.values(json)[0] as any).handle).toEqual('persprx1@handlecontract');
        });

        it('combines latest=true with type filter', async () => {
            const handles = {
                'demimnt1@handlecontract': buildHandle('demimnt1@handlecontract', ADDR_C, '4e4d0111'),
                'demimnt2@handlecontract': buildHandle('demimnt2@handlecontract', ADDR_B, '4e4d0112'),
                'demimntprx9@handlecontract': buildHandle('demimntprx9@handlecontract', ADDR_A, '4e4d0113')
            };

            const response = mockResponse();
            await new ScriptsController().index(
                mockRequest({ latest: 'true', type: 'demimnt' }, { get: () => mockRegistry(handles) }),
                response as any,
                () => {}
            );

            // type=demimnt startsWith-matches both `demimnt` and `demimntprx`.
            // latest=true keeps only the highest-ordinal-with-script per family.
            const json = (response.json as jest.Mock).mock.calls[0][0];
            const handlesReturned = (Object.values(json) as any[]).map((v) => v.handle).sort();
            expect(handlesReturned).toEqual(['demimnt2@handlecontract', 'demimntprx9@handlecontract']);
            expect(Object.values(json).every((v: any) => v.latest === true)).toBe(true);
        });

        it('falls back to previous deployment when the highest-ordinal handle has no script yet', async () => {
            // Minting `pers2@handlecontract` before the new ref-script is published
            // shouldn't make `latest` disappear — it stays on `pers1` until pers2
            // gets its inline CBOR.
            const handles = {
                'pers1@handlecontract': buildHandle('pers1@handlecontract', ADDR_A, '4e4d0201'),
                'pers2@handlecontract': {
                    ...buildHandle('pers2@handlecontract', ADDR_B, '4e4d0202'),
                    script: undefined
                }
            };

            const response = mockResponse();
            await new ScriptsController().index(
                mockRequest({ latest: true, type: 'pers' }, { get: () => mockRegistry(handles) }),
                response as any,
                () => {}
            );

            const json = (response.json as jest.Mock).mock.calls[0][0];
            expect(Object.values(json)).toHaveLength(1);
            expect((Object.values(json)[0] as any).handle).toEqual('pers1@handlecontract');
        });

        it('uses the V3 language tag (0x03) when script.type marks the script as plutusV3', async () => {
            // The validator hash is blake2b-224(<lang-tag> || cbor). The scanner stores
            // `script.type` from on-chain ogmios `script.language` at scan time, so
            //  we trust it instead of hardcoding V2. Hardcoding 0x02 against V3 bytes
            //  produces a hash for an address that doesn't exist on chain.
            const handles = {
                'persprx1@handlecontract': buildHandle('persprx1@handlecontract', ADDR_A, '4e4d03aa', 'plutusV3')
            };

            const response = mockResponse();
            await new ScriptsController().index(
                mockRequest({ latest: true, type: 'persprx' }, { get: () => mockRegistry(handles) }),
                response as any,
                () => {}
            );

            const json = (response.json as jest.Mock).mock.calls[0][0];
            expect(json[buildScriptAddressV3('4e4d03aa')]).toMatchObject({
                handle: 'persprx1@handlecontract',
                latest: true,
                type: 'persprx'
            });
        });

        it('returns an empty object when no families match the type filter', async () => {
            const handles = {
                'pers1@handlecontract': buildHandle('pers1@handlecontract', ADDR_A, '4e4d0301')
            };

            const response = mockResponse();
            await new ScriptsController().index(
                mockRequest({ latest: true, type: 'unknownfamily' }, { get: () => mockRegistry(handles) }),
                response as any,
                () => {}
            );

            expect(response.json).toHaveBeenCalledWith({});
        });

        it('falls back to preview address encoding when NETWORK is missing', async () => {
            delete process.env.NETWORK;
            const handles = {
                'pers1@handlecontract': buildHandle('pers1@handlecontract', ADDR_A, '4e4d0131')
            };

            const response = mockResponse();
            await new ScriptsController().index(
                mockRequest({ latest: true }, { get: () => mockRegistry(handles) }),
                response as any,
                () => {}
            );

            expect(response.json).toHaveBeenCalledWith({
                [buildScriptAddress(handles['pers1@handlecontract'].script.cbor)]: expect.objectContaining({
                    handle: 'pers1@handlecontract',
                    latest: true
                })
            });
        });

        it('skips handles that have no inline script CBOR', async () => {
            const handles = {
                'pers1@handlecontract': buildHandle('pers1@handlecontract', ADDR_A, '4e4d0141'),
                'pers2@handlecontract': {
                    ...buildHandle('pers2@handlecontract', ADDR_B, '4e4d0142'),
                    script: undefined
                },
                'pers3@handlecontract': buildHandle('pers3@handlecontract', ADDR_C, '4e4d0143')
            };

            const response = mockResponse();
            await new ScriptsController().index(
                mockRequest({}, { get: () => mockRegistry(handles) }),
                response as any,
                () => {}
            );

            const json = (response.json as jest.Mock).mock.calls[0][0];
            const handlesReturned = (Object.values(json) as any[]).map((v) => v.handle).sort();
            expect(handlesReturned).toEqual(['pers1@handlecontract', 'pers3@handlecontract']);
            expect((Object.values(json) as any[]).find((v) => v.handle === 'pers3@handlecontract').latest).toBe(true);
        });
    });
});
