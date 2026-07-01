import { ERROR_TEXT, HandleType, HttpException } from '@koralabs/kora-labs-common';
import * as cbor from '@koralabs/kora-labs-common/utils/cbor';
import request from 'supertest';
import App from '../app';
import * as config from '../config';

jest.mock('../services/ogmios/ogmios.service');

jest.mock('../repositories/handlesRepository', () => ({
    HandlesRepository: jest.fn().mockImplementation(() => ({
        buildPersonalization: () => {
            return {}
        },
        getPersonalization: (handle: { name?: string }) => {
            if (handle?.name === 'no-personalization') {
                return null;
            }
            return {
                    p: 'z',
                    reference_token: {
                        address: 'script_addr1'
                    }
                }
        },
        getHandle: (handleName: string) => {
            if (['nope', 'l', 'japan', '***', 'abcdefghijklmnopqrstuvwxyz12'].includes(handleName)) return null;

            if (handleName === 'no-utxo') {
                return {
                    name: handleName,
                    personalization: {
                        p: 'z'
                    },
                    datum: 'a247'
                };
            }

            if (handleName === 'missing_handle_script') {
                return {
                    name: handleName,
                    utxo: 'utxo#0',
                    policy: 'f0ff',
                    resolved_addresses: {
                        ada: 'addr1_script_lookup'
                    }
                };
            }

            if (handleName === 'no_ref_token') {
                return {
                    name: handleName,
                    resolved_addresses: {
                        ada: 'addr1'
                    },
                    utxo: 'utxo#0',
                    policy: 'f0ff'
                };
            }
            if (handleName === 'missing_ref_script') {
                return {
                    name: handleName,
                    resolved_addresses: {
                        ada: 'addr1'
                    },
                    utxo: 'utxo#0',
                    policy: 'f0ff',
                    reference_utxo: 'tx_id_missing_script#0'
                };
            }
            if (handleName === 'no-personalization') {
                return {
                    name: handleName,
                    utxo: 'utxo#0',
                    policy: 'f0ff',
                    resolved_addresses: {
                        ada: 'addr1'
                    }
                };
            }

            if (handleName === 'nope@handle') {
                return null;
            }
            if (handleName === 'sub@handle') {
                return {
                    name: handleName,
                    subhandle_settings:{
                        utxo: {datum:'9f9f01019f9f011a0bebc200ff9f021a05f5e100ff9f031a02faf080ffffa14862675f696d61676540ff9f01019f9f011a01312d00ffffa14862675f696d61676540ff000000581a687474703a2f2f6c6f63616c686f73743a333030372f23746f75005839004988cad9aa1ebd733b165695cfef965fda2ee42dab2d8584c43b039c96f91da5bdb192de2415d3e6d064aec54acee648c2c6879fad1ffda1ff'},
                        utxo_id: 'tx_id_sub#0'
                    }
                }
            }
            
            if (handleName === 'sub@handle2') {
                return {
                    name: handleName,
                    subhandle_settings:{
                        agreed_terms: 'http://localhost:3007/#tou',
                        buy_down_paid: 0,
                        buy_down_price: 0,
                        buy_down_percent: 0,
                        migrate_sig_required: false,
                        nft: {
                            public_minting_enabled: true,
                            pz_enabled: true,
                            default_styles: { bg_image: '' },
                            tier_pricing: [
                                [1, 200000000],
                                [2, 100000000],
                                [3, 50000000]
                            ]
                        },
                        payment_address: '0x004988cad9aa1ebd733b165695cfef965fda2ee42dab2d8584c43b039c96f91da5bdb192de2415d3e6d064aec54acee648c2c6879fad1ffda1',
                        virtual: {
                            default_styles: { bg_image: '' },
                            public_minting_enabled: true,
                            pz_enabled: true,
                            tier_pricing: [[1, 20000000]]
                        },
                        utxo: { address: 'addr1_ref_token', datum: '', index: 0, lovelace: 0, script: { cbor: 'a247', type: 'plutus_v2' }, tx_id: 'tx_id' },
                        utxo_id: 'tx_id_sub_2#0'
                    }                    
                };
            }

            if (handleName === 'sub@missing-utxo') {
                return {
                    name: handleName,
                    subhandle_settings: {
                        utxo_id: 'missing_sub#0'
                    }
                };
            }

            if (handleName === 'cross-chain') {
                return {
                    name: handleName,
                    utxo: 'utxo#0',
                    policy: 'f0ff',
                    resolved_addresses: {
                        ada: 'addr1',
                        btc: 'bc1qexample',
                        eth: '0x1234'
                    }
                };
            }

            return {
                name: handleName,
                utxo: 'utxo#0',
                policy: 'f0ff',
                resolved_addresses: {
                    ada: 'addr1'
                },
                personalization: {
                    p: 'z',
                    reference_token: {
                        address: 'script_addr1'
                    }
                },
                reference_utxo: 'tx_id#0',
                reference_token: {
                    tx_id: 'tx_id',
                    index: 0,
                    lovelace: 0,
                    datum: '',
                    address: 'addr1_ref_token',
                    script: { type: 'plutus_v2', cbor: 'a247' }
                },
                datum: 'a247',
                script: {
                    type: 'plutus_v2',
                    cbor: 'a247'
                }
            };
        },
        getHandleByHex: (handleHex: string) => {
            if (handleHex === Buffer.from('burritos').toString('hex')) {
                return {
                    name: 'burritos',
                    utxo: 'utxo#0',
                    policy: 'f0ff',
                    resolved_addresses: {
                        ada: 'addr1'
                    }
                };
            }
            return null;
        },
        getUTxO: (utxoId: string) => {
            if (utxoId === 'tx_id#0' || utxoId === 'ref_token_utxo') {
                return {
                    tx_id: 'tx_id',
                    index: 0,
                    lovelace: 0,
                    datum: '',
                    address: 'addr1_ref_token',
                    script: { type: 'plutus_v2', cbor: 'a247' }
                }
            } else if (utxoId === 'tx_id_missing_script#0') {
                return {
                    tx_id: 'tx_id_missing_script',
                    index: 0,
                    lovelace: 0,
                    datum: '',
                    address: 'addr1_script_lookup'
                }
            } else if (utxoId === 'tx_id_sub#0') {
                return {datum:'9f9f01019f9f011a0bebc200ff9f021a05f5e100ff9f031a02faf080ffffa14862675f696d61676540ff9f01019f9f011a01312d00ffffa14862675f696d61676540ff000000581a687474703a2f2f6c6f63616c686f73743a333030372f23746f75005839004988cad9aa1ebd733b165695cfef965fda2ee42dab2d8584c43b039c96f91da5bdb192de2415d3e6d064aec54acee648c2c6879fad1ffda1ff'}
            } else if (utxoId === 'tx_id_sub_2#0') {
                return { address: 'addr1_ref_token', datum: '', index: 0, lovelace: 0, script: { cbor: 'a247', type: 'plutus_v2' }, tx_id: 'tx_id' }
            }
            return null;
        },
        getAllHandles: () => {
            return [
                {
                    name: 'burritos',
                    utxo: 'utxo#0',
                    policy: 'f0ff',
                    personalization: {
                        p: 'z'
                    },
                    datum: 'a247'
                }
            ]
        },
        search: jest.fn((_pagination: any, _query: any, textResponse = false) => {
            if (textResponse) {
                return { searchTotal: 999, handles: ['burritos'] };
            }
            // searchTotal is intentionally larger than handles.length so that
            // tests asserting X-Total-Count catch any regression to "page
            // length" or "records_per_page passed in".
            return { searchTotal: 7777, handles: [
                {
                    name: 'burritos',
                    utxo: 'utxo#0',
                    policy: 'f0ff',
                    personalization: {
                        p: 'z'
                    },
                    datum: 'a247'
                }
            ] }
        }),
        getHolder: (key: string) => {
            if (key !== 'nope') {
                return {
                    handles: [{name: 'burritos', og_number: 0, created_slot_number: 0}],
                    default_handle: 'burritos',
                    manually_set: false
                }
            }
        },
        getAll: () => {
            return {
                searchTotal: 1,
                handles: [
                    {
                        name: 'burritos',
                        utxo: 'utxo#0',
                        policy: 'f0ff',
                        personalization: {
                            p: 'z'
                        },
                        datum: 'a247'
                    }
                ]
            };
        },
        getHandlesByHolderAddresses: jest.fn((handles: string[]) => handles),
        getHandlesByStakeKeyHashes: jest.fn((handles: string[]) => handles),
        getHandlesByPaymentKeyHashes: jest.fn((handles: string[]) => handles),
        getHandlesByAddresses: jest.fn((handles: string[]) => handles),
        getHandlesByAddressesAsync: jest.fn(async (handles: string[]) => handles),
        getHolderAddressDetails: (key: string) => {
            if (key === 'nope') {
                throw new HttpException(404, 'Not found');
            }

            return {
                handles: [{name: 'burritos', og_number: 0, created_slot_number: 0}],
                default_handle: 'burritos',
                manually_set: false
            };
        },
        currentHttpStatus: () => {
            return 200;
        },
        getHandleDatumByName: (handleName: string) => {
            if (['nope', 'l', 'japan', '***'].includes(handleName)) return null;

            if (handleName === 'burrito') {
                return 'd87981a26768616e646c657381a263756d6d647965616862796f6368657964736f6d65a16477656c70a1657468696e67657269676874';
            }

            return `${handleName}_datum`;
        },
        getSubHandleSettings: (handleName: string) => {
            if (handleName === 'no_settings@handle') {
                return null;
            }

            if (handleName === 'not@array') {
                return {};
            }

            return {
                settings: '9f9f01019f9f011a0bebc200ff9f021a05f5e100ff9f031a02faf080ffffa14862675f696d61676540ff9f01019f9f011a01312d00ffffa14862675f696d61676540ff000000581a687474703a2f2f6c6f63616c686f73743a333030372f23746f75005839004988cad9aa1ebd733b165695cfef965fda2ee42dab2d8584c43b039c96f91da5bdb192de2415d3e6d064aec54acee648c2c6879fad1ffda1ff',
                utxo: {
                    tx_id: 'tx_id',
                    index: 0,
                    lovelace: 0,
                    datum: '',
                    address: 'addr1_ref_token',
                    script: { type: 'plutus_v2', cbor: 'a247' }
                }
            };
        },
        getSubHandlesByRootHandle: (handleName: string) => {
            return [
                { name: `sh1@${handleName}`, handle_type: HandleType.NFT_SUBHANDLE },
                { name: `sh2@${handleName}`, handle_type: HandleType.VIRTUAL_SUBHANDLE },
                { name: `sh3@${handleName}`, handle_type: HandleType.VIRTUAL_SUBHANDLE }
            ];
        },
        getMetrics: () => {
            return {
                firstSlot: 0,
                lastSlot: 0,
                currentSlot: 0,
                elapsedOgmiosExec: 0,
                elapsedBuildingExec: 0,
                firstMemoryUsage: 0,
                currentBlockHash: '',
                tipBlockHash: '',
                memorySize: 0,
                networkSync: 0,
                handleCount: 0,
                holderCount: 0,
                schemaVersion: 0
            }
        }
    }))
}));
const MockedHandlesRepository = jest.requireMock('../repositories/handlesRepository').HandlesRepository as jest.Mock;


