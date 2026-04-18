import { KoiosTxInfo } from '../interfaces/provider.interface';
import { buildUTxOsFromKoiosTxs, canonicalJsonStringify } from './helpers';

export { buildUTxOsFromKoiosTxs } from './helpers';

describe('helper tests', () => {
    describe('buildUTxOsFromKoiosTxs tests', () => {
        it('should build a UTxO from koios transactions', () => {
            const koiosTransaction: KoiosTxInfo[] = [
                {
                    tx_hash: 'fe40d980c3105c956c2cf29567966b6cafcab0e150e856ec6d4969a4d08aa353',
                    block_hash: '25b2370a6e56ec9a446fef7ac29b3a1df2c3ef7fefcedbf341adcb5dabc9e27b',
                    block_height: 9176202,
                    absolute_slot: 100806855,
                    reference_inputs: [],
                    inputs: [],
                    outputs: [
                        {
                            value: '1176630',
                            tx_hash: 'fe40d980c3105c956c2cf29567966b6cafcab0e150e856ec6d4969a4d08aa353',
                            tx_index: 0,
                            asset_list: [
                                {
                                    decimals: 0,
                                    quantity: '1',
                                    policy_id: 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a',
                                    asset_name: '000de14070617061676f6f7365',
                                    fingerprint: 'asset1vzgj98j02avgzvl8800m8glclw0zfap7lp295j'
                                }
                            ],
                            datum_hash: null,
                            stake_addr: 'stake1u8p9rks9ql9vl6q5dh9hu55vd9drtqjtc8gqtzqtyd99qlcps0kly',
                            inline_datum: null,
                            payment_addr: {
                                cred: '1ec952cbca7b8f6d7068d1e4ff29f1017f8dc76e9f93eb1e3a70b679',
                                bech32: 'addr1qy0vj5ktefac7mtsdrg7flef7yqhlrw8d60e86c78fctv7wz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plspph4a7'
                            },
                            reference_script: null
                        },
                        {
                            value: '2698523204',
                            tx_hash: 'fe40d980c3105c956c2cf29567966b6cafcab0e150e856ec6d4969a4d08aa353',
                            tx_index: 2,
                            asset_list: [],
                            datum_hash: null,
                            stake_addr: 'stake1u8p9rks9ql9vl6q5dh9hu55vd9drtqjtc8gqtzqtyd99qlcps0kly',
                            inline_datum: null,
                            payment_addr: {
                                cred: '1ec952cbca7b8f6d7068d1e4ff29f1017f8dc76e9f93eb1e3a70b679',
                                bech32: 'addr1qy0vj5ktefac7mtsdrg7flef7yqhlrw8d60e86c78fctv7wz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plspph4a7'
                            },
                            reference_script: null
                        },
                        {
                            value: '3672120',
                            tx_hash: 'fe40d980c3105c956c2cf29567966b6cafcab0e150e856ec6d4969a4d08aa353',
                            tx_index: 1,
                            asset_list: [
                                {
                                    decimals: 0,
                                    quantity: '1',
                                    policy_id: 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a',
                                    asset_name: '000643b070617061676f6f7365',
                                    fingerprint: 'asset1tfkk4yhkwa37xqsvtvz9e7rjyk0yhjracdezyw'
                                }
                            ],
                            datum_hash: 'b186aabeddf0c22ea0038a0f656f52edd23e773db9d756d15075fa6035bf5740',
                            stake_addr: null,
                            inline_datum: {
                                bytes: 'd8799faa446e616d654a2470617061676f6f736545696d6167655838697066733a2f2f7a623272686e3733506f647a426436616868757345524a336534325a4e78366539567244364b677a666d62504666794233496d65646961547970654a696d6167652f6a706567426f6700496f675f6e756d6265720046726172697479456261736963466c656e677468094a63686172616374657273476c657474657273516e756d657269635f6d6f64696669657273404776657273696f6e0101af4e7374616e646172645f696d6167655838697066733a2f2f7a623272686e3733506f647a426436616868757345524a336534325a4e78366539567244364b677a666d62504666794233537374616e646172645f696d6167655f686173685820e5ba62039483661322e045be73c5ebb98eb7e6bd6387a7159b3fc4542ebd65364a696d6167655f686173685820e5ba62039483661322e045be73c5ebb98eb7e6bd6387a7159b3fc4542ebd653646706f7274616c404864657369676e65724047736f6369616c73404676656e646f72404764656661756c7400536c6173745f7570646174655f616464726573735839011ec952cbca7b8f6d7068d1e4ff29f1017f8dc76e9f93eb1e3a70b679c251da0507cacfe8146dcb7e528c695a35824bc1d005880b234a507f4c76616c6964617465645f6279581c4da965a049dfd15ed1ee19fba6e2974a0b79fc416dd1796a1f97f5e14b7376675f76657273696f6e46312e31352e304c6167726565645f7465726d7340546d6967726174655f7369675f72657175697265640045747269616c00446e73667700ff',
                                value: {
                                    fields: [
                                        {
                                            map: [
                                                {
                                                    k: {
                                                        bytes: '6e616d65'
                                                    },
                                                    v: {
                                                        bytes: '2470617061676f6f7365'
                                                    }
                                                },
                                                {
                                                    k: {
                                                        bytes: '696d616765'
                                                    },
                                                    v: {
                                                        bytes: '697066733a2f2f7a623272686e3733506f647a426436616868757345524a336534325a4e78366539567244364b677a666d62504666794233'
                                                    }
                                                },
                                                {
                                                    k: {
                                                        bytes: '6d6564696154797065'
                                                    },
                                                    v: {
                                                        bytes: '696d6167652f6a706567'
                                                    }
                                                },
                                                {
                                                    k: {
                                                        bytes: '6f67'
                                                    },
                                                    v: {
                                                        int: 0
                                                    }
                                                },
                                                {
                                                    k: {
                                                        bytes: '6f675f6e756d626572'
                                                    },
                                                    v: {
                                                        int: 0
                                                    }
                                                },
                                                {
                                                    k: {
                                                        bytes: '726172697479'
                                                    },
                                                    v: {
                                                        bytes: '6261736963'
                                                    }
                                                },
                                                {
                                                    k: {
                                                        bytes: '6c656e677468'
                                                    },
                                                    v: {
                                                        int: 9
                                                    }
                                                },
                                                {
                                                    k: {
                                                        bytes: '63686172616374657273'
                                                    },
                                                    v: {
                                                        bytes: '6c657474657273'
                                                    }
                                                },
                                                {
                                                    k: {
                                                        bytes: '6e756d657269635f6d6f64696669657273'
                                                    },
                                                    v: {
                                                        bytes: ''
                                                    }
                                                },
                                                {
                                                    k: {
                                                        bytes: '76657273696f6e'
                                                    },
                                                    v: {
                                                        int: 1
                                                    }
                                                }
                                            ]
                                        },
                                        {
                                            int: 1
                                        },
                                        {
                                            map: [
                                                {
                                                    k: {
                                                        bytes: '7374616e646172645f696d616765'
                                                    },
                                                    v: {
                                                        bytes: '697066733a2f2f7a623272686e3733506f647a426436616868757345524a336534325a4e78366539567244364b677a666d62504666794233'
                                                    }
                                                },
                                                {
                                                    k: {
                                                        bytes: '7374616e646172645f696d6167655f68617368'
                                                    },
                                                    v: {
                                                        bytes: 'e5ba62039483661322e045be73c5ebb98eb7e6bd6387a7159b3fc4542ebd6536'
                                                    }
                                                },
                                                {
                                                    k: {
                                                        bytes: '696d6167655f68617368'
                                                    },
                                                    v: {
                                                        bytes: 'e5ba62039483661322e045be73c5ebb98eb7e6bd6387a7159b3fc4542ebd6536'
                                                    }
                                                },
                                                {
                                                    k: {
                                                        bytes: '706f7274616c'
                                                    },
                                                    v: {
                                                        bytes: ''
                                                    }
                                                },
                                                {
                                                    k: {
                                                        bytes: '64657369676e6572'
                                                    },
                                                    v: {
                                                        bytes: ''
                                                    }
                                                },
                                                {
                                                    k: {
                                                        bytes: '736f6369616c73'
                                                    },
                                                    v: {
                                                        bytes: ''
                                                    }
                                                },
                                                {
                                                    k: {
                                                        bytes: '76656e646f72'
                                                    },
                                                    v: {
                                                        bytes: ''
                                                    }
                                                },
                                                {
                                                    k: {
                                                        bytes: '64656661756c74'
                                                    },
                                                    v: {
                                                        int: 0
                                                    }
                                                },
                                                {
                                                    k: {
                                                        bytes: '6c6173745f7570646174655f61646472657373'
                                                    },
                                                    v: {
                                                        bytes: '011ec952cbca7b8f6d7068d1e4ff29f1017f8dc76e9f93eb1e3a70b679c251da0507cacfe8146dcb7e528c695a35824bc1d005880b234a507f'
                                                    }
                                                },
                                                {
                                                    k: {
                                                        bytes: '76616c6964617465645f6279'
                                                    },
                                                    v: {
                                                        bytes: '4da965a049dfd15ed1ee19fba6e2974a0b79fc416dd1796a1f97f5e1'
                                                    }
                                                },
                                                {
                                                    k: {
                                                        bytes: '7376675f76657273696f6e'
                                                    },
                                                    v: {
                                                        bytes: '312e31352e30'
                                                    }
                                                },
                                                {
                                                    k: {
                                                        bytes: '6167726565645f7465726d73'
                                                    },
                                                    v: {
                                                        bytes: ''
                                                    }
                                                },
                                                {
                                                    k: {
                                                        bytes: '6d6967726174655f7369675f7265717569726564'
                                                    },
                                                    v: {
                                                        int: 0
                                                    }
                                                },
                                                {
                                                    k: {
                                                        bytes: '747269616c'
                                                    },
                                                    v: {
                                                        int: 0
                                                    }
                                                },
                                                {
                                                    k: {
                                                        bytes: '6e736677'
                                                    },
                                                    v: {
                                                        int: 0
                                                    }
                                                }
                                            ]
                                        }
                                    ],
                                    constructor: 0
                                }
                            },
                            payment_addr: {
                                cred: '6c043fc9e3f4dfbabe01e07a54fcf8aa3eaa38e82777b10f9461859c',
                                bech32: 'addr1w9kqg07fu06dlw47q8s8548ulz4ra23caqnh0vg0j3sct8qrsqrpc'
                            },
                            reference_script: null
                        }
                    ],
                    assets_minted: [
                        {
                            decimals: 0,
                            quantity: '1',
                            policy_id: 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a',
                            asset_name: '000643b070617061676f6f7365',
                            fingerprint: 'asset1tfkk4yhkwa37xqsvtvz9e7rjyk0yhjracdezyw'
                        },
                        {
                            decimals: 0,
                            quantity: '1',
                            policy_id: 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a',
                            asset_name: '000de14070617061676f6f7365',
                            fingerprint: 'asset1vzgj98j02avgzvl8800m8glclw0zfap7lp295j'
                        },
                        {
                            decimals: 0,
                            quantity: '-1',
                            policy_id: 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a',
                            asset_name: '70617061676f6f7365',
                            fingerprint: 'asset1g3swf6uz82hvphl8a9slgn43vdd8qpum6tzqg4'
                        }
                    ],
                    metadata: {
                        '721': {
                            f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                                '000de14070617061676f6f7365': {
                                    og: 0,
                                    name: '$papagoose',
                                    image: 'ipfs://zb2rhn73PodzBd6ahhusERJ3e42ZNx6e9VrD6KgzfmbPFfyB3',
                                    length: 9,
                                    rarity: 'basic',
                                    version: 1,
                                    mediaType: 'image/jpeg',
                                    og_number: 0,
                                    characters: 'letters',
                                    numeric_modifiers: ''
                                }
                            }
                        }
                    }
                }
            ];

            const result = buildUTxOsFromKoiosTxs(koiosTransaction);

            expect(result).toEqual([
                {
                    address: 'addr1qy0vj5ktefac7mtsdrg7flef7yqhlrw8d60e86c78fctv7wz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plspph4a7',
                    blockHash: '25b2370a6e56ec9a446fef7ac29b3a1df2c3ef7fefcedbf341adcb5dabc9e27b',
                    blockNum: 9176202,
                    burn: [['f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a', ['70617061676f6f7365']]],
                    handles: [['f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a', ['000de14070617061676f6f7365']]],
                    id: 'fe40d980c3105c956c2cf29567966b6cafcab0e150e856ec6d4969a4d08aa353#0',
                    index: 0,
                    lovelace: 1176630,
                    metadata: {
                        '721': {
                            f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                                '000de14070617061676f6f7365': {
                                    characters: 'letters',
                                    image: 'ipfs://zb2rhn73PodzBd6ahhusERJ3e42ZNx6e9VrD6KgzfmbPFfyB3',
                                    length: 9,
                                    mediaType: 'image/jpeg',
                                    name: '$papagoose',
                                    numeric_modifiers: '',
                                    og: 0,
                                    og_number: 0,
                                    rarity: 'basic',
                                    version: 1
                                }
                            }
                        }
                    },
                    mint: [['f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a', ['000de14070617061676f6f7365']]],
                    slot: 100806855,
                    tx_id: 'fe40d980c3105c956c2cf29567966b6cafcab0e150e856ec6d4969a4d08aa353'
                },
                {
                    address: 'addr1w9kqg07fu06dlw47q8s8548ulz4ra23caqnh0vg0j3sct8qrsqrpc',
                    blockHash: '25b2370a6e56ec9a446fef7ac29b3a1df2c3ef7fefcedbf341adcb5dabc9e27b',
                    blockNum: 9176202,
                    burn: [['f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a', ['70617061676f6f7365']]],
                    datum: 'd8799faa446e616d654a2470617061676f6f736545696d6167655838697066733a2f2f7a623272686e3733506f647a426436616868757345524a336534325a4e78366539567244364b677a666d62504666794233496d65646961547970654a696d6167652f6a706567426f6700496f675f6e756d6265720046726172697479456261736963466c656e677468094a63686172616374657273476c657474657273516e756d657269635f6d6f64696669657273404776657273696f6e0101af4e7374616e646172645f696d6167655838697066733a2f2f7a623272686e3733506f647a426436616868757345524a336534325a4e78366539567244364b677a666d62504666794233537374616e646172645f696d6167655f686173685820e5ba62039483661322e045be73c5ebb98eb7e6bd6387a7159b3fc4542ebd65364a696d6167655f686173685820e5ba62039483661322e045be73c5ebb98eb7e6bd6387a7159b3fc4542ebd653646706f7274616c404864657369676e65724047736f6369616c73404676656e646f72404764656661756c7400536c6173745f7570646174655f616464726573735839011ec952cbca7b8f6d7068d1e4ff29f1017f8dc76e9f93eb1e3a70b679c251da0507cacfe8146dcb7e528c695a35824bc1d005880b234a507f4c76616c6964617465645f6279581c4da965a049dfd15ed1ee19fba6e2974a0b79fc416dd1796a1f97f5e14b7376675f76657273696f6e46312e31352e304c6167726565645f7465726d7340546d6967726174655f7369675f72657175697265640045747269616c00446e73667700ff',
                    handles: [['f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a', ['000643b070617061676f6f7365']]],
                    id: 'fe40d980c3105c956c2cf29567966b6cafcab0e150e856ec6d4969a4d08aa353#1',
                    index: 1,
                    lovelace: 3672120,
                    metadata: {},
                    mint: [['f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a', []]],
                    slot: 100806855,
                    tx_id: 'fe40d980c3105c956c2cf29567966b6cafcab0e150e856ec6d4969a4d08aa353'
                }
            ]);
        });
    });

    // Invariant: two MintingData objects that differ only in property-insertion
    // order must serialize to the same string, so Redis SADD on IndexNames.MINT
    // deduplicates when a block is replayed after a crash. Failure mode: if
    // canonical encoding is removed, a metadata object with reordered keys
    // produces a distinct member and the mint is double-counted on replay.
    describe('canonicalJsonStringify', () => {
        it('produces identical strings for objects whose keys differ only in insertion order', () => {
            const a = { b: 1, a: { z: 'y', x: 'w' }, c: [1, 2] };
            const b = { c: [1, 2], a: { x: 'w', z: 'y' }, b: 1 };
            expect(canonicalJsonStringify(a)).toEqual(canonicalJsonStringify(b));
        });

        it('distinguishes logically different values', () => {
            expect(canonicalJsonStringify({ a: 1 })).not.toEqual(canonicalJsonStringify({ a: 2 }));
            expect(canonicalJsonStringify({ a: 1, b: 2 })).not.toEqual(canonicalJsonStringify({ a: 1 }));
        });

        it('coerces bigint to a numeric string (survives JSON encoding)', () => {
            expect(canonicalJsonStringify({ n: BigInt(42) })).toEqual('{"n":"42"}');
        });

        it('produces stable output across nested arrays and objects', () => {
            const payload = {
                created_slot: 100,
                txHash: 'abc',
                metadata: {
                    '721': {
                        'policy-x': {
                            asset: { og: 0, name: '$ada', image: 'ipfs://x' }
                        }
                    }
                }
            };
            const reordered = {
                metadata: {
                    '721': {
                        'policy-x': {
                            asset: { image: 'ipfs://x', name: '$ada', og: 0 }
                        }
                    }
                },
                txHash: 'abc',
                created_slot: 100
            };
            expect(canonicalJsonStringify(payload)).toEqual(canonicalJsonStringify(reordered));
        });
    });
});