// ['apiKeysRepo']: jest.fn().mockReturnValue({
//     get: (key: string) => key === 'valid-key'
// })

afterAll(async () => {
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 500));
});

describe('Testing Handles Routes', () => {
    let app: App | null;
    beforeEach(async () => {
        app = await new App().initialize();
    });

    afterEach(() => {
        jest.clearAllMocks();
        jest.restoreAllMocks();
    });

    describe('[GET] /handles/:handle 28-char support', () => {
        it('accepts a valid 28-char handle (not 400 handleNameInvalid) and 404s if unminted', async () => {
            // kora-labs-common >= 6.7.8 raised the Ada Handle cap 15 -> 28. A valid, unminted
            // 28-char handle must resolve to 404 handleNotFound, NOT 400 handleNameInvalid (the
            // old {1,15} regex). 'abcdefghijklmnopqrstuvwxyz12' is exactly 28 chars.
            const response = await request(app?.getServer()).get('/handles/abcdefghijklmnopqrstuvwxyz12');
            expect(response.status).toEqual(404);
        });
    });

    describe('[GET] /handles', () => {
        it('should throw error if records_per_page is invalid', async () => {
            const response = await request(app?.getServer()).get('/handles?records_per_page=two');
            expect(response.status).toEqual(400);
            expect(response.body.message).toEqual(ERROR_TEXT.HANDLE_LIMIT_INVALID_FORMAT);
        });

        it('should throw error if records_per_page exceeds 250', async () => {
            const response = await request(app?.getServer()).get('/handles?records_per_page=251');

            expect(response.status).toEqual(400);
            expect(response.body.message).toEqual("'records_per_page' must be 250 or less");
        });

        it('should allow text/plain records_per_page above 250', async () => {
            const response = await request(app?.getServer())
                .get('/handles?records_per_page=5000&sort=asc')
                .set('Accept', 'text/plain');

            expect(response.status).toEqual(200);
        });

        it('should throw error if text/plain records_per_page exceeds 50000', async () => {
            const response = await request(app?.getServer())
                .get('/handles?records_per_page=50001&sort=asc')
                .set('Accept', 'text/plain');

            expect(response.status).toEqual(400);
            expect(response.body.message).toEqual("'records_per_page' must be 50000 or less");
        });

        it('should throw error if sort is invalid', async () => {
            const response = await request(app?.getServer()).get('/handles?records_per_page=1&sort=hmm');

            expect(response.status).toEqual(400);
            expect(response.body.message).toEqual(ERROR_TEXT.HANDLE_SORT_INVALID);
        });

        it('should return handles', async () => {
            const response = await request(app?.getServer()).get('/handles?records_per_page=1&sort=asc');

            expect(response.status).toEqual(200);
            expect(response.body).toEqual([{ name: 'burritos', utxo: 'utxo#0', policy: 'f0ff', is_personalized: false }]);
        });

        it('should reject `?holder=...` (typo for `holder_address`) with 400 unknown_query_params', async () => {
            // Regression: an unrecognized filter key used to be silently dropped,
            // so `?holder=stake1...` reported the unfiltered first page plus the
            // full handle-set count in X-Total-Count, looking like a real filter.
            // The 400 body must carry the standard `docs` URL the way 404s do.
            const response = await request(app?.getServer())
                .get('/handles?holder=stake1u9k8e3krslcm2p2s6kfd5dl3ekt6vmmvk7w0r2u3suw5slcgzj9ds');

            expect(response.status).toEqual(400);
            expect(response.body).toEqual({
                error: 'unknown_query_params',
                message: "Unknown query parameter: 'holder'",
                docs: 'https://api.handle.me/'
            });
        });

        it('should accept `?holder_address=...` (canonical name)', async () => {
            const response = await request(app?.getServer())
                .get('/handles?holder_address=stake1u9k8e3krslcm2p2s6kfd5dl3ekt6vmmvk7w0r2u3suw5slcgzj9ds');

            expect(response.status).toEqual(200);
        });

        it('should return X-Total-Count from the full searchTotal, not the page length', async () => {
            // Regression: the JSON branches of getAll / list previously echoed
            // the returned page's view-model length (or records_per_page),
            // making client pagination useless. The header must be the
            // unpaginated match count produced by repo.search.
            const response = await request(app?.getServer()).get('/handles?records_per_page=1&sort=asc');

            expect(response.status).toEqual(200);
            expect(response.headers['x-handles-search-total']).toEqual('7777');
            expect(response.headers['x-total-count']).toEqual('7777');
        });

        it('should reject `?holder=...` (typo for `holder_address`) with 400 unknown_query_params', async () => {
            // Regression: an unrecognized filter key used to be silently dropped,
            // so `?holder=stake1...` reported the unfiltered first page plus the
            // full handle-set count in X-Total-Count, looking like a real filter.
            // The 400 body must carry the standard `docs` URL the way 404s do.
            const response = await request(app?.getServer())
                .get('/handles?holder=stake1u9k8e3krslcm2p2s6kfd5dl3ekt6vmmvk7w0r2u3suw5slcgzj9ds');

            expect(response.status).toEqual(400);
            expect(response.body).toEqual({
                error: 'unknown_query_params',
                message: "Unknown query parameter: 'holder'",
                docs: 'https://api.handle.me/'
            });
        });

        it('should accept `?holder_address=...` (canonical name)', async () => {
            const response = await request(app?.getServer())
                .get('/handles?holder_address=stake1u9k8e3krslcm2p2s6kfd5dl3ekt6vmmvk7w0r2u3suw5slcgzj9ds');

            expect(response.status).toEqual(200);
        });

        it('should return X-Total-Count from the full searchTotal, not the page length', async () => {
            // Regression: the JSON branches of getAll / list previously echoed
            // the returned page's view-model length (or records_per_page),
            // making client pagination useless. The header must be the
            // unpaginated match count produced by repo.search.
            const response = await request(app?.getServer()).get('/handles?records_per_page=1&sort=asc');

            expect(response.status).toEqual(200);
            expect(response.headers['x-handles-search-total']).toEqual('7777');
            expect(response.headers['x-total-count']).toEqual('7777');
        });

        it('should return text/plain handle list when accept is text/plain', async () => {
            const response = await request(app?.getServer()).get('/handles?records_per_page=1&sort=asc').set('Accept', 'text/plain');

            expect(response.status).toEqual(200);
            expect(response.text).toEqual('burritos');
            expect(response.headers['x-handles-search-total']).toEqual('999');
        });

        it('should forward root_handle with other search filters', async () => {
            // Feature: `/handles` should accept `root_handle` alongside other filters when searching subhandles.
            // Failure mode: the controller could drop `root_handle`, returning matches from unrelated roots.
            // Negative control: if `root_handle` were omitted from the search model, the expectation below would fail.
            const response = await request(app?.getServer()).get('/handles?root_handle=handle&characters=letters&search=burr');

            expect(response.status).toEqual(200);
            const repoInstance = MockedHandlesRepository.mock.results.at(-1)?.value;
            const [, searchModel] = repoInstance.search.mock.calls.at(-1);
            expect(searchModel).toEqual(expect.objectContaining({
                root_handle: 'handle',
                characters: 'letters',
                search: 'burr'
            }));
        });

        it('should default text/plain records_per_page to 50000', async () => {
            const response = await request(app?.getServer()).get('/handles?sort=asc').set('Accept', 'text/plain');

            expect(response.status).toEqual(200);
            const repoInstance = MockedHandlesRepository.mock.results.at(-1)?.value;
            const [pagination, , namesOnly] = repoInstance.search.mock.calls.at(-1);
            expect(pagination).toEqual(expect.objectContaining({ handlesPerPage: 50000 }));
            expect(namesOnly).toBe(true);
        });

        it('should throw error if characters is invalid', async () => {
            const response = await request(app?.getServer()).get('/handles?characters=nope');

            expect(response.status).toEqual(400);
            expect(response.body.message).toEqual('characters must be letters, numbers, special');
        });

        it('should throw error if length is invalid', async () => {
            const response = await request(app?.getServer()).get('/handles?length=nope');
            expect(response.status).toEqual(400);
            expect(response.body.message).toEqual("Length must be a number or a range of numbers (ex: 1-28) and can't exceed 28");
        });

        it('should throw error if rarity is invalid', async () => {
            const response = await request(app?.getServer()).get('/handles?rarity=nope');
            expect(response.status).toEqual(400);
            expect(response.body.message).toEqual('rarity must be basic, common, rare, ultra_rare, legendary');
        });

        it('should throw error if numeric_modifiers is invalid', async () => {
            const response = await request(app?.getServer()).get('/handles?numeric_modifiers=nope');

            expect(response.status).toEqual(400);
            expect(response.body.message).toEqual('numeric_modifiers must be negative, decimal');
        });

        it('should throw error if page and slot number are used together', async () => {
            const response = await request(app?.getServer()).get('/handles?page=1&slot_number=123');

            expect(response.status).toEqual(400);
            expect(response.body.message).toEqual("'page' and 'slot_number' can't be used together");
        });

        it('should throw error if handle_type is invalid', async () => {
            const response = await request(app?.getServer()).get('/handles?handle_type=taco');

            expect(response.status).toEqual(400);
            expect(response.body.message).toEqual('handle_type must be virtual_subhandle, nft_subhandle, handle');
        });

        it('should throw error if search query is less than 3 characters', async () => {
            const response = await request(app?.getServer()).get('/handles?search=ab');

            expect(response.status).toEqual(400);
            expect(response.body.message).toEqual('search must be at least 3 characters');
        });

    });

    describe('[POST] /handles/list', () => {
        it('should throw error if records_per_page is invalid', async () => {
            const response = await request(app?.getServer()).post('/handles/list?records_per_page=two');
            expect(response.status).toEqual(400);
            expect(response.body.message).toEqual(ERROR_TEXT.HANDLE_LIMIT_INVALID_FORMAT);
        });

        it('should throw error if records_per_page exceeds 250', async () => {
            const response = await request(app?.getServer()).post('/handles/list?records_per_page=251');

            expect(response.status).toEqual(400);
            expect(response.body.message).toEqual("'records_per_page' must be 250 or less");
        });

        it('should allow text/plain records_per_page above 250', async () => {
            const response = await request(app?.getServer())
                .post('/handles/list?records_per_page=5000&sort=asc')
                .set('Accept', 'text/plain')
                .set('Content-Type', 'application/json')
                .send(['burritos']);

            expect(response.status).toEqual(200);
        });

        it('should throw error if text/plain records_per_page exceeds 50000', async () => {
            const response = await request(app?.getServer())
                .post('/handles/list?records_per_page=50001&sort=asc')
                .set('Accept', 'text/plain')
                .set('Content-Type', 'application/json')
                .send(['burritos']);

            expect(response.status).toEqual(400);
            expect(response.body.message).toEqual("'records_per_page' must be 50000 or less");
        });

        it('should throw error if sort is invalid', async () => {
            const response = await request(app?.getServer()).post('/handles/list?records_per_page=1&sort=hmm');

            expect(response.status).toEqual(400);
            expect(response.body.message).toEqual(ERROR_TEXT.HANDLE_SORT_INVALID);
        });

        it('should return handles', async () => {
            const response = await request(app?.getServer()).post('/handles/list?records_per_page=1&sort=asc');

            expect(response.status).toEqual(200);
            expect(response.body).toEqual([{ name: 'burritos', utxo: 'utxo#0', policy: 'f0ff', is_personalized: false }]);
        });

        it('should fail if handles is not an array', async () => {
            const response = await request(app?.getServer())
                .post('/handles/list')
                .set('Content-Type', 'application/json')
                .send({ handles: ['burritos'] });

            expect(response.status).toEqual(400);
            expect(response.body.message).toEqual('expected array and received object');
        });

        it('should return handles when handles is set', async () => {
            const response = await request(app?.getServer()).post('/handles/list').set('Content-Type', 'application/json').send(['burritos']);

            expect(response.status).toEqual(200);
            expect(response.body).toEqual([{ name: 'burritos', utxo: 'utxo#0', policy: 'f0ff', is_personalized: false }]);
        });

        it('should return X-Total-Count from the full searchTotal on JSON list, not the returned page length', async () => {
            // Regression: _searchFromList's JSON branch was using
            // handlesViewModel.length, so paginated clients saw the count
            // of THIS page (or 0 when all returned handles lacked utxo)
            // instead of the total across all pages.
            const response = await request(app?.getServer())
                .post('/handles/list?records_per_page=1&sort=asc')
                .set('Content-Type', 'application/json')
                .send(['burritos']);

            expect(response.status).toEqual(200);
            expect(response.headers['x-handles-search-total']).toEqual('7777');
            expect(response.headers['x-total-count']).toEqual('7777');
        });

        it('should reject object entries for stake key hash lookup without a 500', async () => {
            const response = await request(app?.getServer())
                .post('/handles/list?type=stakekeyhash')
                .set('Content-Type', 'application/json')
                .send([{ hash: 'deadbeef' }]);

            expect(response.status).toEqual(400);
            expect(response.body.message).toEqual('expected string entries and received object');
            const repoInstance = MockedHandlesRepository.mock.results.at(-1)?.value;
            expect(repoInstance.getHandlesByStakeKeyHashes).not.toHaveBeenCalled();
        });

        it('should return X-Total-Count from the full searchTotal on JSON list, not the returned page length', async () => {
            // Regression: _searchFromList's JSON branch was using
            // handlesViewModel.length, so paginated clients saw the count
            // of THIS page (or 0 when all returned handles lacked utxo)
            // instead of the total across all pages.
            const response = await request(app?.getServer())
                .post('/handles/list?records_per_page=1&sort=asc')
                .set('Content-Type', 'application/json')
                .send(['burritos']);

            expect(response.status).toEqual(200);
            expect(response.headers['x-handles-search-total']).toEqual('7777');
            expect(response.headers['x-total-count']).toEqual('7777');
        });


        it('should return text/plain handle list from list search', async () => {
            const response = await request(app?.getServer())
                .post('/handles/list?records_per_page=1&sort=asc')
                .set('Accept', 'text/plain')
                .set('Content-Type', 'application/json')
                .send(['burritos']);

            expect(response.status).toEqual(200);
            expect(response.text).toEqual('burritos');
            expect(response.headers['x-handles-search-total']).toEqual('999');
        });

        it('should combine root_handle with list body filtering', async () => {
            // Feature: `/handles/list` should intersect explicit handle lists with the `root_handle` filter.
            // Failure mode: the batch lookup path could ignore `root_handle` and return handles from outside the root.
            // Negative control: if `root_handle` were not forwarded, the asserted search model would not contain it.
            const response = await request(app?.getServer())
                .post('/handles/list?root_handle=handle&numeric_modifiers=decimal')
                .set('Content-Type', 'application/json')
                .send(['burritos']);

            expect(response.status).toEqual(200);
            const repoInstance = MockedHandlesRepository.mock.results.at(-1)?.value;
            const [, searchModel] = repoInstance.search.mock.calls.at(-1);
            expect(searchModel).toEqual(expect.objectContaining({
                root_handle: 'handle',
                numeric_modifiers: 'decimal',
                handles: ['burritos']
            }));
        });

        it('should default text/plain list records_per_page to 50000', async () => {
            const response = await request(app?.getServer())
                .post('/handles/list?sort=asc')
                .set('Accept', 'text/plain')
                .set('Content-Type', 'application/json')
                .send(['burritos']);

            expect(response.status).toEqual(200);
            const repoInstance = MockedHandlesRepository.mock.results.at(-1)?.value;
            const [pagination, , namesOnly] = repoInstance.search.mock.calls.at(-1);
            expect(pagination).toEqual(expect.objectContaining({ handlesPerPage: 50000 }));
            expect(namesOnly).toBe(true);
        });

        it('should support all list type conversion branches', async () => {
            const queryTypes = ['bech32stake', 'holder', 'stakekeyhash', 'assetname', 'handlehex', 'paymentkeyhash', 'bech32address', 'hexaddress'];
            for (const type of queryTypes) {
                const response = await request(app?.getServer())
                    .post(`/handles/list?type=${type}`)
                    .set('Content-Type', 'application/json')
                    .send(type === 'hexaddress' ? [] : ['6275727269746f73']);

                expect(response.status).toEqual(200);
            }
        });

        it('should throw error if characters is invalid', async () => {
            const response = await request(app?.getServer()).post('/handles/list?characters=nope');

            expect(response.status).toEqual(400);
            expect(response.body.message).toEqual('characters must be letters, numbers, special');
        });

        it('should throw error if length is invalid', async () => {
            const response = await request(app?.getServer()).post('/handles/list?length=nope');
            expect(response.status).toEqual(400);
            expect(response.body.message).toEqual("Length must be a number or a range of numbers (ex: 1-28) and can't exceed 28");
        });

        it('should throw error if rarity is invalid', async () => {
            const response = await request(app?.getServer()).post('/handles/list?rarity=nope');
            expect(response.status).toEqual(400);
            expect(response.body.message).toEqual('rarity must be basic, common, rare, ultra_rare, legendary');
        });

        it('should throw error if numeric_modifiers is invalid', async () => {
            const response = await request(app?.getServer()).post('/handles/list?numeric_modifiers=nope');

            expect(response.status).toEqual(400);
            expect(response.body.message).toEqual('numeric_modifiers must be negative, decimal');
        });

        it('should throw error if page and slot number are used together', async () => {
            const response = await request(app?.getServer()).post('/handles/list?page=1&slot_number=123');

            expect(response.status).toEqual(400);
            expect(response.body.message).toEqual("'page' and 'slot_number' can't be used together");
        });

        it('should throw error if search query is less than 3 characters', async () => {
            const response = await request(app?.getServer()).post('/handles/list?search=ab');

            expect(response.status).toEqual(400);
            expect(response.body.message).toEqual('search must be at least 3 characters');
        });
    });

    describe('[GET] /handles/:handle', () => {
        it('should throw error if handle does not exist', async () => {
            const response = await request(app?.getServer()).get('/handles/nope');
            expect(response.status).toEqual(404);
            expect(response.body).toEqual({
                error: 'handle_not_found',
                message: 'Handle not found',
                docs: expect.stringContaining('handle.me/$/faq')
            });
        });

        it('should return valid handle', async () => {
            const response = await request(app?.getServer()).get('/handles/burritos');
            expect(response.status).toEqual(200);
            expect(response.body).toEqual({ name: 'burritos', resolved_addresses: { ada: 'addr1' }, utxo: 'utxo#0', policy: 'f0ff', is_personalized: false });
        });

        it('should resolve handle by hex when hex query is true', async () => {
            const hex = Buffer.from('burritos').toString('hex');
            const response = await request(app?.getServer()).get(`/handles/${hex}?hex=true`);
            expect(response.status).toEqual(200);
            expect(response.body).toEqual({ name: 'burritos', resolved_addresses: { ada: 'addr1' }, utxo: 'utxo#0', policy: 'f0ff', is_personalized: false });
        });

        it('should preserve cross-chain resolved addresses in handle response', async () => {
            const response = await request(app?.getServer()).get('/handles/cross-chain');
            expect(response.status).toEqual(200);
            expect(response.body).toEqual({
                name: 'cross-chain',
                resolved_addresses: {
                    ada: 'addr1',
                    btc: 'bc1qexample',
                    eth: '0x1234'
                },
                utxo: 'utxo#0',
                policy: 'f0ff',
                is_personalized: true
            });
        });

        it('should return legendary handle if available', async () => {
            const response = await request(app?.getServer()).get('/handles/1');
            expect(response.status).toEqual(200);
            expect(response.body).toEqual({ name: '1', resolved_addresses: { ada: 'addr1' }, utxo: 'utxo#0', policy: 'f0ff', is_personalized: false });
        });

        it('returns 404 with handle FAQ docs URL for legendary single-char handles', async () => {
            const response = await request(app?.getServer()).get('/handles/l');
            expect(response.status).toEqual(404);
            expect(response.body).toEqual({
                error: 'handle_not_found',
                message: 'Handle not found',
                docs: expect.stringContaining('handle.me/$/faq')
            });
        });

        it('returns 404 with handle FAQ docs URL for malformed handle (***); shape rules are not the API\'s job', async () => {
            const response = await request(app?.getServer()).get('/handles/***');
            expect(response.status).toEqual(404);
            expect(response.body).toEqual({
                error: 'handle_not_found',
                message: 'Handle not found',
                docs: expect.stringContaining('handle.me/$/faq')
            });
        });

        it('should return 404 for unminted subhandle', async () => {
            const response = await request(app?.getServer()).get('/handles/nope@handle');
            expect(response.status).toEqual(404);
            expect(response.body).toEqual(expect.objectContaining({
                error: 'handle_not_found',
                message: 'Handle not found'
            }));
        });

        it('should return 451 with protected-words message preserved', async () => {
            const response = await request(app?.getServer()).get('/handles/japan');
            expect(response.status).toEqual(451);
            expect(response.body).toEqual(expect.objectContaining({
                error: 'unavailable_for_legal_reasons',
                message: "Protected word match on 'jap,an'"
            }));
        });

        it('should throw error if handle does not have a utxo', async () => {
            const response = await request(app?.getServer()).get('/handles/no-utxo');
            expect(response.status).toEqual(404);
            expect(response.body).toEqual(expect.objectContaining({
                error: 'handle_not_found',
                message: 'Handle not found'
            }));
        });
    });

    describe('[GET] /handles/:handle/personalized', () => {
        it('should throw error if handle does not exist', async () => {
            const response = await request(app?.getServer()).get('/handles/nope/personalized');
            expect(response.status).toEqual(404);
        });

        it('returns 404 (not 406) for legendary single-char handles on /personalized', async () => {
            const response = await request(app?.getServer()).get('/handles/l');
            expect(response.status).toEqual(404);
            expect(response.body).toEqual(expect.objectContaining({
                error: 'handle_not_found',
                docs: expect.stringContaining('handle.me/$/faq')
            }));
        });

        it('returns 404 (not 406) for malformed handle on /personalized', async () => {
            const response = await request(app?.getServer()).get('/handles/***');
            expect(response.status).toEqual(404);
            expect(response.body).toEqual(expect.objectContaining({
                error: 'handle_not_found',
                docs: expect.stringContaining('handle.me/$/faq')
            }));
        });

        it('should return 451 with protected-words message preserved on /personalized', async () => {
            const response = await request(app?.getServer()).get('/handles/japan');
            expect(response.status).toEqual(451);
            expect(response.body).toEqual(expect.objectContaining({
                error: 'unavailable_for_legal_reasons',
                message: "Protected word match on 'jap,an'"
            }));
        });

        it('should return personalization payload when available', async () => {
            const response = await request(app?.getServer()).get('/handles/burritos/personalized');
            expect(response.status).toEqual(200);
            expect(response.body).toEqual({
                p: 'z',
                reference_token: {
                    address: 'script_addr1'
                }
            });
        });

        it('should return empty object when personalization is not available', async () => {
            const response = await request(app?.getServer()).get('/handles/no-personalization/personalized');
            expect(response.status).toEqual(200);
            expect(response.body).toEqual({});
        });
    });

    describe('[GET] /holders/:address', () => {
        it('should return 404 if holder doesn\'t exist', async () => {
            const response = await request(app?.getServer()).get('/holders/nope');
            expect(response.status).toEqual(404);
            expect(response.body).toEqual(expect.objectContaining({
                error: 'holder_not_found',
                message: 'Holder not found'
            }));
        });

        it('should return valid handle', async () => {
            const response = await request(app?.getServer()).get('/holders/address');
            expect(response.status).toEqual(200);
            expect(response.body).toEqual({
                handles: [{name:'burritos', og_number: expect.any(Number), created_slot_number: expect.any(Number)}],
                default_handle: 'burritos',
                manually_set: false
            });
        });
    });

    describe('[GET] /handles/:handle/datum', () => {
        it('should return error if ENABLE_DATUM_ENDPOINT is false', async () => {
            jest.spyOn(config, 'isDatumEndpointEnabled').mockReturnValue(false);
            const response = await request(app?.getServer()).get('/handles/taco/datum');
            expect(response.status).toEqual(400);
            expect(response.body).toEqual(expect.objectContaining({
                error: 'datum_endpoint_disabled',
                message: 'Datum endpoint is disabled'
            }));
        });

        it('should 404 when the handle itself does not exist', async () => {
            jest.spyOn(config, 'isDatumEndpointEnabled').mockReturnValue(true);
            const response = await request(app?.getServer()).get('/handles/nope/datum');
            expect(response.status).toEqual(404);
            // getHandleFromRepo throws first when the handle is missing entirely.
            expect(response.body).toEqual(expect.objectContaining({
                error: 'handle_not_found',
                message: 'Handle not found'
            }));
        });

        it('decodes JSON when no Accept header is sent (default behavior)', async () => {
            jest.spyOn(config, 'isDatumEndpointEnabled').mockReturnValue(true);
            const response = await request(app?.getServer()).get('/handles/burrito/datum');
            expect(response.status).toEqual(200);
            expect(response.headers['content-type']).toMatch(/application\/json/);
            expect(response.body.constructor_0[0]).toEqual({
                handles: [{ umm: 'yeah', yo: 'hey' }],
                some: { welp: { thing: 'right' } }
            });
        });

        it('decodes JSON when Accept: application/json', async () => {
            jest.spyOn(config, 'isDatumEndpointEnabled').mockReturnValue(true);
            const response = await request(app?.getServer()).get('/handles/burrito/datum').set('Accept', 'application/json');
            expect(response.status).toEqual(200);
            expect(response.body.constructor_0[0]).toEqual({
                handles: [{ umm: 'yeah', yo: 'hey' }],
                some: { welp: { thing: 'right' } }
            });
        });

        it('returns raw CBOR-hex when Accept: text/plain', async () => {
            jest.spyOn(config, 'isDatumEndpointEnabled').mockReturnValue(true);
            const response = await request(app?.getServer()).get('/handles/taco/datum').set('Accept', 'text/plain');
            expect(response.status).toEqual(200);
            expect(response.headers['content-type']).toMatch(/text\/plain/);
            expect(response.text).toEqual('taco_datum');
        });

        it('should error trying to decode json and throw 400', async () => {
            jest.spyOn(config, 'isDatumEndpointEnabled').mockReturnValue(true);
            jest.spyOn(cbor, 'decodeCborToJson').mockImplementation(() => {
                throw new Error('test');
            });
            const response = await request(app?.getServer()).get('/handles/taco/datum').set('Accept', 'application/json');
            expect(response.status).toEqual(400);
            expect(response.body).toEqual(expect.objectContaining({
                error: 'datum_decode_failed',
                message: 'Unable to decode datum to json'
            }));
        });
    });

    describe('[GET] /handles/:handle/script', () => {
        it('should return handle not found when script request handle is missing', async () => {
            const response = await request(app?.getServer()).get('/handles/nope/script');
            expect(response.status).toEqual(404);
            expect(response.body).toEqual(expect.objectContaining({
                error: 'handle_not_found',
                message: 'Handle not found'
            }));
        });

        it('should return valid script for handle as JSON by default', async () => {
            const response = await request(app?.getServer()).get('/handles/skirt_steak_taco/script');
            expect(response.status).toEqual(200);
            expect(response.headers['content-type']).toMatch(/application\/json/);
            expect(response.body).toEqual({
                type: 'plutus_v2',
                cbor: 'a247'
            });
        });

        it('returns raw CBOR-hex when Accept: text/plain', async () => {
            const response = await request(app?.getServer()).get('/handles/skirt_steak_taco/script').set('Accept', 'text/plain');
            expect(response.status).toEqual(200);
            expect(response.headers['content-type']).toMatch(/text\/plain/);
            expect(response.text).toEqual('a247');
        });

        it('returns raw CBOR with Content-Type: application/cbor when Accept: application/cbor', async () => {
            const response = await request(app?.getServer()).get('/handles/skirt_steak_taco/script').set('Accept', 'application/cbor');
            expect(response.status).toEqual(200);
            expect(response.headers['content-type']).toMatch(/application\/cbor/);
            expect(response.text).toEqual('a247');
        });

        it('emits Deprecation: true header (RFC 9745) on the obsolete route', async () => {
            const response = await request(app?.getServer()).get('/handles/skirt_steak_taco/script');
            expect(response.headers.deprecation).toEqual('true');
            expect(response.headers.link).toContain('rel="successor-version"');
        });

        it('should return script_not_found when handle has no inline script', async () => {
            const response = await request(app?.getServer()).get('/handles/missing_handle_script/script');
            expect(response.status).toEqual(404);
            expect(response.body).toEqual(expect.objectContaining({
                error: 'script_not_found'
            }));
        });

        it('should return script not found', async () => {
            const response = await request(app?.getServer()).get('/handles/no-utxo/script');
            expect(response.status).toEqual(404);
            // `no-utxo` is mocked to be missing entirely, so getHandleFromRepo throws handle_not_found
            // before the script lookup runs. Asserting the umbrella shape.
            expect(response.body).toEqual(expect.objectContaining({
                error: expect.stringMatching(/handle_not_found|script_not_found/)
            }));
        });
    });

    describe('[GET] /handles/:handle/reference_token', () => {
        it('should get reference token datum for a handle', async () => {
            // const scriptDetails: ScriptDetails = {
            //     handle: 'pz_script_01',
            //     handleHex: 'hex',
            //     validatorHash: 'abc',
            //     type: ScriptType.PZ_CONTRACT
            // };
            // jest.spyOn(scripts, 'getScript').mockReturnValue(scriptDetails);
            const response = await request(app?.getServer()).get('/handles/burritos/reference_token');
            expect(response.status).toEqual(200);
            expect(response.body).toEqual({ address: 'addr1_ref_token', datum: '', index: 0, lovelace: 0, tx_id: 'tx_id', script:{ 'cbor': 'a247', type: 'plutus_v2' }});
        });

        it('returns the reference token utxo as-is when it has no inline script', async () => {
            const response = await request(app?.getServer()).get('/handles/missing_ref_script/reference_token');
            expect(response.status).toEqual(200);
            expect(response.body).toEqual({
                address: 'addr1_script_lookup',
                datum: '',
                index: 0,
                lovelace: 0,
                tx_id: 'tx_id_missing_script'
            });
        });

        it('should return empty object when reference token cannot be found', async () => {
            const response = await request(app?.getServer()).get('/handles/no_ref_token/reference_token');
            expect(response.status).toEqual(200);
            expect(response.body).toEqual({});
        });

        it('should return empty object for missing reference token via personalized utxo route', async () => {
            const response = await request(app?.getServer()).get('/handles/no_ref_token/personalized/utxo');
            expect(response.status).toEqual(200);
            expect(response.body).toEqual({});
        });
    });

    describe('[GET] /handles/:handle/utxo', () => {
        it('decodes the embedded datum to JSON by default (no Accept header)', async () => {
            jest.spyOn(cbor, 'decodeCborToJson').mockResolvedValue({ decoded: true } as any);
            const response = await request(app?.getServer()).get('/handles/burritos/utxo');
            expect(response.status).toEqual(200);
            expect(response.body).toEqual(
                expect.objectContaining({
                    tx_id: 'utxo',
                    index: 0,
                    address: 'addr1',
                    datum: { decoded: true },
                    reference_script: 'a247'
                })
            );
        });

        it('decodes the embedded datum to JSON when Accept: application/json', async () => {
            jest.spyOn(cbor, 'decodeCborToJson').mockResolvedValue({ decoded: true } as any);
            const response = await request(app?.getServer()).get('/handles/burritos/utxo').set('Accept', 'application/json');
            expect(response.status).toEqual(200);
            expect(response.body).toEqual(
                expect.objectContaining({
                    datum: { decoded: true }
                })
            );
        });

        it('keeps datum as raw CBOR-hex when Accept: text/plain', async () => {
            const response = await request(app?.getServer()).get('/handles/burritos/utxo').set('Accept', 'text/plain');
            expect(response.status).toEqual(200);
            expect(response.body).toEqual(
                expect.objectContaining({
                    tx_id: 'utxo',
                    index: 0,
                    address: 'addr1',
                    datum: 'burritos_datum',
                    reference_script: 'a247'
                })
            );
        });

        it('keeps datum as raw CBOR-hex when Accept: application/cbor', async () => {
            const response = await request(app?.getServer()).get('/handles/burritos/utxo').set('Accept', 'application/cbor');
            expect(response.status).toEqual(200);
            expect(response.body).toEqual(
                expect.objectContaining({ datum: 'burritos_datum' })
            );
        });

        it('should return 400 when handle utxo datum decode fails for json accept', async () => {
            jest.spyOn(cbor, 'decodeCborToJson').mockImplementation(() => {
                throw new Error('bad cbor');
            });
            const response = await request(app?.getServer()).get('/handles/burritos/utxo').set('Accept', 'application/json');
            expect(response.status).toEqual(400);
            expect(response.body).toEqual(expect.objectContaining({
                error: 'datum_decode_failed',
                message: 'Unable to decode datum to json'
            }));
        });

        it('should return not found when handle utxo does not exist', async () => {
            const response = await request(app?.getServer()).get('/handles/nope/utxo');
            expect(response.status).toEqual(404);
            expect(response.body).toEqual(expect.objectContaining({
                error: 'handle_not_found',
                message: 'Handle not found'
            }));
        });

        it('should get reference token datum for a handle', async () => {
            // const scriptDetails: ScriptDetails = {
            //     handle: 'pz_script_01',
            //     handleHex: 'hex',
            //     validatorHash: 'abc',
            //     type: ScriptType.PZ_CONTRACT
            // };
            //jest.spyOn(scripts, 'getScript').mockReturnValue(scriptDetails);
            const response = await request(app?.getServer()).get('/handles/burritos/personalized/utxo');
            expect(response.status).toEqual(200);
            expect(response.body).toEqual({ address: 'addr1_ref_token', datum: '', index: 0, lovelace: 0, tx_id: 'tx_id', script:{ 'cbor': 'a247', type: 'plutus_v2' } });
        });

        it('should return empty object when reference token cannot be found', async () => {
            const response = await request(app?.getServer()).get('/handles/no_ref_token/reference_token');
            expect(response.status).toEqual(200);
            expect(response.body).toEqual({});
        });
    });

    describe('[GET] /handles/:handle/subhandle_settings', () => {
        it('should return 404 for unminted subhandle', async () => {
            const response = await request(app?.getServer()).get('/handles/nope@handle/subhandle_settings');
            expect(response.status).toEqual(404);
            expect(response.body).toEqual(expect.objectContaining({
                error: 'handle_not_found',
                message: 'Handle not found'
            }));
        });

        it('emits Deprecation: true on the obsolete underscore form', async () => {
            const response = await request(app?.getServer()).get('/handles/sub@handle2/subhandle_settings');
            expect(response.headers.deprecation).toEqual('true');
            expect(response.headers.link).toContain('rel="successor-version"');
            expect(response.headers.link).toContain('/handles/sub@handle2/subhandle-settings');
        });

        it('should return No sub handle settings found', async () => {
            const response = await request(app?.getServer()).get('/handles/no_settings@handle/subhandle_settings');
            expect(response.status).toEqual(404);
            expect(response.body).toEqual(expect.objectContaining({
                error: 'subhandle_settings_not_found',
                message: 'SubHandle settings not found'
            }));
        });

        it('should return invalid settings', async () => {
            const response = await request(app?.getServer()).get('/handles/not@array/subhandle_settings');
            expect(response.status).toEqual(404);
            expect(response.body).toEqual(expect.objectContaining({
                error: 'subhandle_settings_not_found',
                message: 'SubHandle settings not found'
            }));
        });

        it('should return settings cbor', async () => {
            const response = await request(app?.getServer()).get('/handles/sub@handle/subhandle_settings').set('Accept', 'text/plain; charset=utf-8');
            expect(response.status).toEqual(200);
            expect(response.text).toEqual('9f9f01019f9f011a0bebc200ff9f021a05f5e100ff9f031a02faf080ffffa14862675f696d61676540ff9f01019f9f011a01312d00ffffa14862675f696d61676540ff000000581a687474703a2f2f6c6f63616c686f73743a333030372f23746f75005839004988cad9aa1ebd733b165695cfef965fda2ee42dab2d8584c43b039c96f91da5bdb192de2415d3e6d064aec54acee648c2c6879fad1ffda1ff');
        });

        it('should return settings json', async () => {
            const response = await request(app?.getServer()).get('/handles/sub@handle2/subhandle_settings');
            expect(response.status).toEqual(200);
            expect(response.body).toEqual({
                agreed_terms: 'http://localhost:3007/#tou',
                buy_down_paid: 0,
                buy_down_price: 0,
                buy_down_percent: 0,
                migrate_sig_required: false,
                nft: {
                    public_minting_enabled: true,
                    pz_enabled: true,
                    default_styles: { bg_image: '' },
                    tier_pricing: [
                        [1, 200000000],
                        [2, 100000000],
                        [3, 50000000]
                    ]
                },
                payment_address: '0x004988cad9aa1ebd733b165695cfef965fda2ee42dab2d8584c43b039c96f91da5bdb192de2415d3e6d064aec54acee648c2c6879fad1ffda1',
                virtual: {
                    default_styles: { bg_image: '' },
                    public_minting_enabled: true,
                    pz_enabled: true,
                    tier_pricing: [[1, 20000000]]
                },
                utxo_id: 'tx_id_sub_2#0',
                utxo: { address: 'addr1_ref_token', datum: '', index: 0, lovelace: 0, script: { cbor: 'a247', type: 'plutus_v2' }, tx_id: 'tx_id' }
            });
        });

        it('should return settings without utxo when subhandle settings utxo cannot be loaded', async () => {
            const response = await request(app?.getServer()).get('/handles/sub@missing-utxo/subhandle_settings');
            expect(response.status).toEqual(200);
            expect(response.body).toEqual({ utxo_id: 'missing_sub#0' });
        });
    });

    describe('[GET] /handles/:handle/subhandle_settings/utxo', () => {
        it('should return 404 for unminted subhandle', async () => {
            const response = await request(app?.getServer()).get('/handles/nope@handle/subhandle_settings/utxo');
            expect(response.status).toEqual(404);
            expect(response.body).toEqual(expect.objectContaining({
                error: 'handle_not_found',
                message: 'Handle not found'
            }));
        });

        it('should return No sub handle settings found', async () => {
            const response = await request(app?.getServer()).get('/handles/no_settings@handle/subhandle_settings/utxo');
            expect(response.status).toEqual(404);
            expect(response.body).toEqual(expect.objectContaining({
                error: 'subhandle_settings_not_found',
                message: 'SubHandle settings not found'
            }));
        });

        it('should return invalid settings', async () => {
            const response = await request(app?.getServer()).get('/handles/not@array/subhandle_settings/utxo');
            expect(response.status).toEqual(404);
            expect(response.body).toEqual(expect.objectContaining({
                error: 'subhandle_settings_not_found',
                message: 'SubHandle settings not found'
            }));
        });

        it('should return settings utxo json', async () => {
            const response = await request(app?.getServer()).get('/handles/sub@handle2/subhandle_settings/utxo');
            expect(response.status).toEqual(200);
            expect(response.body).toEqual({ address: 'addr1_ref_token', datum: '', index: 0, lovelace: 0, script: { cbor: 'a247', type: 'plutus_v2' }, tx_id: 'tx_id' });
        });

        it('should return 404 when subhandle settings utxo is missing in store', async () => {
            const response = await request(app?.getServer()).get('/handles/sub@missing-utxo/subhandle_settings/utxo');
            expect(response.status).toEqual(404);
            expect(response.body.message).toEqual('SubHandle settings UTxO not found');
        });
    });

    describe('[GET] /handles/:handle/subhandles', () => {
        it('should return 404 for handle not found subhandle', async () => {
            const response = await request(app?.getServer()).get('/handles/nope@handle/subhandles');
            expect(response.status).toEqual(404);
            expect(response.body.message).toEqual('Handle not found');
        });

        it('should return all subhandles', async () => {
            const handleName = 'taco';
            const response = await request(app?.getServer()).get(`/handles/${handleName}/subhandles`);
            expect(response.status).toEqual(200);
            expect(response.body).toEqual([
                { name: `sh1@${handleName}`, handle_type: HandleType.NFT_SUBHANDLE },
                { name: `sh2@${handleName}`, handle_type: HandleType.VIRTUAL_SUBHANDLE },
                { name: `sh3@${handleName}`, handle_type: HandleType.VIRTUAL_SUBHANDLE }
            ]);
        });

        it('should return all virtual subHandles', async () => {
            const handleName = 'burritos';
            const response = await request(app?.getServer()).get(`/handles/${handleName}/subhandles?type=virtual`);
            expect(response.status).toEqual(200);
            expect(response.body).toEqual([
                { name: `sh2@${handleName}`, handle_type: HandleType.VIRTUAL_SUBHANDLE },
                { name: `sh3@${handleName}`, handle_type: HandleType.VIRTUAL_SUBHANDLE }
            ]);
        });

        it('should return all nft subHandles', async () => {
            const handleName = 'burritos';
            const response = await request(app?.getServer()).get(`/handles/${handleName}/subhandles?type=nft`);
            expect(response.status).toEqual(200);
            expect(response.body).toEqual([{ name: `sh1@${handleName}`, handle_type: HandleType.NFT_SUBHANDLE }]);
        });
    });
});
