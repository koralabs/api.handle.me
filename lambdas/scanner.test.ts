import { BlockPraos } from '@cardano-ogmios/schema';
import { IndexNames } from '@koralabs/kora-labs-common';
import { HandlesRepository } from '../repositories/handlesRepository';
import OgmiosService from '../services/ogmios/ogmios.service';
import { RedisHandlesStore } from '../stores/redis';

const storeInstance = new RedisHandlesStore();
const repo = new HandlesRepository(storeInstance);
repo.initialize();
repo.rollBackToGenesis();

const ogmiosService = new OgmiosService(repo);

const block = {
    id: '0000000000000000000000000000000000000000000000000000000000000000',
    slot: 123456789,
    transactions: [
        {
            mint: {
                f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                    '000643b070617061676f6f7365': 1,
                    '000de14070617061676f6f7365': 1,
                    '62696769726973686c696f6e': 1,
                    '70617061676f6f7365': -1
                }
            },
            id: 'fe40d980c3105c956c2cf29567966b6cafcab0e150e856ec6d4969a4d08aa353',
            spends: 'inputs',
            inputs: [],
            outputs: [
                {
                    address: 'addr1qy0vj5ktefac7mtsdrg7flef7yqhlrw8d60e86c78fctv7wz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plspph4a7',
                    value: {
                        ada: {
                            lovelace: 1176630
                        },
                        f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                            '000de14070617061676f6f7365': 1
                        }
                    }
                },
                {
                    address: 'addr1qy0vj5ktefac7mtsdrg7flef7yqhlrw8d60e86c78fctv7wz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plspph4a7',
                    value: {
                        ada: {
                            lovelace: 2698523204
                        }
                    }
                },
                {
                    address: 'addr1w9kqg07fu06dlw47q8s8548ulz4ra23caqnh0vg0j3sct8qrsqrpc',
                    value: {
                        ada: {
                            lovelace: 3672120
                        },
                        f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                            '000643b070617061676f6f7365': 1
                        }
                    },
                    datum: 'd8799faa446e616d654a2470617061676f6f736545696d6167655838697066733a2f2f7a623272686e3733506f647a426436616868757345524a336534325a4e78366539567244364b677a666d62504666794233496d65646961547970654a696d6167652f6a706567426f6700496f675f6e756d6265720046726172697479456261736963466c656e677468094a63686172616374657273476c657474657273516e756d657269635f6d6f64696669657273404776657273696f6e0101af4e7374616e646172645f696d6167655838697066733a2f2f7a623272686e3733506f647a426436616868757345524a336534325a4e78366539567244364b677a666d62504666794233537374616e646172645f696d6167655f686173685820e5ba62039483661322e045be73c5ebb98eb7e6bd6387a7159b3fc4542ebd65364a696d6167655f686173685820e5ba62039483661322e045be73c5ebb98eb7e6bd6387a7159b3fc4542ebd653646706f7274616c404864657369676e65724047736f6369616c73404676656e646f72404764656661756c7400536c6173745f7570646174655f616464726573735839011ec952cbca7b8f6d7068d1e4ff29f1017f8dc76e9f93eb1e3a70b679c251da0507cacfe8146dcb7e528c695a35824bc1d005880b234a507f4c76616c6964617465645f6279581c4da965a049dfd15ed1ee19fba6e2974a0b79fc416dd1796a1f97f5e14b7376675f76657273696f6e46312e31352e304c6167726565645f7465726d7340546d6967726174655f7369675f72657175697265640045747269616c00446e73667700ff'
                },
                {
                    address: 'addr1qy0vj5ktefac7mtsdrg7flef7yqhlrw8d60e86c78fctv7wz28dq2p72el5pgmwt0efgc626xkpyhswsqkyqkg622plspph4a7',
                    value: {
                        ada: {
                            lovelace: 1176630
                        },
                        f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                            '62696769726973686c696f6e': 1
                        }
                    }
                }
            ],
            signatories: [],
            metadata: {
                hash: '',
                labels: {
                    '721': {
                        json: {
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
                                },
                                bigirishlion: {
                                    og: 0,
                                    name: '$bigirishlion',
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
            }
        }
    ]
};

const block2 = {
    id: '919f2d703f8d7b55580fdd7c75111cd5930a57c0497d123fc1039e92a00da80a',
    slot: 175213430,
    transactions: [
        {
            mint: {},
            id: '36cdfdb4fc320a0bbd58fbb518b0120106f71e23b4e094d5554e7058923ed0e0',
            spends: 'inputs',
            inputs: [],
            outputs: [
                {
                    address: 'addr1qy6klwkchy2anq63udppu7t0a56klqg78qx4j3st52w6p255zf8yatzltwcknn3769c3rxppyjskwvfx9mpu4knusl7qg73ul5',
                    value: {
                        ada: {
                            lovelace: 4851116
                        },
                        fe38ef97888dfde0292b7d2ed103543ecf92a419a29634f513a1d71f: {
                            '41534e454b': 2400000
                        },
                        '0c92aabef5a8f91a36470d0762806c165c0d04aa992541e25d55486a': {
                            '424347': 4974855345
                        },
                        '16fdd33c86af604e837ae57d79d5f0f1156406086db5f16afb3fcf51': {
                            '44474f4c44': 25000000
                        },
                        '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f': {
                            '534e454b': 771
                        },
                        '5ad8deb64bfec21ad2d96e1270b5873d0c4d0f231b928b4c39eb2435': {
                            '61646f736961': 500000000
                        },
                        '5dac8536653edc12f6f5e1045d8164b9f59998d3bdc300fc92843489': {
                            '4e4d4b52': 80000000
                        },
                        '76f94b9413c8ccefde3171e9fa378023d8a1672ecc8c308b6ac7e36f': {
                            '534e454b5a': 113053096
                        },
                        '804f5544c1962a40546827cab750a88404dc7108c0f588b72964754f': {
                            '56594649': 500000
                        },
                        '96ad5ab136d2193dda2afb662285b93e48d265e14df59ee0f33925ae': {
                            '4447454d': 500000
                        },
                        af2e27f580f7f08e93190a81f72462f153026d06450924726645891b: {
                            '44524950': 1250000000
                        },
                        b6a7467ea1deb012808ef4e87b5ff371e85f7142d7b356a40d9b42a0: {
                            '436f726e75636f70696173205b76696120436861696e506f72742e696f5d': 5000000
                        },
                        b7c783f6304eddbdf8f0dece4715d63cb9f453be89d97c8fba155d57: {
                            '52455349': 1034880870
                        },
                        d0e741c2232a470faf41e16f615d7a9219e7c129b9822aed664bf905: {
                            '47544149': 68117
                        },
                        e4214b7cce62ac6fbba385d164df48e157eae5863521b4b67ca71d86: {
                            '6aa2153e1ae896a95539c9d62f76cedcdabdcdf144e564b8955f609d660cf6a2': 2628224
                        },
                        e79497f972acb83461608d3f48281a406ee1e9f64ed168868145141e: {
                            '5374616b65506f6f6c323437': 25000000
                        },
                        ea153b5d4864af15a1079a94a0e2486d6376fa28aafad272d15b243a: {
                            '0014df10536861726473': 1000000
                        },
                        ec791114f636d27a669ca74140be352da82f7c836ce52100e8abb342: {
                            '52495a5a': 1401
                        }
                    }
                },
                {
                    address: 'DdzFFzCqrhsgrjW2ucsHfasyqXRRMHYpF2tJzpcVYT5fBQmyBRgMn1c4qqexc7qoSR1jfMEerW7s8XvWZWXSWrprJn94yJVXDJgF6fAz',
                    value: {
                        ada: {
                            lovelace: 133500000
                        }
                    }
                }
            ],
            signatories: [],
            metadata: {
                hash: '',
                labels: {}
            }
        },
        {
            mint: {},
            id: 'e1700f2927700250db39dc3efb4ed1ba0d2f67940a7eeef1dfa84d154d8c045c',
            spends: 'inputs',
            inputs: [],
            outputs: [
                {
                    address: 'addr1q9d06jjcgwelwyy6j0ynpkx86uf44cdjgjz56rxc98cwm7fmm32teay77rueh4h33g28h7nxvgv9gaw73tmawmz6eqxstydaeg',
                    value: {
                        ada: {
                            lovelace: 25817489
                        }
                    }
                },
                {
                    address: 'addr1q9d06jjcgwelwyy6j0ynpkx86uf44cdjgjz56rxc98cwm7fmm32teay77rueh4h33g28h7nxvgv9gaw73tmawmz6eqxstydaeg',
                    value: {
                        ada: {
                            lovelace: 1827926
                        },
                        '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa': {
                            '4e49474854': 169579153
                        }
                    }
                },
                {
                    address: 'addr1z8p79rpkcdz8x9d6tft0x0dx5mwuzac2sa4gm8cvkw5hcnpmm32teay77rueh4h33g28h7nxvgv9gaw73tmawmz6eqxs7dz8kw',
                    value: {
                        ada: {
                            lovelace: 3469550
                        },
                        '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa': {
                            '4e49474854': 169579153
                        }
                    },
                    datum: null
                }
            ],
            signatories: [],
            metadata: {
                hash: '',
                labels: {
                    '674': {
                        json: {
                            msg: ['Minswap: Routing Order']
                        }
                    }
                }
            }
        },
        {
            mint: {},
            id: '2ce3a5abd02f949e0de0e0096d61c428fa273d1b1f5378ff1cc0f18449bb8054',
            spends: 'inputs',
            inputs: [],
            outputs: [
                {
                    address: 'addr1vy2evjefdlsjk6mt07tqgv46659jqgpve00ylemwgdtgj9qn5uzd4',
                    value: {
                        ada: {
                            lovelace: 32576894
                        }
                    }
                },
                {
                    address: 'addr1z8p79rpkcdz8x9d6tft0x0dx5mwuzac2sa4gm8cvkw5hcnzj2c79gy9l76sdg0xwhd7r0c0kna0tycz4y5s6mlenh8pqsfywsm',
                    value: {
                        ada: {
                            lovelace: 2700000
                        },
                        '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa': {
                            '4e49474854': 88369932
                        }
                    },
                    datum: null
                }
            ],
            signatories: [],
            metadata: {
                hash: '',
                labels: {
                    '674': {
                        json: {
                            msg: ['Minswap: Aggregator Market Order'],
                            extraData: ['{"sender":{"$address":"addr1vy2evjefdlsjk6mt07tqgv46659jqgpve00y', 'lemwgdtgj9qn5uzd4"},"orderOptions":[{"source":"MinswapV2","asset', 'In":{"$asset":"0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cb', 'b5af1fa.4e49474854"},"assetOut":{"$asset":"lovelace"},"amountIn"', ':{"$bigint":"88369932"},"minimumReceived":{"$bigint":"20148800"}', ',"dexFee":{"$bigint":"700000"},"deposit":{"$bigint":"2000000"},"', 'version":"DEX_V2","type":0,"minimumAmountOut":{"$bigint":"201488', '00"},"direction":0,"killOnFailed":false,"isLimitOrder":false,"lp', 'Asset":{"$asset":"f5808c2c990d86da54bfc97d89cee6efa20cd846161635', '9478d96b4c.e74c52975908a612d5ce68327040d449aae99f8b463bb6de046a1', 'b23c5713169"}}]}']
                        }
                    }
                }
            }
        },
        {
            mint: {},
            id: '307be92ab14a3dcf8bee5964afcdefd2aee0fa7c3e9cf4027a88e024d15e7656',
            spends: 'inputs',
            inputs: [],
            outputs: [
                {
                    address: 'addr1q9d06jjcgwelwyy6j0ynpkx86uf44cdjgjz56rxc98cwm7fmm32teay77rueh4h33g28h7nxvgv9gaw73tmawmz6eqxstydaeg',
                    value: {
                        ada: {
                            lovelace: 42118851
                        }
                    }
                },
                {
                    address: 'addr1q9dhugez3ka82k2kgh7r2lg0j7aztr8uell46kydfwu3vk6n8w2cdu8mn2ha278q6q25a9rc6gmpfeekavuargcd32vsvxhl7e',
                    value: {
                        ada: {
                            lovelace: 153927023
                        }
                    }
                },
                {
                    address: 'addr1z84q0denmyep98ph3tmzwsmw0j7zau9ljmsqx6a4rvaau66j2c79gy9l76sdg0xwhd7r0c0kna0tycz4y5s6mlenh8pq777e2a',
                    value: {
                        ada: {
                            lovelace: 4500000
                        },
                        '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f': {
                            '534e454b': 318645712
                        },
                        f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c: {
                            '3b3318a251bb71f8345c5affcd29645af2f56859eea740bec2a27c91027cb01d': 9223372003774527000,
                            '4d5350': 1
                        },
                        '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa': {
                            '4e49474854': 3694741133347
                        }
                    },
                    datum: null
                },
                {
                    address: 'addr1z84q0denmyep98ph3tmzwsmw0j7zau9ljmsqx6a4rvaau66j2c79gy9l76sdg0xwhd7r0c0kna0tycz4y5s6mlenh8pq777e2a',
                    value: {
                        ada: {
                            lovelace: 4500000
                        },
                        f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c: {
                            '4d5350': 1,
                            eb1fa227ffc87df5e235dfbb0130d151f620cd585abb067ad50ea619dba0fc05: 9223372036376233000
                        },
                        '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f': {
                            '534e454b': 1504633
                        },
                        '29d222ce763455e3d7a09a665ce554f00ac89d2e99a1a83d267170c6': {
                            '4d494e': 164762211590
                        }
                    },
                    datum: null
                },
                {
                    address: 'addr1z84q0denmyep98ph3tmzwsmw0j7zau9ljmsqx6a4rvaau66j2c79gy9l76sdg0xwhd7r0c0kna0tycz4y5s6mlenh8pq777e2a',
                    value: {
                        ada: {
                            lovelace: 5059094100503
                        },
                        '29d222ce763455e3d7a09a665ce554f00ac89d2e99a1a83d267170c6': {
                            '4d494e': 201824118810838
                        },
                        f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c: {
                            '4d5350': 1,
                            '82e2b1fd27a7712a1a9cf750dfbea1a5778611b20e06dd6a611df7a643f8cb75': 9223340812667611000
                        }
                    },
                    datum: null
                }
            ],
            signatories: [],
            metadata: {
                hash: '',
                labels: {
                    '674': {
                        json: {
                            msg: ['Minswap: Order Executed']
                        }
                    }
                }
            }
        },
        {
            mint: {
                ecac528a850db0d7a0ca6b3452e640bc65236b32b55591478b8984fd: {
                    '4d69646e6967687453746174696f6e35393735': 1
                }
            },
            id: '82eaac99b641f204ffeaf1c900511c7ae94f8ee0f5774d477b0f430f97267abf',
            spends: 'inputs',
            inputs: [],
            outputs: [
                {
                    address: 'addr1qxewxq5d4atsz988aedcm0j0ewhckznte838468nggaymg0y0zrtezn30w606w7jxammh8xg7m26j6t0wdvh93cmjs0qmfjy4m',
                    value: {
                        ada: {
                            lovelace: 10959111
                        }
                    }
                },
                {
                    address: 'addr1qyqm7tmr6pv525xrjczsa8vt5z2g83d7l7aq50ej8lshksu3aykeypx2a7a7hfm2xzetnhdlxurx22a5h0fjxp6g94kse34ndu',
                    value: {
                        ada: {
                            lovelace: 3230000
                        },
                        ecac528a850db0d7a0ca6b3452e640bc65236b32b55591478b8984fd: {
                            '4d69646e6967687453746174696f6e35393735': 1
                        }
                    }
                },
                {
                    address: 'addr1qytcgpelg4m8n0hrgkx8nhr6servtt4qhmntxufdga32lzhuynvp2sdsx64g8dy3fd4pd7hs9lyn0j5vhwuzthz8xkessrfdse',
                    value: {
                        ada: {
                            lovelace: 4696740
                        }
                    }
                }
            ],
            signatories: [],
            metadata: {
                hash: '',
                labels: {
                    '721': {
                        json: {
                            ecac528a850db0d7a0ca6b3452e640bc65236b32b55591478b8984fd: {
                                MidnightStation5975: {
                                    id: '5975',
                                    name: 'Midnight Station #5975',
                                    files: [
                                        {
                                            src: 'ipfs://QmWpgLJbSANgLWR976p4g5RxXDHomEa6AgUTT3iiV11mn5',
                                            name: 'High-Res Cover Image',
                                            mediaType: 'image/png'
                                        }
                                    ],
                                    image: 'ipfs://QmTckwX72BdLcTszvQ6RNnacedcsrkPpmr29U8oxaciA1K',
                                    sha256: '44e0b6cd4457bbd30266746462ae69074ce1ca9d15fef61c6411ba25cd4a2108',
                                    authors: [],
                                    deaType: 'music',
                                    website: 'https://stuff.io',
                                    mediaType: 'image/jpeg',
                                    attributes: {
                                        Variation: '0',
                                        'Cover Theme': 'Midnight Station'
                                    },
                                    entrypoint: 'ipfs://QmZYrzzvVn45zTfXEFwpRPdUzG385KVKun238pE7NZ6P5u',
                                    description: ['The NFT song Midnight Station represents a moment of arrival aft', 'er a long and demanding journey.'],
                                    dataMediaType: 'application/lpf+zip',
                                    extraAttributes: {
                                        Artists: ['SongMarketCap.com'],
                                        'Album Title': 'Midnight Station'
                                    }
                                }
                            }
                        }
                    }
                }
            }
        },
        {
            mint: {},
            id: '4bfda1c2ff21509e85ebc1e05b8cfedd5de669dd57d6067ea0edce1380e656bc',
            spends: 'inputs',
            inputs: [],
            outputs: [
                {
                    address: 'addr1q85l97rmhcjhrdhpr07hyws9w47kglmrjastr32cvka08nrhmzkc76h6lg9uh42nsnulppxztq7w4y2fatj5wcy7k8fqrdt6rj',
                    value: {
                        ada: {
                            lovelace: 2413467
                        }
                    }
                },
                {
                    address: 'addr1w9f6fven7fuvlufqfye95w750v3k622pzg5j46rsj2uxrcqamm6fe',
                    value: {
                        ada: {
                            lovelace: 3900000
                        },
                        '25c5de5f5b286073c593edfd77b48abc7a48e5a4f3d4cd9d428ff935': {
                            '44454741': 35216494462630
                        }
                    }
                }
            ],
            signatories: [],
            metadata: {
                hash: '',
                labels: {
                    '674': {
                        json: {
                            msg: 'VyFi: LP Swap B for A Order Request'
                        }
                    }
                }
            }
        },
        {
            mint: {},
            id: '0df9aea8301c650dcc12d4f4a12a13ecbc91ba74cbe304558ceb16b735e6e872',
            spends: 'inputs',
            inputs: [],
            outputs: [
                {
                    address: 'addr1q8l7hny7x96fadvq8cukyqkcfca5xmkrvfrrkt7hp76v3qvssm7fz9ajmtd58ksljgkyvqu6gl23hlcfgv7um5v0rn8qtnzlfk',
                    value: {
                        ada: {
                            lovelace: 1750000
                        }
                    }
                },
                {
                    address: 'addr1q9vupd506q40322p9wg2yrern9kezm7z9dlppg7knjvm2kqnv43nv7j7apc4ta3qlm5clrd4838a7mga6nr2k4futhtqus90hz',
                    value: {
                        ada: {
                            lovelace: 2000000
                        }
                    }
                },
                {
                    address: 'addr1q9vupd506q40322p9wg2yrern9kezm7z9dlppg7knjvm2kqnv43nv7j7apc4ta3qlm5clrd4838a7mga6nr2k4futhtqus90hz',
                    value: {
                        ada: {
                            lovelace: 503866614
                        }
                    }
                },
                {
                    address: 'addr1z8p79rpkcdz8x9d6tft0x0dx5mwuzac2sa4gm8cvkw5hcnqnv43nv7j7apc4ta3qlm5clrd4838a7mga6nr2k4futhtq6u49cz',
                    value: {
                        ada: {
                            lovelace: 2715300
                        },
                        '75f91f2db50f1c492cb936dbb962aaf89463e3a01e86954611bb1a21': {
                            '0014df104e495445': 9286928289217
                        }
                    },
                    datum: null
                }
            ],
            signatories: [],
            metadata: {
                hash: '',
                labels: {
                    '674': {
                        json: {
                            msg: ['Dexhunter Trade', 'Partner DHMOBILE']
                        }
                    }
                }
            }
        },
        {
            mint: {},
            id: '5ae51f004fb7798aec1ad476af14c6c15296a3f1662f74789788f560ee6ff269',
            spends: 'inputs',
            inputs: [],
            outputs: [
                {
                    address: 'addr1qyjhsn4r6ldfrnkedcsuwj7sguzjcm3ptay4n4fskw4e4s37ywzej8elagtyjt43v2x3ewkmm8mgrz8dpr2snefk0lts4kwn8p',
                    value: {
                        ada: {
                            lovelace: 101000949
                        }
                    }
                },
                {
                    address: 'addr1z8p79rpkcdz8x9d6tft0x0dx5mwuzac2sa4gm8cvkw5hcnp7ywzej8elagtyjt43v2x3ewkmm8mgrz8dpr2snefk0lts6r479u',
                    value: {
                        ada: {
                            lovelace: 2700000
                        },
                        e992ef75f2367e6ecd93716ae88eba0d005dd91fd3a21f650b6496b5: {
                            '5355524745': 5000000000
                        }
                    },
                    datum: null
                }
            ],
            signatories: [],
            metadata: {
                hash: '',
                labels: {
                    '674': {
                        json: {
                            msg: ['Minswap: Market Order']
                        }
                    }
                }
            }
        },
        {
            mint: {},
            id: '60cc6c7bfa07ed407362d110a21f253cea4a51c3ad324886b72fd263762fe72d',
            spends: 'inputs',
            inputs: [],
            outputs: [
                {
                    address: 'addr1q93k6rgprz5fxwkpvl2vgjq4pwejth400f8aldz2m3lj7khrnd05p259l0qjrf396am6wahv5895ey35y62fexta3q5q3cc3k8',
                    value: {
                        ada: {
                            lovelace: 2000000
                        },
                        '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa': {
                            '4e49474854': 25694152638
                        }
                    }
                },
                {
                    address: 'addr1q93k6rgprz5fxwkpvl2vgjq4pwejth400f8aldz2m3lj7khrnd05p259l0qjrf396am6wahv5895ey35y62fexta3q5q3cc3k8',
                    value: {
                        ada: {
                            lovelace: 12216449430
                        }
                    }
                },
                {
                    address: 'addr1w8p79rpkcdz8x9d6tft0x0dx5mwuzac2sa4gm8cvkw5hcnqst2ctf',
                    value: {
                        ada: {
                            lovelace: 2700000
                        },
                        '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa': {
                            '4e49474854': 13233808010
                        }
                    },
                    datum: null
                }
            ],
            signatories: [],
            metadata: {
                hash: '',
                labels: {}
            }
        },
        {
            mint: {},
            id: 'cfd3d651bc517ea9cc580e5539c5924e95898c630a5ec30033c76239a44c4672',
            spends: 'inputs',
            inputs: [],
            outputs: [
                {
                    address: 'addr1q8hyl84qscjqlja095vvuhcfzhf9wr5vjxc5jk2dwrrxgslwf702pp3ypl967tgcee0sj9wj2u8geyd3f9v56uxxv3psxk5h9e',
                    value: {
                        ada: {
                            lovelace: 1000000
                        }
                    }
                },
                {
                    address: 'addr1q8hyl84qscjqlja095vvuhcfzhf9wr5vjxc5jk2dwrrxgslwf702pp3ypl967tgcee0sj9wj2u8geyd3f9v56uxxv3psxk5h9e',
                    value: {
                        ada: {
                            lovelace: 5973706978
                        }
                    }
                },
                {
                    address: 'addr1q8hyl84qscjqlja095vvuhcfzhf9wr5vjxc5jk2dwrrxgslwf702pp3ypl967tgcee0sj9wj2u8geyd3f9v56uxxv3psxk5h9e',
                    value: {
                        ada: {
                            lovelace: 1224040
                        },
                        dc2ac9b105bbfa44ceb9804b7e008e4e760bc6a9370305cabee01a69: {
                            '724553544b': 1
                        }
                    }
                }
            ],
            signatories: [],
            metadata: {
                hash: '',
                labels: {}
            }
        },
        {
            mint: {},
            id: 'e62735db2d0f67b3710106a424d13a7a33ebf15abe5cfb2de33f914a7023daba',
            spends: 'inputs',
            inputs: [],
            outputs: [
                {
                    address: 'addr1q9dhugez3ka82k2kgh7r2lg0j7aztr8uell46kydfwu3vk6n8w2cdu8mn2ha278q6q25a9rc6gmpfeekavuargcd32vsvxhl7e',
                    value: {
                        ada: {
                            lovelace: 104976101
                        }
                    }
                },
                {
                    address: 'addr1qyjhsn4r6ldfrnkedcsuwj7sguzjcm3ptay4n4fskw4e4s37ywzej8elagtyjt43v2x3ewkmm8mgrz8dpr2snefk0lts4kwn8p',
                    value: {
                        ada: {
                            lovelace: 955353529
                        }
                    }
                },
                {
                    address: 'addr1z84q0denmyep98ph3tmzwsmw0j7zau9ljmsqx6a4rvaau66j2c79gy9l76sdg0xwhd7r0c0kna0tycz4y5s6mlenh8pq777e2a',
                    value: {
                        ada: {
                            lovelace: 560669787094
                        },
                        e992ef75f2367e6ecd93716ae88eba0d005dd91fd3a21f650b6496b5: {
                            '5355524745': 2944032493524
                        },
                        f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c: {
                            '4d5350': 1,
                            ab2bc7cba8f1e4edbfbb83b630082ba6d711b7059dad402baa636d0e355732d5: 9223370758807617000
                        }
                    },
                    datum: null
                }
            ],
            signatories: [],
            metadata: {
                hash: '',
                labels: {
                    '674': {
                        json: {
                            msg: ['Minswap: Order Executed']
                        }
                    }
                }
            }
        },
        {
            mint: {},
            id: '641096f241b8e0d2ab744fba442adda7d498c1f51200b1f02b1e596eee3ff3f3',
            spends: 'inputs',
            inputs: [],
            outputs: [
                {
                    address: 'addr1q93k6rgprz5fxwkpvl2vgjq4pwejth400f8aldz2m3lj7khrnd05p259l0qjrf396am6wahv5895ey35y62fexta3q5q3cc3k8',
                    value: {
                        ada: {
                            lovelace: 2000000
                        },
                        '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa': {
                            '4e49474854': 6597308164
                        }
                    }
                },
                {
                    address: 'addr1q93k6rgprz5fxwkpvl2vgjq4pwejth400f8aldz2m3lj7khrnd05p259l0qjrf396am6wahv5895ey35y62fexta3q5q3cc3k8',
                    value: {
                        ada: {
                            lovelace: 2000000
                        },
                        '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa': {
                            '4e49474854': 6597308164
                        }
                    }
                },
                {
                    address: 'addr1q93k6rgprz5fxwkpvl2vgjq4pwejth400f8aldz2m3lj7khrnd05p259l0qjrf396am6wahv5895ey35y62fexta3q5q3cc3k8',
                    value: {
                        ada: {
                            lovelace: 11402336207
                        }
                    }
                },
                {
                    address: 'addr1z8d9k3aw6w24eyfjacy809h68dv2rwnpw0arrfau98jk6nhv88awp8sgxk65d6kry0mar3rd0dlkfljz7dv64eu39vfs38yd9p',
                    value: {
                        ada: {
                            lovelace: 2690000
                        },
                        '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa': {
                            '4e49474854': 2743589633
                        }
                    },
                    datum: null
                }
            ],
            signatories: [],
            metadata: {
                hash: '',
                labels: {}
            }
        },
        {
            mint: {},
            id: 'cef659230fc1499940042769476c64d0274aecbf463dc732a81355c731ea69c4',
            spends: 'inputs',
            inputs: [],
            outputs: [
                {
                    address: 'addr1q8yhrhs8vkffe3zfdf57j6x9kw2qzzemf69y0lmzqqqz0f258njxy545ldalpghka7sx94479e49pt7w94mc0ehe0kaszh649h',
                    value: {
                        ada: {
                            lovelace: 70574030
                        }
                    }
                },
                {
                    address: 'addr1qxzgjtcejm7634pp5u0spsfxysh04xw376z3ppvym9pnhpz58njxy545ldalpghka7sx94479e49pt7w94mc0ehe0kascvrr5y',
                    value: {
                        ada: {
                            lovelace: 1000000
                        }
                    }
                }
            ],
            signatories: [],
            metadata: {
                hash: '',
                labels: {
                    '0': {
                        json: {
                            string: '27a82cd4b68fb515cb638fd815a6e9e7021d68195fa3b247b8bab790afad5e14'
                        }
                    },
                    '1': {
                        json: {
                            string: '14264362025-12-26 14:08'
                        }
                    },
                    '2': {
                        json: {
                            string: 'EMISOR OSCAR TONATHIU ESQUIVEL GALLEGOS'
                        }
                    },
                    '3': {
                        json: {
                            string: 'BENEFICIARIO NR FINANCE MEXICO, S.A. DE C.V.'
                        }
                    },
                    '4': {
                        json: {}
                    }
                }
            }
        },
        {
            mint: {},
            id: '3b032dea2cadb4b11ffa644ef740d591fc2bdfdd5e320b08ab3a6f3383c85e31',
            spends: 'inputs',
            inputs: [],
            outputs: [
                {
                    address: 'addr1qy9f7wepw3fegcf9m27pnyp9z8kvhrzyad0qk4tpehqr55kl854w0hemr56c66a2cylzzt6hyvkl9r2s73h7d3kr6vrsm943w8',
                    value: {
                        ada: {
                            lovelace: 207891563
                        }
                    }
                }
            ],
            signatories: [],
            metadata: {
                hash: '',
                labels: {}
            }
        },
        {
            mint: {
                f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                    '000643b06162646576': 1,
                    '000643b062656e6e795f62657473': 1,
                    '000643b062656e6e7962657473': 1,
                    '000643b0707379636869636d656469756d': 1,
                    '000643b0776f6f647340686f736b796d6f6a69': 1,
                    '000de1406162646576': 1,
                    '000de14062656e6e795f62657473': 1,
                    '000de14062656e6e7962657473': 1,
                    '000de140707379636869636d656469756d': 1,
                    '000de140776f6f647340686f736b796d6f6a69': 1
                }
            },
            id: '46e9c80f24149260b9e11591e1b521b57ba4819558a0bb06b61ef6663daea661',
            spends: 'inputs',
            inputs: [],
            outputs: [
                {
                    address: 'addr1q822xzvnxwtkdd556c5namjthxd4ezzmhk2f3ckfugxdmtmge7uh3j7040l00g5r3mg96uqc6rwtaxe9hewvmmprnkxqw7vwsg',
                    value: {
                        ada: {
                            lovelace: 1305930
                        },
                        f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                            '000de140776f6f647340686f736b796d6f6a69': 1
                        }
                    },
                    datum: null
                },
                {
                    address: 'addr1qxvhs4dm8hxhjpv5gsryq8ew5aypf2de3ds6fk65zzlxxk4a8e52c877782lf5gt82427gm0kkm8ee87q2qdr49gwkss6q9gfr',
                    value: {
                        ada: {
                            lovelace: 1254210
                        },
                        f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                            '000de14062656e6e7962657473': 1
                        }
                    },
                    datum: null
                },
                {
                    address: 'addr1qxvhs4dm8hxhjpv5gsryq8ew5aypf2de3ds6fk65zzlxxk4a8e52c877782lf5gt82427gm0kkm8ee87q2qdr49gwkss6q9gfr',
                    value: {
                        ada: {
                            lovelace: 1262830
                        },
                        f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                            '000de14062656e6e795f62657473': 1
                        }
                    },
                    datum: null
                },
                {
                    address: 'addr1qyuwqxqlkhukxct859wrd59xrwsrcm4srnhyvrp43n4def4hz9f2f7zf329u7syhxh75zy8tpkwkw0frly45wlqv9kgq33tkzm',
                    value: {
                        ada: {
                            lovelace: 1219730
                        },
                        f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                            '000de1406162646576': 1
                        }
                    },
                    datum: null
                },
                {
                    address: 'addr1qyv3m7ngcsf6ckq5gsc4jmsuv2nv9dngnmgwyszlks308yetkkt2vkmud7zpxdj8mnkpj6dytz57xf0fdljxcyruetwqxsq9c9',
                    value: {
                        ada: {
                            lovelace: 1288690
                        },
                        f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                            '000de140707379636869636d656469756d': 1
                        }
                    },
                    datum: null
                },
                {
                    address: 'addr1v9m40zw2zsen29k2d2aq7h8q72qj7ne4sz7lq7lcverr3cqj9g7u5',
                    value: {
                        ada: {
                            lovelace: 640074128
                        }
                    }
                },
                {
                    address: 'addr1w92nme22mmx9exl6spktuq6pm6wg4ruw7y7j36r2sy5yxvcyerj3z',
                    value: {
                        ada: {
                            lovelace: 1340410
                        },
                        f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                            '000de14068616e646c655f726f6f744068616e646c655f73657474696e6773': 1
                        }
                    },
                    datum: null
                },
                {
                    address: 'addr1wxktka03n943759y4pcexpmftdhzsrrv8kcd2qs8cwgtdhgg6j4ux',
                    value: {
                        ada: {
                            lovelace: 3939340
                        },
                        f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                            '000643b0707379636869636d656469756d': 1
                        }
                    },
                    datum: null
                },
                {
                    address: 'addr1wxktka03n943759y4pcexpmftdhzsrrv8kcd2qs8cwgtdhgg6j4ux',
                    value: {
                        ada: {
                            lovelace: 3904860
                        },
                        f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                            '000643b062656e6e7962657473': 1
                        }
                    },
                    datum: null
                },
                {
                    address: 'addr1wxktka03n943759y4pcexpmftdhzsrrv8kcd2qs8cwgtdhgg6j4ux',
                    value: {
                        ada: {
                            lovelace: 3947960
                        },
                        f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                            '000643b062656e6e795f62657473': 1
                        }
                    },
                    datum: null
                },
                {
                    address: 'addr1wxktka03n943759y4pcexpmftdhzsrrv8kcd2qs8cwgtdhgg6j4ux',
                    value: {
                        ada: {
                            lovelace: 3874690
                        },
                        f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                            '000643b06162646576': 1
                        }
                    },
                    datum: null
                },
                {
                    address: 'addr1wxktka03n943759y4pcexpmftdhzsrrv8kcd2qs8cwgtdhgg6j4ux',
                    value: {
                        ada: {
                            lovelace: 4314310
                        },
                        f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                            '000643b0776f6f647340686f736b796d6f6a69': 1
                        }
                    },
                    datum: null
                }
            ],
            signatories: [],
            metadata: {
                hash: '',
                labels: {
                    '721': {
                        json: {
                            f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                                '000de1406162646576': {
                                    og: 0,
                                    name: '$abdev',
                                    image: 'ipfs://zb2rhmWQEVXYzufNZipNT1rmM5fMEtQ3vUccKETeMqtDpgiWx',
                                    length: 5,
                                    rarity: 'common',
                                    version: 1,
                                    mediaType: 'image/jpeg',
                                    og_number: 0,
                                    characters: 'letters',
                                    handle_type: 'handle',
                                    numeric_modifiers: ''
                                },
                                '000de14062656e6e7962657473': {
                                    og: 0,
                                    name: '$bennybets',
                                    image: 'ipfs://zb2rhnwppgQpjb1w7Ln7FzKVeFMaqTu9yHbEd4w5ACU3kFrXF',
                                    length: 9,
                                    rarity: 'basic',
                                    version: 1,
                                    mediaType: 'image/jpeg',
                                    og_number: 0,
                                    characters: 'letters',
                                    handle_type: 'handle',
                                    numeric_modifiers: ''
                                },
                                '000de14062656e6e795f62657473': {
                                    og: 0,
                                    name: '$benny_bets',
                                    image: 'ipfs://zb2rhbEfLTrjHWEmwgj7JA1v3C6qV3bxviNkydcMhXWdRvSyW',
                                    length: 10,
                                    rarity: 'basic',
                                    version: 1,
                                    mediaType: 'image/jpeg',
                                    og_number: 0,
                                    characters: 'letters,special',
                                    handle_type: 'handle',
                                    numeric_modifiers: ''
                                },
                                '000de140707379636869636d656469756d': {
                                    og: 0,
                                    name: '$psychicmedium',
                                    image: 'ipfs://zb2rhZMsukh7XBWVNRmUqNnUA6tKZRacG3QTVA3YW5RGwp1Vu',
                                    length: 13,
                                    rarity: 'basic',
                                    version: 1,
                                    mediaType: 'image/jpeg',
                                    og_number: 0,
                                    characters: 'letters',
                                    handle_type: 'handle',
                                    numeric_modifiers: ''
                                },
                                '000de140776f6f647340686f736b796d6f6a69': {
                                    og: 0,
                                    name: '$woods@hoskymoji',
                                    image: 'ipfs://zb2rhWjhGZqapm5TVmTKAH7fupKPXGwjXE21Z4A4cqCJN5TGT',
                                    length: 15,
                                    rarity: 'basic',
                                    version: 1,
                                    mediaType: 'image/jpeg',
                                    og_number: 0,
                                    characters: 'letters',
                                    sub_length: 5,
                                    sub_rarity: 'common',
                                    handle_type: 'nft_subhandle',
                                    sub_characters: 'letters',
                                    numeric_modifiers: '',
                                    sub_numeric_modifiers: ''
                                }
                            }
                        }
                    }
                }
            }
        }
    ]
};

const blockFromOgmios = {
    type: 'praos',
    era: 'conway',
    id: '919f2d703f8d7b55580fdd7c75111cd5930a57c0497d123fc1039e92a00da80a',
    size: {
        bytes: 24416
    },
    height: 12828122,
    slot: 175213430,
    ancestor: '8eec51c02e821572cbc1ab3efa51475f72212375231539a80bcc4d81ef94314e',
    issuer: {
        verificationKey: '7bcb2c54e66aedad08fde8c5736d412b460a7c11e5a7a176c34e3a31c4db6b7e',
        vrfVerificationKey: 'e77b1436b83529fdce52c805ef47a722cb0401503e2d6fdf68f8e3fbcc9f409b',
        operationalCertificate: {
            count: 7,
            sigma: 'df531f2fc8cfd98a2e6c97670f4ac29c77d19eb55454d727d5f739150c7f2879b2419aa0e51c07d867f9b3135abef65a0dcd1872fdd6c2be45f60b41e7b96908',
            kes: {
                period: 1335,
                verificationKey: '4bbf0f2b61bdf262a63631d35974eebdee406adf818e16bd5e049935a5a89ed3'
            }
        },
        leaderValue: {
            output: '9943f1caf18dee7b9b048dee9e9d099ac284c12c1c5e1189ba40970c4c21fed1b9d21828de9d4fbb85274a5a539488f86ad78c2e68906084d94f97d4d391e0c4',
            proof: 'adc432acb44c3c28c0002fd8e02cebc5e88c09efaebeaab0a6df42bb3847fb6ab7c9e5a574eb279f61706779f2049b0e9cfff22dfb8541d5497b0f1bd7ca3b04afc7a863783c21a7dbf138a79977d40d'
        }
    },
    protocol: {
        version: {
            major: 10,
            minor: 6
        }
    },
    transactions: [
        {
            id: '36cdfdb4fc320a0bbd58fbb518b0120106f71e23b4e094d5554e7058923ed0e0',
            spends: 'inputs',
            inputs: [
                {
                    transaction: {
                        id: '77582cf3b21d5a5852b2ce92826bbd9b4f816ea13ac7ba556bf018f1672bd21b'
                    },
                    index: 0
                },
                {
                    transaction: {
                        id: 'cfcd80dff130dabe2ae45b809daf015e0d1e38dd7a6583a27d7ed1820a43a177'
                    },
                    index: 1
                }
            ],
            outputs: [
                {
                    address: 'DdzFFzCqrhsgrjW2ucsHfasyqXRRMHYpF2tJzpcVYT5fBQmyBRgMn1c4qqexc7qoSR1jfMEerW7s8XvWZWXSWrprJn94yJVXDJgF6fAz',
                    value: {
                        ada: {
                            lovelace: 133500000
                        }
                    }
                },
                {
                    address: 'addr1qy6klwkchy2anq63udppu7t0a56klqg78qx4j3st52w6p255zf8yatzltwcknn3769c3rxppyjskwvfx9mpu4knusl7qg73ul5',
                    value: {
                        ada: {
                            lovelace: 4851116
                        },
                        '0c92aabef5a8f91a36470d0762806c165c0d04aa992541e25d55486a': {
                            '424347': 4974855345
                        },
                        '16fdd33c86af604e837ae57d79d5f0f1156406086db5f16afb3fcf51': {
                            '44474f4c44': 25000000
                        },
                        '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f': {
                            '534e454b': 771
                        },
                        '5ad8deb64bfec21ad2d96e1270b5873d0c4d0f231b928b4c39eb2435': {
                            '61646f736961': 500000000
                        },
                        '5dac8536653edc12f6f5e1045d8164b9f59998d3bdc300fc92843489': {
                            '4e4d4b52': 80000000
                        },
                        '76f94b9413c8ccefde3171e9fa378023d8a1672ecc8c308b6ac7e36f': {
                            '534e454b5a': 113053096
                        },
                        '804f5544c1962a40546827cab750a88404dc7108c0f588b72964754f': {
                            '56594649': 500000
                        },
                        '96ad5ab136d2193dda2afb662285b93e48d265e14df59ee0f33925ae': {
                            '4447454d': 500000
                        },
                        af2e27f580f7f08e93190a81f72462f153026d06450924726645891b: {
                            '44524950': 1250000000
                        },
                        b6a7467ea1deb012808ef4e87b5ff371e85f7142d7b356a40d9b42a0: {
                            '436f726e75636f70696173205b76696120436861696e506f72742e696f5d': 5000000
                        },
                        b7c783f6304eddbdf8f0dece4715d63cb9f453be89d97c8fba155d57: {
                            '52455349': 1034880870
                        },
                        d0e741c2232a470faf41e16f615d7a9219e7c129b9822aed664bf905: {
                            '47544149': 68117
                        },
                        e4214b7cce62ac6fbba385d164df48e157eae5863521b4b67ca71d86: {
                            '6aa2153e1ae896a95539c9d62f76cedcdabdcdf144e564b8955f609d660cf6a2': 2628224
                        },
                        e79497f972acb83461608d3f48281a406ee1e9f64ed168868145141e: {
                            '5374616b65506f6f6c323437': 25000000
                        },
                        ea153b5d4864af15a1079a94a0e2486d6376fa28aafad272d15b243a: {
                            '0014df10536861726473': 1000000
                        },
                        ec791114f636d27a669ca74140be352da82f7c836ce52100e8abb342: {
                            '52495a5a': 1401
                        },
                        fe38ef97888dfde0292b7d2ed103543ecf92a419a29634f513a1d71f: {
                            '41534e454b': 2400000
                        }
                    }
                }
            ],
            fee: {
                ada: {
                    lovelace: 204749
                }
            },
            validityInterval: {
                invalidAfter: 175220601
            },
            treasury: {},
            signatories: [
                {
                    key: '51bf6df2390ac45c0c58ccbd6456390686f86a12b8c4ded4e78b441ddb260c7a',
                    signature: '798f6d78ae1e401cf5355b34448b7d738ffae282944a863b8d35a602f9dacd9e8f019f2e218ea5e78d204a76bc1c0394430515f25e0514442a04fa69a960f205'
                }
            ],
            cbor: '84a4008282582077582cf3b21d5a5852b2ce92826bbd9b4f816ea13ac7ba556bf018f1672bd21b00825820cfcd80dff130dabe2ae45b809daf015e0d1e38dd7a6583a27d7ed1820a43a17701018282584c82d818584283581c1786643151ce008d9c8a1c501307fb504a2c663376d78a7b470579b6a101581e581c843730545ba27df0277360e75e366235ca5d0f9d44413f86dfb5a0c4001a7dc3cce31a07f50c6082583901356fbad8b915d98351e3421e796fed356f811e380d59460ba29da0aa94124e4eac5f5bb169ce3ed17111982124a16731262ec3cada7c87fc821a004a05acb1581c0c92aabef5a8f91a36470d0762806c165c0d04aa992541e25d55486aa1434243471b00000001288644b1581c16fdd33c86af604e837ae57d79d5f0f1156406086db5f16afb3fcf51a14544474f4c441a017d7840581c279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3fa144534e454b190303581c5ad8deb64bfec21ad2d96e1270b5873d0c4d0f231b928b4c39eb2435a14661646f7369611a1dcd6500581c5dac8536653edc12f6f5e1045d8164b9f59998d3bdc300fc92843489a1444e4d4b521a04c4b400581c76f94b9413c8ccefde3171e9fa378023d8a1672ecc8c308b6ac7e36fa145534e454b5a1a06bd0da8581c804f5544c1962a40546827cab750a88404dc7108c0f588b72964754fa144565946491a0007a120581c96ad5ab136d2193dda2afb662285b93e48d265e14df59ee0f33925aea1444447454d1a0007a120581caf2e27f580f7f08e93190a81f72462f153026d06450924726645891ba144445249501a4a817c80581cb6a7467ea1deb012808ef4e87b5ff371e85f7142d7b356a40d9b42a0a1581e436f726e75636f70696173205b76696120436861696e506f72742e696f5d1a004c4b40581cb7c783f6304eddbdf8f0dece4715d63cb9f453be89d97c8fba155d57a144524553491a3daf0766581cd0e741c2232a470faf41e16f615d7a9219e7c129b9822aed664bf905a144475441491a00010a15581ce4214b7cce62ac6fbba385d164df48e157eae5863521b4b67ca71d86a158206aa2153e1ae896a95539c9d62f76cedcdabdcdf144e564b8955f609d660cf6a21a00281a80581ce79497f972acb83461608d3f48281a406ee1e9f64ed168868145141ea14c5374616b65506f6f6c3234371a017d7840581cea153b5d4864af15a1079a94a0e2486d6376fa28aafad272d15b243aa14a0014df105368617264731a000f4240581cec791114f636d27a669ca74140be352da82f7c836ce52100e8abb342a14452495a5a190579581cfe38ef97888dfde0292b7d2ed103543ecf92a419a29634f513a1d71fa14541534e454b1a00249f00021a00031fcd031a0a71a779a1008182582051bf6df2390ac45c0c58ccbd6456390686f86a12b8c4ded4e78b441ddb260c7a5840798f6d78ae1e401cf5355b34448b7d738ffae282944a863b8d35a602f9dacd9e8f019f2e218ea5e78d204a76bc1c0394430515f25e0514442a04fa69a960f205f5f6'
        },
        {
            id: 'e1700f2927700250db39dc3efb4ed1ba0d2f67940a7eeef1dfa84d154d8c045c',
            spends: 'inputs',
            inputs: [
                {
                    transaction: {
                        id: 'e33233ee4058614b8352c0769592aa826a073c5029a31360c5ebb49da78625aa'
                    },
                    index: 1
                },
                {
                    transaction: {
                        id: 'e33233ee4058614b8352c0769592aa826a073c5029a31360c5ebb49da78625aa'
                    },
                    index: 3
                }
            ],
            outputs: [
                {
                    address: 'addr1z8p79rpkcdz8x9d6tft0x0dx5mwuzac2sa4gm8cvkw5hcnpmm32teay77rueh4h33g28h7nxvgv9gaw73tmawmz6eqxs7dz8kw',
                    value: {
                        ada: {
                            lovelace: 3469550
                        },
                        '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa': {
                            '4e49474854': 169579153
                        }
                    },
                    datum: 'd8799fd8799f581c5afd4a5843b3f7109a93c930d8c7d7135ae1b244854d0cd829f0edf9ffd8799fd8799f581c5afd4a5843b3f7109a93c930d8c7d7135ae1b244854d0cd829f0edf9ffd8799fd8799fd8799f581c3bdc54bcf49ef0f99bd6f18a147bfa6662185475de8af7d76c5ac80dffffffffd87980d8799fd8799f581c5afd4a5843b3f7109a93c930d8c7d7135ae1b244854d0cd829f0edf9ffd8799fd8799fd8799f581c3bdc54bcf49ef0f99bd6f18a147bfa6662185475de8af7d76c5ac80dffffffffd87980d8799f581cf5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c58203b3318a251bb71f8345c5affcd29645af2f56859eea740bec2a27c91027cb01dffd905029f9fd8799fd8799f581cf5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c58203b3318a251bb71f8345c5affcd29645af2f56859eea740bec2a27c91027cb01dffd87a80ffd8799fd8799f581cf5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c5820eb1fa227ffc87df5e235dfbb0130d151f620cd585abb067ad50ea619dba0fc05ffd87a80ffd8799fd8799f581cf5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c582082e2b1fd27a7712a1a9cf750dfbea1a5778611b20e06dd6a611df7a643f8cb75ffd87980ffffd8799f1a0a1b9291ff1a025878daff1a000dbba0d87a80ff'
                },
                {
                    address: 'addr1q9d06jjcgwelwyy6j0ynpkx86uf44cdjgjz56rxc98cwm7fmm32teay77rueh4h33g28h7nxvgv9gaw73tmawmz6eqxstydaeg',
                    value: {
                        ada: {
                            lovelace: 25817489
                        }
                    }
                },
                {
                    address: 'addr1q9d06jjcgwelwyy6j0ynpkx86uf44cdjgjz56rxc98cwm7fmm32teay77rueh4h33g28h7nxvgv9gaw73tmawmz6eqxstydaeg',
                    value: {
                        ada: {
                            lovelace: 1827926
                        },
                        '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa': {
                            '4e49474854': 169579153
                        }
                    }
                }
            ],
            fee: {
                ada: {
                    lovelace: 207741
                }
            },
            validityInterval: {
                invalidAfter: 175224185
            },
            treasury: {},
            metadata: {
                hash: '1425b75d047191a35bf22cd4b7c8ae73ccba9691c102ab29540261da5260439e',
                labels: {
                    '674': {
                        json: {
                            msg: ['Minswap: Routing Order']
                        }
                    }
                }
            },
            signatories: [
                {
                    key: '656618d4a29bf10767296989ddb66d46e2af0f8d6adc6fef9fa861aed50e5784',
                    signature: 'bfa7ca61691ca01bba998d33f1bea9e0e78b7b36cf6a9e7a96488b18ba88a6a34331e46ca4ea9496d1c8da9ec4fb195aa9a69a77549e4b3342286f4321f62c0f'
                },
                {
                    key: '39d21000fc2f5ad2e65b5c50cea623f25c11a073e63fdeaaf915e2befc511947',
                    signature: 'c0c9489eabbd2a58179978f6414c6806418ac7d1d66914b2fcc7ddc81c2226fbb75628e766ed5aabe0e5213e3f58a68017a1955d062623090c6a66caa10f7b0b'
                }
            ],
            cbor: '84a500d9010282825820e33233ee4058614b8352c0769592aa826a073c5029a31360c5ebb49da78625aa01825820e33233ee4058614b8352c0769592aa826a073c5029a31360c5ebb49da78625aa030183a300583911c3e28c36c3447315ba5a56f33da6a6ddc1770a876a8d9f0cb3a97c4c3bdc54bcf49ef0f99bd6f18a147bfa6662185475de8af7d76c5ac80d01821a0034f0eea1581c0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1faa1454e494748541a0a1b9291028201d81859020ed8799fd8799f581c5afd4a5843b3f7109a93c930d8c7d7135ae1b244854d0cd829f0edf9ffd8799fd8799f581c5afd4a5843b3f7109a93c930d8c7d7135ae1b244854d0cd829f0edf9ffd8799fd8799fd8799f581c3bdc54bcf49ef0f99bd6f18a147bfa6662185475de8af7d76c5ac80dffffffffd87980d8799fd8799f581c5afd4a5843b3f7109a93c930d8c7d7135ae1b244854d0cd829f0edf9ffd8799fd8799fd8799f581c3bdc54bcf49ef0f99bd6f18a147bfa6662185475de8af7d76c5ac80dffffffffd87980d8799f581cf5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c58203b3318a251bb71f8345c5affcd29645af2f56859eea740bec2a27c91027cb01dffd905029f9fd8799fd8799f581cf5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c58203b3318a251bb71f8345c5affcd29645af2f56859eea740bec2a27c91027cb01dffd87a80ffd8799fd8799f581cf5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c5820eb1fa227ffc87df5e235dfbb0130d151f620cd585abb067ad50ea619dba0fc05ffd87a80ffd8799fd8799f581cf5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c582082e2b1fd27a7712a1a9cf750dfbea1a5778611b20e06dd6a611df7a643f8cb75ffd87980ffffd8799f1a0a1b9291ff1a025878daff1a000dbba0d87a80ff825839015afd4a5843b3f7109a93c930d8c7d7135ae1b244854d0cd829f0edf93bdc54bcf49ef0f99bd6f18a147bfa6662185475de8af7d76c5ac80d1a0189f191825839015afd4a5843b3f7109a93c930d8c7d7135ae1b244854d0cd829f0edf93bdc54bcf49ef0f99bd6f18a147bfa6662185475de8af7d76c5ac80d821a001be456a1581c0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1faa1454e494748541a0a1b9291021a00032b7d031a0a71b5790758201425b75d047191a35bf22cd4b7c8ae73ccba9691c102ab29540261da5260439ea100d9010282825820656618d4a29bf10767296989ddb66d46e2af0f8d6adc6fef9fa861aed50e57845840bfa7ca61691ca01bba998d33f1bea9e0e78b7b36cf6a9e7a96488b18ba88a6a34331e46ca4ea9496d1c8da9ec4fb195aa9a69a77549e4b3342286f4321f62c0f82582039d21000fc2f5ad2e65b5c50cea623f25c11a073e63fdeaaf915e2befc5119475840c0c9489eabbd2a58179978f6414c6806418ac7d1d66914b2fcc7ddc81c2226fbb75628e766ed5aabe0e5213e3f58a68017a1955d062623090c6a66caa10f7b0bf5a11902a2a1636d736781764d696e737761703a20526f7574696e67204f72646572'
        },
        {
            id: '2ce3a5abd02f949e0de0e0096d61c428fa273d1b1f5378ff1cc0f18449bb8054',
            spends: 'inputs',
            inputs: [
                {
                    transaction: {
                        id: '2e071386376f44e1e0f76905ad352ac87c8afef827fa7a83117ba502564fc03e'
                    },
                    index: 1
                },
                {
                    transaction: {
                        id: '39f845b002cb8a7a89dc3e248f245dc3274c337915b6aa8ea771a6d60f3a95ed'
                    },
                    index: 2
                },
                {
                    transaction: {
                        id: 'ad775557e45c4e637e992e1fb88bee1bb6d680d2111864b5f93e7089e04dea03'
                    },
                    index: 2
                }
            ],
            outputs: [
                {
                    address: 'addr1z8p79rpkcdz8x9d6tft0x0dx5mwuzac2sa4gm8cvkw5hcnzj2c79gy9l76sdg0xwhd7r0c0kna0tycz4y5s6mlenh8pqsfywsm',
                    value: {
                        ada: {
                            lovelace: 2700000
                        },
                        '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa': {
                            '4e49474854': 88369932
                        }
                    },
                    datum: 'd8799fd8799f581c15964b296fe12b6b6b7f960432bad50b20202ccbde4fe76e43568914ffd8799fd8799f581c15964b296fe12b6b6b7f960432bad50b20202ccbde4fe76e43568914ffd87a80ffd87980d8799fd8799f581c15964b296fe12b6b6b7f960432bad50b20202ccbde4fe76e43568914ffd87a80ffd87980d8799f581cf5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c5820e74c52975908a612d5ce68327040d449aae99f8b463bb6de046a1b23c5713169ffd8799fd87980d8799f1a05446b0cff1a01337240d87980ff1a000aae60d87a80ff'
                },
                {
                    address: 'addr1vy2evjefdlsjk6mt07tqgv46659jqgpve00ylemwgdtgj9qn5uzd4',
                    value: {
                        ada: {
                            lovelace: 32576894
                        }
                    }
                }
            ],
            fee: {
                ada: {
                    lovelace: 216365
                }
            },
            validityInterval: {
                invalidAfter: 175224205
            },
            treasury: {},
            metadata: {
                hash: '422c4df60c22ee51b18e46858b8146531950bed2723cb26c2ccb463a026ad96c',
                labels: {
                    '674': {
                        json: {
                            extraData: ['{"sender":{"$address":"addr1vy2evjefdlsjk6mt07tqgv46659jqgpve00y', 'lemwgdtgj9qn5uzd4"},"orderOptions":[{"source":"MinswapV2","asset', 'In":{"$asset":"0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cb', 'b5af1fa.4e49474854"},"assetOut":{"$asset":"lovelace"},"amountIn"', ':{"$bigint":"88369932"},"minimumReceived":{"$bigint":"20148800"}', ',"dexFee":{"$bigint":"700000"},"deposit":{"$bigint":"2000000"},"', 'version":"DEX_V2","type":0,"minimumAmountOut":{"$bigint":"201488', '00"},"direction":0,"killOnFailed":false,"isLimitOrder":false,"lp', 'Asset":{"$asset":"f5808c2c990d86da54bfc97d89cee6efa20cd846161635', '9478d96b4c.e74c52975908a612d5ce68327040d449aae99f8b463bb6de046a1', 'b23c5713169"}}]}'],
                            msg: ['Minswap: Aggregator Market Order']
                        }
                    }
                }
            },
            signatories: [
                {
                    key: '2fdb765643d2faac643cd7517e6428266f3cdb6267eec47578059def090aeba8',
                    signature: '8e33028ce78e3ae16956077292b4215fb932737e554582a5d6891adc1e41d04f923807579da03b1c51abc796e0f887fcb0eb9dec7999dbbaf205a05dd084f80f'
                }
            ],
            cbor: '84a500d90102838258202e071386376f44e1e0f76905ad352ac87c8afef827fa7a83117ba502564fc03e0182582039f845b002cb8a7a89dc3e248f245dc3274c337915b6aa8ea771a6d60f3a95ed02825820ad775557e45c4e637e992e1fb88bee1bb6d680d2111864b5f93e7089e04dea03020182a300583911c3e28c36c3447315ba5a56f33da6a6ddc1770a876a8d9f0cb3a97c4c52563c5410bff6a0d43ccebb7c37e1f69f5eb260552521adff33b9c201821a002932e0a1581c0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1faa1454e494748541a05446b0c028201d81858e2d8799fd8799f581c15964b296fe12b6b6b7f960432bad50b20202ccbde4fe76e43568914ffd8799fd8799f581c15964b296fe12b6b6b7f960432bad50b20202ccbde4fe76e43568914ffd87a80ffd87980d8799fd8799f581c15964b296fe12b6b6b7f960432bad50b20202ccbde4fe76e43568914ffd87a80ffd87980d8799f581cf5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c5820e74c52975908a612d5ce68327040d449aae99f8b463bb6de046a1b23c5713169ffd8799fd87980d8799f1a05446b0cff1a01337240d87980ff1a000aae60d87a80ff82581d6115964b296fe12b6b6b7f960432bad50b20202ccbde4fe76e435689141a01f1157e021a00034d2d031a0a71b58d075820422c4df60c22ee51b18e46858b8146531950bed2723cb26c2ccb463a026ad96ca100d90102818258202fdb765643d2faac643cd7517e6428266f3cdb6267eec47578059def090aeba858408e33028ce78e3ae16956077292b4215fb932737e554582a5d6891adc1e41d04f923807579da03b1c51abc796e0f887fcb0eb9dec7999dbbaf205a05dd084f80ff5a11902a2a2696578747261446174618b78407b2273656e646572223a7b222461646472657373223a22616464723176793265766a6566646c736a6b366d7430377471677634363635396a716770766530307978406c656d77676474676a39716e35757a6434227d2c226f726465724f7074696f6e73223a5b7b22736f75726365223a224d696e737761705632222c2261737365747840496e223a7b22246173736574223a22303639316232666563636131616334663533636236646662303062373031336535363164316633343430336239353763627840623561663166612e34653439343734383534227d2c2261737365744f7574223a7b22246173736574223a226c6f76656c616365227d2c22616d6f756e74496e2278403a7b2224626967696e74223a223838333639393332227d2c226d696e696d756d5265636569766564223a7b2224626967696e74223a223230313438383030227d78402c22646578466565223a7b2224626967696e74223a22373030303030227d2c226465706f736974223a7b2224626967696e74223a2232303030303030227d2c22784076657273696f6e223a224445585f5632222c2274797065223a302c226d696e696d756d416d6f756e744f7574223a7b2224626967696e74223a2232303134383878403030227d2c22646972656374696f6e223a302c226b696c6c4f6e4661696c6564223a66616c73652c2269734c696d69744f72646572223a66616c73652c226c7078404173736574223a7b22246173736574223a22663538303863326339393064383664613534626663393764383963656536656661323063643834363136313633357840393437386439366234632e6537346335323937353930386136313264356365363833323730343064343439616165393966386234363362623664653034366131706232336335373133313639227d7d5d7d636d73678178204d696e737761703a2041676772656761746f72204d61726b6574204f72646572'
        },
        {
            id: '307be92ab14a3dcf8bee5964afcdefd2aee0fa7c3e9cf4027a88e024d15e7656',
            spends: 'inputs',
            inputs: [
                {
                    transaction: {
                        id: '29739eaccdcd5d6d3a194cbd17ab09e2f6a4946a3114278af1367293b216755c'
                    },
                    index: 2
                },
                {
                    transaction: {
                        id: '4c937ed5c6499f2dbd5fd3a4079650fd356395c007d15321527222cc317e8a00'
                    },
                    index: 2
                },
                {
                    transaction: {
                        id: '93698530b7d925c67bd5da9295974e571d4d7e97029dab438fe4712fd0f46e65'
                    },
                    index: 1
                },
                {
                    transaction: {
                        id: 'c181d6843ffda36e9d3eba3582a8d64dffa89d9591fd63c6c158656429b3d693'
                    },
                    index: 1
                },
                {
                    transaction: {
                        id: 'e1700f2927700250db39dc3efb4ed1ba0d2f67940a7eeef1dfa84d154d8c045c'
                    },
                    index: 0
                }
            ],
            references: [
                {
                    transaction: {
                        id: '0dc17712e37a4e741767db2f90d4ffbf69faf88b9bed4c47864f7bd912924bea'
                    },
                    index: 0
                },
                {
                    transaction: {
                        id: '2536194d2a976370a932174c10975493ab58fd7c16395d50e62b7c0e1949baea'
                    },
                    index: 0
                },
                {
                    transaction: {
                        id: 'cf4ecddde0d81f9ce8fcc881a85eb1f8ccdaf6807f03fea4cd02da896a621776'
                    },
                    index: 0
                },
                {
                    transaction: {
                        id: 'd46bd227bd2cf93dedd22ae9b6d92d30140cf0d68b756f6608e38d680c61ad17'
                    },
                    index: 0
                }
            ],
            outputs: [
                {
                    address: 'addr1q9d06jjcgwelwyy6j0ynpkx86uf44cdjgjz56rxc98cwm7fmm32teay77rueh4h33g28h7nxvgv9gaw73tmawmz6eqxstydaeg',
                    value: {
                        ada: {
                            lovelace: 42118851
                        }
                    }
                },
                {
                    address: 'addr1z84q0denmyep98ph3tmzwsmw0j7zau9ljmsqx6a4rvaau66j2c79gy9l76sdg0xwhd7r0c0kna0tycz4y5s6mlenh8pq777e2a',
                    value: {
                        ada: {
                            lovelace: 4500000
                        },
                        '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa': {
                            '4e49474854': 3694741133347
                        },
                        '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f': {
                            '534e454b': 318645712
                        },
                        f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c: {
                            '3b3318a251bb71f8345c5affcd29645af2f56859eea740bec2a27c91027cb01d': 9223372003774527999,
                            '4d5350': 1
                        }
                    },
                    datum: 'd8799fd8799fd87a9f581c1eae96baf29e27682ea3f815aba361a0c6059d45e4bfbe95bbd2f44affffd8799f581c0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa454e49474854ffd8799f581c279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f44534e454bff1b00000007b3bc860a1b0000035c377617991a12fe25d018641864d8799f190e52ffd87980ff'
                },
                {
                    address: 'addr1z84q0denmyep98ph3tmzwsmw0j7zau9ljmsqx6a4rvaau66j2c79gy9l76sdg0xwhd7r0c0kna0tycz4y5s6mlenh8pq777e2a',
                    value: {
                        ada: {
                            lovelace: 4500000
                        },
                        '279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f': {
                            '534e454b': 1504633
                        },
                        '29d222ce763455e3d7a09a665ce554f00ac89d2e99a1a83d267170c6': {
                            '4d494e': 164762211590
                        },
                        f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c: {
                            '4d5350': 1,
                            eb1fa227ffc87df5e235dfbb0130d151f620cd585abb067ad50ea619dba0fc05: 9223372036376233177
                        }
                    },
                    datum: 'd8799fd8799fd87a9f581c1eae96baf29e27682ea3f815aba361a0c6059d45e4bfbe95bbd2f44affffd8799f581c279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f44534e454bffd8799f581c29d222ce763455e3d7a09a665ce554f00ac89d2e99a1a83d267170c6434d494eff1a1c85fb301a0016dc041b0000002622de5236181e181ed8799f190682ffd87980ff'
                },
                {
                    address: 'addr1z84q0denmyep98ph3tmzwsmw0j7zau9ljmsqx6a4rvaau66j2c79gy9l76sdg0xwhd7r0c0kna0tycz4y5s6mlenh8pq777e2a',
                    value: {
                        ada: {
                            lovelace: 5059094100503
                        },
                        '29d222ce763455e3d7a09a665ce554f00ac89d2e99a1a83d267170c6': {
                            '4d494e': 201824118810838
                        },
                        f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c: {
                            '4d5350': 1,
                            '82e2b1fd27a7712a1a9cf750dfbea1a5778611b20e06dd6a611df7a643f8cb75': 9223340812667610800
                        }
                    },
                    datum: 'd8799fd8799fd87a9f581c1eae96baf29e27682ea3f815aba361a0c6059d45e4bfbe95bbd2f44affffd8799f4040ffd8799f581c29d222ce763455e3d7a09a665ce554f00ac89d2e99a1a83d267170c6434d494eff1b00001c65f29599591b00000499e80beac71b0000b78eb41e2b0e181e1864d8799f190d05ffd87980ff'
                },
                {
                    address: 'addr1q9dhugez3ka82k2kgh7r2lg0j7aztr8uell46kydfwu3vk6n8w2cdu8mn2ha278q6q25a9rc6gmpfeekavuargcd32vsvxhl7e',
                    value: {
                        ada: {
                            lovelace: 153927023
                        }
                    }
                }
            ],
            collaterals: [
                {
                    transaction: {
                        id: '29739eaccdcd5d6d3a194cbd17ab09e2f6a4946a3114278af1367293b216755c'
                    },
                    index: 2
                }
            ],
            collateralReturn: {
                address: 'addr1q9dhugez3ka82k2kgh7r2lg0j7aztr8uell46kydfwu3vk6n8w2cdu8mn2ha278q6q25a9rc6gmpfeekavuargcd32vsvxhl7e',
                value: {
                    ada: {
                        lovelace: 148891552
                    }
                }
            },
            totalCollateral: {
                ada: {
                    lovelace: 5000000
                }
            },
            withdrawals: {
                stake17y02a946720zw6pw50upt2arvxsvvpvaghjtl054h0f0gjsfyjz59: {
                    ada: {
                        lovelace: 0
                    }
                }
            },
            requiredExtraSignatories: ['5b7e23228dba75595645fc357d0f97ba258cfccfff5d588d4bb9165b'],
            scriptIntegrityHash: '16269035b337cea69355e93f5d0e575534633a06342f322333a72fec2eb077cd',
            fee: {
                ada: {
                    lovelace: 864529
                }
            },
            validityInterval: {
                invalidBefore: 175213401,
                invalidAfter: 175213581
            },
            treasury: {},
            metadata: {
                hash: '5160f88b929bf8a6c57c285b889488f9137c0ef3cfd0bcf408a10020e69146d5',
                labels: {
                    '674': {
                        json: {
                            msg: ['Minswap: Order Executed']
                        }
                    }
                }
            },
            signatories: [
                {
                    key: 'c5d63d7dc066df52592135b6d3cb4f3470d06f7bdd4b2d2e32eb59ca3782662f',
                    signature: '9b027891bae08ccd79a4e025df5091d298410a644316d11041f1747a74a7831b0fd26e001dfebfdf760ca0c65856e69361e567f99d14ae9fbf32c8a80b3f3008'
                }
            ],
            redeemers: [
                {
                    validator: {
                        index: 1,
                        purpose: 'spend'
                    },
                    redeemer: 'd87980',
                    executionUnits: {
                        memory: 77308,
                        cpu: 23525984
                    }
                },
                {
                    validator: {
                        index: 2,
                        purpose: 'spend'
                    },
                    redeemer: 'd87980',
                    executionUnits: {
                        memory: 77308,
                        cpu: 23525984
                    }
                },
                {
                    validator: {
                        index: 3,
                        purpose: 'spend'
                    },
                    redeemer: 'd87980',
                    executionUnits: {
                        memory: 77308,
                        cpu: 23525984
                    }
                },
                {
                    validator: {
                        index: 4,
                        purpose: 'spend'
                    },
                    redeemer: 'd87980',
                    executionUnits: {
                        memory: 25305,
                        cpu: 8177555
                    }
                },
                {
                    validator: {
                        index: 0,
                        purpose: 'withdraw'
                    },
                    redeemer: 'd8799f009f1a000dbba0ff4100d8799f43000102ff9fd87a80d87a80d87a80ffff',
                    executionUnits: {
                        memory: 3141261,
                        cpu: 1019479317
                    }
                }
            ],
            cbor: '84ad00d901028582582029739eaccdcd5d6d3a194cbd17ab09e2f6a4946a3114278af1367293b216755c028258204c937ed5c6499f2dbd5fd3a4079650fd356395c007d15321527222cc317e8a000282582093698530b7d925c67bd5da9295974e571d4d7e97029dab438fe4712fd0f46e6501825820c181d6843ffda36e9d3eba3582a8d64dffa89d9591fd63c6c158656429b3d69301825820e1700f2927700250db39dc3efb4ed1ba0d2f67940a7eeef1dfa84d154d8c045c000185825839015afd4a5843b3f7109a93c930d8c7d7135ae1b244854d0cd829f0edf93bdc54bcf49ef0f99bd6f18a147bfa6662185475de8af7d76c5ac80d1a0282aec3a300583911ea07b733d932129c378af627436e7cbc2ef0bf96e0036bb51b3bde6b52563c5410bff6a0d43ccebb7c37e1f69f5eb260552521adff33b9c201821a0044aa20a3581c0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1faa1454e494748541b0000035c3fbb9823581c279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3fa144534e454b1a12fe25d0581cf5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4ca2434d53500158203b3318a251bb71f8345c5affcd29645af2f56859eea740bec2a27c91027cb01d1b7ffffff84c4379ff028201d818589ed8799fd8799fd87a9f581c1eae96baf29e27682ea3f815aba361a0c6059d45e4bfbe95bbd2f44affffd8799f581c0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa454e49474854ffd8799f581c279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f44534e454bff1b00000007b3bc860a1b0000035c377617991a12fe25d018641864d8799f190e52ffd87980ffa300583911ea07b733d932129c378af627436e7cbc2ef0bf96e0036bb51b3bde6b52563c5410bff6a0d43ccebb7c37e1f69f5eb260552521adff33b9c201821a0044aa20a3581c279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3fa144534e454b1a0016f579581c29d222ce763455e3d7a09a665ce554f00ac89d2e99a1a83d267170c6a1434d494e1b000000265c97d506581cf5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4ca2434d5350015820eb1fa227ffc87df5e235dfbb0130d151f620cd585abb067ad50ea619dba0fc051b7fffffffe37a04d9028201d8185898d8799fd8799fd87a9f581c1eae96baf29e27682ea3f815aba361a0c6059d45e4bfbe95bbd2f44affffd8799f581c279c909f348e533da5808898f87f9a14bb2c3dfbbacccd631d927a3f44534e454bffd8799f581c29d222ce763455e3d7a09a665ce554f00ac89d2e99a1a83d267170c6434d494eff1a1c85fb301a0016dc041b0000002622de5236181e181ed8799f190682ffd87980ffa300583911ea07b733d932129c378af627436e7cbc2ef0bf96e0036bb51b3bde6b52563c5410bff6a0d43ccebb7c37e1f69f5eb260552521adff33b9c201821b00000499e981ba17a2581c29d222ce763455e3d7a09a665ce554f00ac89d2e99a1a83d267170c6a1434d494e1b0000b78ed6e8a8d6581cf5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4ca2434d535001582082e2b1fd27a7712a1a9cf750dfbea1a5778611b20e06dd6a611df7a643f8cb751b7fffe39a0d6a66b0028201d818587fd8799fd8799fd87a9f581c1eae96baf29e27682ea3f815aba361a0c6059d45e4bfbe95bbd2f44affffd8799f4040ffd8799f581c29d222ce763455e3d7a09a665ce554f00ac89d2e99a1a83d267170c6434d494eff1b00001c65f29599591b00000499e80beac71b0000b78eb41e2b0e181e1864d8799f190d05ffd87980ff825839015b7e23228dba75595645fc357d0f97ba258cfccfff5d588d4bb9165b533b9586f0fb9aafd578e0d0154e9478d23614e736eb39d1a30d8a991a092cbd6f021a000d3111031a0a718c0d05a1581df11eae96baf29e27682ea3f815aba361a0c6059d45e4bfbe95bbd2f44a000758205160f88b929bf8a6c57c285b889488f9137c0ef3cfd0bcf408a10020e69146d5081a0a718b590b582016269035b337cea69355e93f5d0e575534633a06342f322333a72fec2eb077cd0dd901028182582029739eaccdcd5d6d3a194cbd17ab09e2f6a4946a3114278af1367293b216755c020ed9010281581c5b7e23228dba75595645fc357d0f97ba258cfccfff5d588d4bb9165b10825839015b7e23228dba75595645fc357d0f97ba258cfccfff5d588d4bb9165b533b9586f0fb9aafd578e0d0154e9478d23614e736eb39d1a30d8a991a08dfe7a0111a004c4b4012d90102848258200dc17712e37a4e741767db2f90d4ffbf69faf88b9bed4c47864f7bd912924bea00825820d46bd227bd2cf93dedd22ae9b6d92d30140cf0d68b756f6608e38d680c61ad17008258202536194d2a976370a932174c10975493ab58fd7c16395d50e62b7c0e1949baea00825820cf4ecddde0d81f9ce8fcc881a85eb1f8ccdaf6807f03fea4cd02da896a62177600a200d9010281825820c5d63d7dc066df52592135b6d3cb4f3470d06f7bdd4b2d2e32eb59ca3782662f58409b027891bae08ccd79a4e025df5091d298410a644316d11041f1747a74a7831b0fd26e001dfebfdf760ca0c65856e69361e567f99d14ae9fbf32c8a80b3f30080585840004d87980821962d91a007cc793840001d87980821a00012dfc1a0166fa60840002d87980821a00012dfc1a0166fa60840003d87980821a00012dfc1a0166fa60840300d8799f009f1a000dbba0ff4100d8799f43000102ff9fd87a80d87a80d87a80ffff821a002fee8d1a3cc40515f5a11902a2a1636d736781774d696e737761703a204f72646572204578656375746564'
        },
        {
            id: '82eaac99b641f204ffeaf1c900511c7ae94f8ee0f5774d477b0f430f97267abf',
            spends: 'inputs',
            inputs: [
                {
                    transaction: {
                        id: '6fadece8f6e87c188fde89b583f2967c6c07ba39dc7133a5626e99a967a9fe7a'
                    },
                    index: 0
                }
            ],
            outputs: [
                {
                    address: 'addr1qyqm7tmr6pv525xrjczsa8vt5z2g83d7l7aq50ej8lshksu3aykeypx2a7a7hfm2xzetnhdlxurx22a5h0fjxp6g94kse34ndu',
                    value: {
                        ada: {
                            lovelace: 3230000
                        },
                        ecac528a850db0d7a0ca6b3452e640bc65236b32b55591478b8984fd: {
                            '4d69646e6967687453746174696f6e35393735': 1
                        }
                    }
                },
                {
                    address: 'addr1qytcgpelg4m8n0hrgkx8nhr6servtt4qhmntxufdga32lzhuynvp2sdsx64g8dy3fd4pd7hs9lyn0j5vhwuzthz8xkessrfdse',
                    value: {
                        ada: {
                            lovelace: 4696740
                        }
                    }
                },
                {
                    address: 'addr1qxewxq5d4atsz988aedcm0j0ewhckznte838468nggaymg0y0zrtezn30w606w7jxammh8xg7m26j6t0wdvh93cmjs0qmfjy4m',
                    value: {
                        ada: {
                            lovelace: 10959111
                        }
                    }
                }
            ],
            mint: {
                ecac528a850db0d7a0ca6b3452e640bc65236b32b55591478b8984fd: {
                    '4d69646e6967687453746174696f6e35393735': 1
                }
            },
            fee: {
                ada: {
                    lovelace: 274149
                }
            },
            validityInterval: {
                invalidAfter: 175219399
            },
            treasury: {},
            metadata: {
                hash: '0c69c044070fe6481c6cc9d224ada606f1c6b7079a3df135a371a11bdd7ba9e4',
                labels: {
                    '721': {
                        json: {
                            ecac528a850db0d7a0ca6b3452e640bc65236b32b55591478b8984fd: {
                                MidnightStation5975: {
                                    id: '5975',
                                    name: 'Midnight Station #5975',
                                    files: [
                                        {
                                            src: 'ipfs://QmWpgLJbSANgLWR976p4g5RxXDHomEa6AgUTT3iiV11mn5',
                                            name: 'High-Res Cover Image',
                                            mediaType: 'image/png'
                                        }
                                    ],
                                    image: 'ipfs://QmTckwX72BdLcTszvQ6RNnacedcsrkPpmr29U8oxaciA1K',
                                    sha256: '44e0b6cd4457bbd30266746462ae69074ce1ca9d15fef61c6411ba25cd4a2108',
                                    authors: [],
                                    deaType: 'music',
                                    website: 'https://stuff.io',
                                    mediaType: 'image/jpeg',
                                    attributes: {
                                        Variation: '0',
                                        'Cover Theme': 'Midnight Station'
                                    },
                                    entrypoint: 'ipfs://QmZYrzzvVn45zTfXEFwpRPdUzG385KVKun238pE7NZ6P5u',
                                    description: ['The NFT song Midnight Station represents a moment of arrival aft', 'er a long and demanding journey.'],
                                    dataMediaType: 'application/lpf+zip',
                                    extraAttributes: {
                                        Artists: ['SongMarketCap.com'],
                                        'Album Title': 'Midnight Station'
                                    }
                                }
                            }
                        }
                    }
                }
            },
            signatories: [
                {
                    key: '2b9bc42a81f81936c343a87ec5945cd92ed6bb66dacd17b9febb2d80d15fe7f6',
                    signature: '4e53e14b474642b274089a2ce6310ebd6caf9d18c98feb5ccfb4b7445d7ebb9349b65bb7090a255d84580f0ddf28670bdb94614c912ee11ce0419364a227090b'
                },
                {
                    key: '89d0f347afe53af4c709371bc4edb207f8a2f1ef86630e50850692c63f68fb42',
                    signature: '91c401bb2d94d9b4be8a60377fba384d209661422575913b48dec08975e29eaa81617ca28b1d381ec8d05a2f2664f74ace66c50c3b41e59207ae77dc91951705'
                }
            ],
            scripts: {
                ecac528a850db0d7a0ca6b3452e640bc65236b32b55591478b8984fd: {
                    language: 'native',
                    json: {
                        clause: 'all',
                        from: [
                            {
                                clause: 'signature',
                                from: '2d05aec94b3fdeb5784afbc6c06fb7e95bfdd75b5bd21fddea995631'
                            },
                            {
                                clause: 'before',
                                slot: 237780954
                            }
                        ]
                    }
                }
            },
            cbor: '84a600d90102818258206fadece8f6e87c188fde89b583f2967c6c07ba39dc7133a5626e99a967a9fe7a0001838258390101bf2f63d0594550c396050e9d8ba09483c5beffba0a3f323fe17b4391e92d9204caefbbeba76a30b2b9ddbf3706652bb4bbd32307482d6d821a00314930a1581cecac528a850db0d7a0ca6b3452e640bc65236b32b55591478b8984fda1534d69646e6967687453746174696f6e3539373501825839011784073f457679bee3458c79dc7a8646c5aea0bee6b3712d4762af8afc24d81541b036aa83b4914b6a16faf02fc937ca8cbbb825dc4735b31a0047aaa482583901b2e3028daf570114e7ee5b8dbe4fcbaf8b0a6bc9e27ae8f3423a4da1e47886bc8a717bb4fd3bd23777bb9cc8f6d5a9696f735972c71b941e1a00a73907021a00042ee5031a0a71a2c709a1581cecac528a850db0d7a0ca6b3452e640bc65236b32b55591478b8984fda1534d69646e6967687453746174696f6e35393735010758200c69c044070fe6481c6cc9d224ada606f1c6b7079a3df135a371a11bdd7ba9e4a200d90102828258202b9bc42a81f81936c343a87ec5945cd92ed6bb66dacd17b9febb2d80d15fe7f658404e53e14b474642b274089a2ce6310ebd6caf9d18c98feb5ccfb4b7445d7ebb9349b65bb7090a255d84580f0ddf28670bdb94614c912ee11ce0419364a227090b82582089d0f347afe53af4c709371bc4edb207f8a2f1ef86630e50850692c63f68fb42584091c401bb2d94d9b4be8a60377fba384d209661422575913b48dec08975e29eaa81617ca28b1d381ec8d05a2f2664f74ace66c50c3b41e59207ae77dc9195170501d90102818201828200581c2d05aec94b3fdeb5784afbc6c06fb7e95bfdd75b5bd21fddea99563182051a0e2c3fdaf5d90103a100a11902d1a178386563616335323861383530646230643761306361366233343532653634306263363532333662333262353535393134373862383938346664a1734d69646e6967687453746174696f6e35393735ae6269646435393735646e616d65764d69646e696768742053746174696f6e2023353937356566696c657381a3637372637835697066733a2f2f516d5770674c4a6253414e674c57523937367034673552785844486f6d45613641675554543369695631316d6e35646e616d6574486967682d52657320436f76657220496d616765696d656469615479706569696d6167652f706e6765696d6167657835697066733a2f2f516d54636b7758373242644c6354737a765136524e6e616365646373726b50706d72323955386f7861636941314b6673686132353678403434653062366364343435376262643330323636373436343632616536393037346365316361396431356665663631633634313162613235636434613231303867617574686f7273806764656154797065656d7573696367776562736974657068747470733a2f2f73747566662e696f696d65646961547970656a696d6167652f6a7065676a61747472696275746573a269566172696174696f6e61306b436f766572205468656d65704d69646e696768742053746174696f6e6a656e747279706f696e747835697066733a2f2f516d5a59727a7a76566e34357a54665845467770525064557a473338354b564b756e3233387045374e5a365035756b6465736372697074696f6e827840546865204e465420736f6e67204d69646e696768742053746174696f6e20726570726573656e74732061206d6f6d656e74206f66206172726976616c20616674782065722061206c6f6e6720616e642064656d616e64696e67206a6f75726e65792e6d646174614d6564696154797065736170706c69636174696f6e2f6c70662b7a69706f657874726141747472696275746573a267417274697374738171536f6e674d61726b65744361702e636f6d6b416c62756d205469746c65704d69646e696768742053746174696f6e'
        },
        {
            id: '4bfda1c2ff21509e85ebc1e05b8cfedd5de669dd57d6067ea0edce1380e656bc',
            spends: 'inputs',
            inputs: [
                {
                    transaction: {
                        id: '685efdae6127e5f9a9fdf4dd15a3fda7beaaf56c8c88b3308d7eb5d670c2f158'
                    },
                    index: 1
                },
                {
                    transaction: {
                        id: 'fd8823287f00e9ef167af1e11a25e18fadb01a853c745e8d9512be88c436d4b7'
                    },
                    index: 43
                }
            ],
            outputs: [
                {
                    address: 'addr1w9f6fven7fuvlufqfye95w750v3k622pzg5j46rsj2uxrcqamm6fe',
                    value: {
                        ada: {
                            lovelace: 3900000
                        },
                        '25c5de5f5b286073c593edfd77b48abc7a48e5a4f3d4cd9d428ff935': {
                            '44454741': 35216494462630
                        }
                    },
                    datumHash: 'bdadcca4243cf0af637d5f5f09721070a131ce6bd9413c2afbf230a2fff91cae'
                },
                {
                    address: 'addr1q85l97rmhcjhrdhpr07hyws9w47kglmrjastr32cvka08nrhmzkc76h6lg9uh42nsnulppxztq7w4y2fatj5wcy7k8fqrdt6rj',
                    value: {
                        ada: {
                            lovelace: 2413467
                        }
                    }
                }
            ],
            requiredExtraSignatories: ['e9f2f87bbe2571b6e11bfd723a05757d647f639760b1c55865baf3cc'],
            scriptIntegrityHash: '129011128cf6e1ca516194e01b12476cb13c899eb8c66c4ccd6732a010af3726',
            fee: {
                ada: {
                    lovelace: 186533
                }
            },
            validityInterval: {
                invalidBefore: 175213333,
                invalidAfter: 175224133
            },
            treasury: {},
            metadata: {
                hash: '5eba0dad88984b766df16c6e955e1a22646a5974e8313f317a6ec275bceeacbf',
                labels: {
                    '674': {
                        json: {
                            msg: 'VyFi: LP Swap B for A Order Request'
                        }
                    }
                }
            },
            signatories: [
                {
                    key: 'd29e0f36a80ed60cf3d5102153832428a0f014259bf56b8ac6169f67e023d9b7',
                    signature: 'fdb1142e9ed4ff12f82304cc31d74eca69adad8b18dc1968cb44b522b64b84179a453bd34609bdc1383e5c41786ff293b5143b8f1b34c94481887fcb7cb2930f'
                },
                {
                    key: 'b3c238a68059b0e2d06cd405e36ede7858153b1ae335dae3e6d6ee953e3bedda',
                    signature: '18846479b7b24ece5e114465c06a36c49e26c770b0e3197b0c18a808436910cd9d91448074f7ec05b8b7321f00cefd3ed3ef53d23390ddf765c94d14ec958e03'
                }
            ],
            datums: {
                bdadcca4243cf0af637d5f5f09721070a131ce6bd9413c2afbf230a2fff91cae: 'd8799f5838e9f2f87bbe2571b6e11bfd723a05757d647f639760b1c55865baf3cc77d8ad8f6afafa0bcbd55384f9f084c2583cea9149eae547609eb1d2d87d9f1a006623abffff'
            },
            cbor: '84a80082825820685efdae6127e5f9a9fdf4dd15a3fda7beaaf56c8c88b3308d7eb5d670c2f15801825820fd8823287f00e9ef167af1e11a25e18fadb01a853c745e8d9512be88c436d4b7182b018283581d7153a4b333f278cff12049325a3bd47b236d294112292ae87092b861e0821a003b8260a1581c25c5de5f5b286073c593edfd77b48abc7a48e5a4f3d4cd9d428ff935a144444547411b000020077aa486a65820bdadcca4243cf0af637d5f5f09721070a131ce6bd9413c2afbf230a2fff91cae82583901e9f2f87bbe2571b6e11bfd723a05757d647f639760b1c55865baf3cc77d8ad8f6afafa0bcbd55384f9f084c2583cea9149eae547609eb1d21a0024d39b021a0002d8a5031a0a71b5450758205eba0dad88984b766df16c6e955e1a22646a5974e8313f317a6ec275bceeacbf081a0a718b150b5820129011128cf6e1ca516194e01b12476cb13c899eb8c66c4ccd6732a010af37260e81581ce9f2f87bbe2571b6e11bfd723a05757d647f639760b1c55865baf3cca20082825820d29e0f36a80ed60cf3d5102153832428a0f014259bf56b8ac6169f67e023d9b75840fdb1142e9ed4ff12f82304cc31d74eca69adad8b18dc1968cb44b522b64b84179a453bd34609bdc1383e5c41786ff293b5143b8f1b34c94481887fcb7cb2930f825820b3c238a68059b0e2d06cd405e36ede7858153b1ae335dae3e6d6ee953e3bedda584018846479b7b24ece5e114465c06a36c49e26c770b0e3197b0c18a808436910cd9d91448074f7ec05b8b7321f00cefd3ed3ef53d23390ddf765c94d14ec958e03049fd8799f5838e9f2f87bbe2571b6e11bfd723a05757d647f639760b1c55865baf3cc77d8ad8f6afafa0bcbd55384f9f084c2583cea9149eae547609eb1d2d87d9f1a006623abfffffff5a11902a2a1636d73677823567946693a204c502053776170204220666f722041204f726465722052657175657374'
        },
        {
            id: '0df9aea8301c650dcc12d4f4a12a13ecbc91ba74cbe304558ceb16b735e6e872',
            spends: 'inputs',
            inputs: [
                {
                    transaction: {
                        id: '344c63502897fff7176b342b2da6ccdb36cb877fa4763614d1d6b0d661af2189'
                    },
                    index: 0
                },
                {
                    transaction: {
                        id: '883cc1fb4b71315ef0e1045fc492d79943c0e5e604cc09e605886e0f2b295e18'
                    },
                    index: 1
                }
            ],
            outputs: [
                {
                    address: 'addr1z8p79rpkcdz8x9d6tft0x0dx5mwuzac2sa4gm8cvkw5hcnqnv43nv7j7apc4ta3qlm5clrd4838a7mga6nr2k4futhtq6u49cz',
                    value: {
                        ada: {
                            lovelace: 2715300
                        },
                        '75f91f2db50f1c492cb936dbb962aaf89463e3a01e86954611bb1a21': {
                            '0014df104e495445': 9286928289217
                        }
                    },
                    datum: 'd8799fd8799f581c59c0b68fd02af8a9412b90a20f23996d916fc22b7e10a3d69c99b558ffd8799fd8799f581c59c0b68fd02af8a9412b90a20f23996d916fc22b7e10a3d69c99b558ffd8799fd8799fd8799f581c136563367a5ee87155f620fee98f8db53c4fdf6d1dd4c6ab553c5dd6ffffffffd87980d8799fd8799f581c59c0b68fd02af8a9412b90a20f23996d916fc22b7e10a3d69c99b558ffd8799fd8799fd8799f581c136563367a5ee87155f620fee98f8db53c4fdf6d1dd4c6ab553c5dd6ffffffffd87980d8799f581cf5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c5820659b5ac488e5dfbca775b77852e03ac77fe39bef6929cd5baf820ba0dee80922ffd8799fd87980d8799f1b00000872480fcdc1ff01d87980ff1a000aae60d87a80ff'
                },
                {
                    address: 'addr1q8l7hny7x96fadvq8cukyqkcfca5xmkrvfrrkt7hp76v3qvssm7fz9ajmtd58ksljgkyvqu6gl23hlcfgv7um5v0rn8qtnzlfk',
                    value: {
                        ada: {
                            lovelace: 1750000
                        }
                    }
                },
                {
                    address: 'addr1q9vupd506q40322p9wg2yrern9kezm7z9dlppg7knjvm2kqnv43nv7j7apc4ta3qlm5clrd4838a7mga6nr2k4futhtqus90hz',
                    value: {
                        ada: {
                            lovelace: 2000000
                        }
                    }
                },
                {
                    address: 'addr1q9vupd506q40322p9wg2yrern9kezm7z9dlppg7knjvm2kqnv43nv7j7apc4ta3qlm5clrd4838a7mga6nr2k4futhtqus90hz',
                    value: {
                        ada: {
                            lovelace: 503866614
                        }
                    }
                }
            ],
            requiredExtraSignatories: ['136563367a5ee87155f620fee98f8db53c4fdf6d1dd4c6ab553c5dd6', '59c0b68fd02af8a9412b90a20f23996d916fc22b7e10a3d69c99b558'],
            fee: {
                ada: {
                    lovelace: 283509
                }
            },
            validityInterval: {
                invalidBefore: 175213109,
                invalidAfter: 175216709
            },
            treasury: {},
            metadata: {
                hash: 'fb410d9c1f095c4e9b919a8651cb352def9eb09af0f758dfdeca84ef95062786',
                labels: {
                    '674': {
                        json: {
                            msg: ['Dexhunter Trade', 'Partner DHMOBILE']
                        }
                    }
                }
            },
            signatories: [
                {
                    key: 'd03e6e6f31a22543233b0e07e57145a167a55fcf2f572858d9c55105dc00e071',
                    signature: '1cf571464f4c0f8d0cd5a90b17829d9fbcc8c8bee134d23f69413632194dcb87d30f57f45e0beb8828735418ba4655044624ffd511d3a1707bebb5718f3f1a05'
                },
                {
                    key: 'd2df83bd980b2ad6e241919dc3445b4a11a129d026fb700ce0b5ca8e6dacb7d0',
                    signature: 'd6ae5fa4439757cd72662ff4c62bc92cdc3ee8badcd52491192e1a1237160caf06824a7a142a5150a73779a53022b424f2a77cac09b42d4b9135ce743a53960e'
                }
            ],
            cbor: '84a70082825820344c63502897fff7176b342b2da6ccdb36cb877fa4763614d1d6b0d661af218900825820883cc1fb4b71315ef0e1045fc492d79943c0e5e604cc09e605886e0f2b295e18010184a300583911c3e28c36c3447315ba5a56f33da6a6ddc1770a876a8d9f0cb3a97c4c136563367a5ee87155f620fee98f8db53c4fdf6d1dd4c6ab553c5dd601821a00296ea4a1581c75f91f2db50f1c492cb936dbb962aaf89463e3a01e86954611bb1a21a1480014df104e4954451b00000872480fcdc1028201d818590130d8799fd8799f581c59c0b68fd02af8a9412b90a20f23996d916fc22b7e10a3d69c99b558ffd8799fd8799f581c59c0b68fd02af8a9412b90a20f23996d916fc22b7e10a3d69c99b558ffd8799fd8799fd8799f581c136563367a5ee87155f620fee98f8db53c4fdf6d1dd4c6ab553c5dd6ffffffffd87980d8799fd8799f581c59c0b68fd02af8a9412b90a20f23996d916fc22b7e10a3d69c99b558ffd8799fd8799fd8799f581c136563367a5ee87155f620fee98f8db53c4fdf6d1dd4c6ab553c5dd6ffffffffd87980d8799f581cf5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c5820659b5ac488e5dfbca775b77852e03ac77fe39bef6929cd5baf820ba0dee80922ffd8799fd87980d8799f1b00000872480fcdc1ff01d87980ff1a000aae60d87a80ff82583901ffebcc9e31749eb5803e396202d84e3b436ec362463b2fd70fb4c8819086fc9117b2dadb43da1f922c46039a47d51bff09433dcdd18f1cce1a001ab3f08258390159c0b68fd02af8a9412b90a20f23996d916fc22b7e10a3d69c99b558136563367a5ee87155f620fee98f8db53c4fdf6d1dd4c6ab553c5dd61a001e84808258390159c0b68fd02af8a9412b90a20f23996d916fc22b7e10a3d69c99b558136563367a5ee87155f620fee98f8db53c4fdf6d1dd4c6ab553c5dd61a1e0864f6021a00045375031a0a719845075820fb410d9c1f095c4e9b919a8651cb352def9eb09af0f758dfdeca84ef95062786081a0a718a350e82581c59c0b68fd02af8a9412b90a20f23996d916fc22b7e10a3d69c99b558581c136563367a5ee87155f620fee98f8db53c4fdf6d1dd4c6ab553c5dd6a10082825820d2df83bd980b2ad6e241919dc3445b4a11a129d026fb700ce0b5ca8e6dacb7d05840d6ae5fa4439757cd72662ff4c62bc92cdc3ee8badcd52491192e1a1237160caf06824a7a142a5150a73779a53022b424f2a77cac09b42d4b9135ce743a53960e825820d03e6e6f31a22543233b0e07e57145a167a55fcf2f572858d9c55105dc00e07158401cf571464f4c0f8d0cd5a90b17829d9fbcc8c8bee134d23f69413632194dcb87d30f57f45e0beb8828735418ba4655044624ffd511d3a1707bebb5718f3f1a05f5a11902a2a1636d7367826f44657868756e74657220547261646570506172746e65722044484d4f42494c45'
        },
        {
            id: '5ae51f004fb7798aec1ad476af14c6c15296a3f1662f74789788f560ee6ff269',
            spends: 'inputs',
            inputs: [
                {
                    transaction: {
                        id: '6a39ba0be67053a289e4f7799e3eeb57d946e6ebe9e0a2dbf68d8706e4f9b8f5'
                    },
                    index: 0
                },
                {
                    transaction: {
                        id: '6a39ba0be67053a289e4f7799e3eeb57d946e6ebe9e0a2dbf68d8706e4f9b8f5'
                    },
                    index: 1
                }
            ],
            outputs: [
                {
                    address: 'addr1z8p79rpkcdz8x9d6tft0x0dx5mwuzac2sa4gm8cvkw5hcnp7ywzej8elagtyjt43v2x3ewkmm8mgrz8dpr2snefk0lts6r479u',
                    value: {
                        ada: {
                            lovelace: 2700000
                        },
                        e992ef75f2367e6ecd93716ae88eba0d005dd91fd3a21f650b6496b5: {
                            '5355524745': 5000000000
                        }
                    },
                    datum: 'd8799fd8799f581c25784ea3d7da91ced96e21c74bd047052c6e215f4959d530b3ab9ac2ffd8799fd8799f581c25784ea3d7da91ced96e21c74bd047052c6e215f4959d530b3ab9ac2ffd8799fd8799fd8799f581c3e2385991f3fea16492eb1628d1cbadbd9f68188ed08d509e5367fd7ffffffffd87980d8799fd8799f581c25784ea3d7da91ced96e21c74bd047052c6e215f4959d530b3ab9ac2ffd8799fd8799fd8799f581c3e2385991f3fea16492eb1628d1cbadbd9f68188ed08d509e5367fd7ffffffffd87980d8799f581cf5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c5820ab2bc7cba8f1e4edbfbb83b630082ba6d711b7059dad402baa636d0e355732d5ffd8799fd87980d8799f1b000000012a05f200ff1a33a89062d87980ff1a000aae60d87a80ff'
                },
                {
                    address: 'addr1qyjhsn4r6ldfrnkedcsuwj7sguzjcm3ptay4n4fskw4e4s37ywzej8elagtyjt43v2x3ewkmm8mgrz8dpr2snefk0lts4kwn8p',
                    value: {
                        ada: {
                            lovelace: 101000949
                        }
                    }
                }
            ],
            fee: {
                ada: {
                    lovelace: 189041
                }
            },
            validityInterval: {
                invalidAfter: 175224207
            },
            treasury: {},
            metadata: {
                hash: '1feb00f18fbe772cc375aa495da0b08d837a719671e68da62f8ed658915d8fd1',
                labels: {
                    '674': {
                        json: {
                            msg: ['Minswap: Market Order']
                        }
                    }
                }
            },
            signatories: [
                {
                    key: '43d96648ef8f3fe504194a2895e7ff451d3991d11ea6648cfc2774d92f874903',
                    signature: '7d8545dc66aaad01b94416401d110454ed56e1fc16ed8c841da7f08df17ab29567f28dadb9936a2d0f60b88337ce814b23b2be6152581c372b10a5908c058801'
                }
            ],
            cbor: '84a500d90102828258206a39ba0be67053a289e4f7799e3eeb57d946e6ebe9e0a2dbf68d8706e4f9b8f5008258206a39ba0be67053a289e4f7799e3eeb57d946e6ebe9e0a2dbf68d8706e4f9b8f5010182a300583911c3e28c36c3447315ba5a56f33da6a6ddc1770a876a8d9f0cb3a97c4c3e2385991f3fea16492eb1628d1cbadbd9f68188ed08d509e5367fd701821a002932e0a1581ce992ef75f2367e6ecd93716ae88eba0d005dd91fd3a21f650b6496b5a14553555247451b000000012a05f200028201d818590134d8799fd8799f581c25784ea3d7da91ced96e21c74bd047052c6e215f4959d530b3ab9ac2ffd8799fd8799f581c25784ea3d7da91ced96e21c74bd047052c6e215f4959d530b3ab9ac2ffd8799fd8799fd8799f581c3e2385991f3fea16492eb1628d1cbadbd9f68188ed08d509e5367fd7ffffffffd87980d8799fd8799f581c25784ea3d7da91ced96e21c74bd047052c6e215f4959d530b3ab9ac2ffd8799fd8799fd8799f581c3e2385991f3fea16492eb1628d1cbadbd9f68188ed08d509e5367fd7ffffffffd87980d8799f581cf5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c5820ab2bc7cba8f1e4edbfbb83b630082ba6d711b7059dad402baa636d0e355732d5ffd8799fd87980d8799f1b000000012a05f200ff1a33a89062d87980ff1a000aae60d87a80ff8258390125784ea3d7da91ced96e21c74bd047052c6e215f4959d530b3ab9ac23e2385991f3fea16492eb1628d1cbadbd9f68188ed08d509e5367fd71a060526f5021a0002e271031a0a71b58f0758201feb00f18fbe772cc375aa495da0b08d837a719671e68da62f8ed658915d8fd1a100d901028182582043d96648ef8f3fe504194a2895e7ff451d3991d11ea6648cfc2774d92f87490358407d8545dc66aaad01b94416401d110454ed56e1fc16ed8c841da7f08df17ab29567f28dadb9936a2d0f60b88337ce814b23b2be6152581c372b10a5908c058801f5a11902a2a1636d736781754d696e737761703a204d61726b6574204f72646572'
        },
        {
            id: '60cc6c7bfa07ed407362d110a21f253cea4a51c3ad324886b72fd263762fe72d',
            spends: 'inputs',
            inputs: [
                {
                    transaction: {
                        id: '66a0e2c5e66918560f435fc60fd336388c7454736b4c87802cf80db04b14e58b'
                    },
                    index: 1
                },
                {
                    transaction: {
                        id: '66a0e2c5e66918560f435fc60fd336388c7454736b4c87802cf80db04b14e58b'
                    },
                    index: 2
                },
                {
                    transaction: {
                        id: 'd40b44ff7a51b07a67191b0bc3773a1f3595445c3cb07adc6183895da130f126'
                    },
                    index: 3
                }
            ],
            outputs: [
                {
                    address: 'addr1w8p79rpkcdz8x9d6tft0x0dx5mwuzac2sa4gm8cvkw5hcnqst2ctf',
                    value: {
                        ada: {
                            lovelace: 2700000
                        },
                        '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa': {
                            '4e49474854': 13233808010
                        }
                    },
                    datum: 'd8799fd8799f581c636d0d0118a8933ac167d4c448150bb325deaf7a4fdfb44adc7f2f5affd8799fd8799f581c636d0d0118a8933ac167d4c448150bb325deaf7a4fdfb44adc7f2f5affd8799fd8799fd8799f581ce39b5f40aa85fbc121a625d777a776eca1cb4c923426949c997d8828ffffffffd87980d8799fd8799f581c636d0d0118a8933ac167d4c448150bb325deaf7a4fdfb44adc7f2f5affd8799fd8799fd8799f581ce39b5f40aa85fbc121a625d777a776eca1cb4c923426949c997d8828ffffffffd87980d8799f581cf5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c5820e74c52975908a612d5ce68327040d449aae99f8b463bb6de046a1b23c5713169ffd8799fd87980d8799f1b0000000314cbe28aff1ab45d8423d87980ff1a000aae60d87a80ff'
                },
                {
                    address: 'addr1q93k6rgprz5fxwkpvl2vgjq4pwejth400f8aldz2m3lj7khrnd05p259l0qjrf396am6wahv5895ey35y62fexta3q5q3cc3k8',
                    value: {
                        ada: {
                            lovelace: 2000000
                        },
                        '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa': {
                            '4e49474854': 25694152638
                        }
                    }
                },
                {
                    address: 'addr1q93k6rgprz5fxwkpvl2vgjq4pwejth400f8aldz2m3lj7khrnd05p259l0qjrf396am6wahv5895ey35y62fexta3q5q3cc3k8',
                    value: {
                        ada: {
                            lovelace: 12216449430
                        }
                    }
                }
            ],
            fee: {
                ada: {
                    lovelace: 191769
                }
            },
            validityInterval: {
                invalidAfter: 175214603
            },
            treasury: {},
            signatories: [
                {
                    key: '62e8297eae4d6a606981e93afec220dda426b38d38c3f504efe7ea44288a6194',
                    signature: '0935b12e662d4d24baf59bc6fff891ec70a7b6a443675d8180cf4081df7196c58142e1f053551d7293d744fe3fe2a59f3365ac737e4e79b1785bd8feac29b20e'
                }
            ],
            cbor: '84a400d901028382582066a0e2c5e66918560f435fc60fd336388c7454736b4c87802cf80db04b14e58b0182582066a0e2c5e66918560f435fc60fd336388c7454736b4c87802cf80db04b14e58b02825820d40b44ff7a51b07a67191b0bc3773a1f3595445c3cb07adc6183895da130f126030183a300581d71c3e28c36c3447315ba5a56f33da6a6ddc1770a876a8d9f0cb3a97c4c01821a002932e0a1581c0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1faa1454e494748541b0000000314cbe28a028201d818590134d8799fd8799f581c636d0d0118a8933ac167d4c448150bb325deaf7a4fdfb44adc7f2f5affd8799fd8799f581c636d0d0118a8933ac167d4c448150bb325deaf7a4fdfb44adc7f2f5affd8799fd8799fd8799f581ce39b5f40aa85fbc121a625d777a776eca1cb4c923426949c997d8828ffffffffd87980d8799fd8799f581c636d0d0118a8933ac167d4c448150bb325deaf7a4fdfb44adc7f2f5affd8799fd8799fd8799f581ce39b5f40aa85fbc121a625d777a776eca1cb4c923426949c997d8828ffffffffd87980d8799f581cf5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c5820e74c52975908a612d5ce68327040d449aae99f8b463bb6de046a1b23c5713169ffd8799fd87980d8799f1b0000000314cbe28aff1ab45d8423d87980ff1a000aae60d87a80ff82583901636d0d0118a8933ac167d4c448150bb325deaf7a4fdfb44adc7f2f5ae39b5f40aa85fbc121a625d777a776eca1cb4c923426949c997d8828821a001e8480a1581c0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1faa1454e494748541b00000005fb7da7be82583901636d0d0118a8933ac167d4c448150bb325deaf7a4fdfb44adc7f2f5ae39b5f40aa85fbc121a625d777a776eca1cb4c923426949c997d88281b00000002d8283996021a0002ed19031a0a71900ba100d901028182582062e8297eae4d6a606981e93afec220dda426b38d38c3f504efe7ea44288a619458400935b12e662d4d24baf59bc6fff891ec70a7b6a443675d8180cf4081df7196c58142e1f053551d7293d744fe3fe2a59f3365ac737e4e79b1785bd8feac29b20ef5f6'
        },
        {
            id: 'cfd3d651bc517ea9cc580e5539c5924e95898c630a5ec30033c76239a44c4672',
            spends: 'inputs',
            inputs: [
                {
                    transaction: {
                        id: '9c45faffe3d4af176eb0431e80bd1b0b0f1c2dc2a9393f4db60b99ee8d3785c9'
                    },
                    index: 0
                },
                {
                    transaction: {
                        id: '9c45faffe3d4af176eb0431e80bd1b0b0f1c2dc2a9393f4db60b99ee8d3785c9'
                    },
                    index: 1
                },
                {
                    transaction: {
                        id: '9c45faffe3d4af176eb0431e80bd1b0b0f1c2dc2a9393f4db60b99ee8d3785c9'
                    },
                    index: 2
                }
            ],
            outputs: [
                {
                    address: 'addr1q8hyl84qscjqlja095vvuhcfzhf9wr5vjxc5jk2dwrrxgslwf702pp3ypl967tgcee0sj9wj2u8geyd3f9v56uxxv3psxk5h9e',
                    value: {
                        ada: {
                            lovelace: 1000000
                        }
                    }
                },
                {
                    address: 'addr1q8hyl84qscjqlja095vvuhcfzhf9wr5vjxc5jk2dwrrxgslwf702pp3ypl967tgcee0sj9wj2u8geyd3f9v56uxxv3psxk5h9e',
                    value: {
                        ada: {
                            lovelace: 5973706978
                        }
                    }
                },
                {
                    address: 'addr1q8hyl84qscjqlja095vvuhcfzhf9wr5vjxc5jk2dwrrxgslwf702pp3ypl967tgcee0sj9wj2u8geyd3f9v56uxxv3psxk5h9e',
                    value: {
                        ada: {
                            lovelace: 1224040
                        },
                        dc2ac9b105bbfa44ceb9804b7e008e4e760bc6a9370305cabee01a69: {
                            '724553544b': 1
                        }
                    }
                }
            ],
            withdrawals: {
                stake1u8hyl84qscjqlja095vvuhcfzhf9wr5vjxc5jk2dwrrxgsc2f2cn4: {
                    ada: {
                        lovelace: 12459103
                    }
                }
            },
            fee: {
                ada: {
                    lovelace: 202360
                }
            },
            validityInterval: {
                invalidAfter: 1000000000
            },
            treasury: {},
            signatories: [
                {
                    key: '6deded95728804a6ea36a2fe2a31c1ae07c678e315ec335e62861f2a795a74f6',
                    signature: '529f624cac1e419199ea4905c353601bfb89ddd0a5ecab8e5dc3793fbc61dff716e54c573693cc30fe989cd7a4b72e1e04d9f955168512afa89b99c898aa4401'
                }
            ],
            cbor: '84a500d90102838258209c45faffe3d4af176eb0431e80bd1b0b0f1c2dc2a9393f4db60b99ee8d3785c9008258209c45faffe3d4af176eb0431e80bd1b0b0f1c2dc2a9393f4db60b99ee8d3785c9018258209c45faffe3d4af176eb0431e80bd1b0b0f1c2dc2a9393f4db60b99ee8d3785c902018382583901ee4f9ea086240fcbaf2d18ce5f0915d2570e8c91b149594d70c66443ee4f9ea086240fcbaf2d18ce5f0915d2570e8c91b149594d70c664431a000f424082583901ee4f9ea086240fcbaf2d18ce5f0915d2570e8c91b149594d70c66443ee4f9ea086240fcbaf2d18ce5f0915d2570e8c91b149594d70c664431b00000001640f88e282583901ee4f9ea086240fcbaf2d18ce5f0915d2570e8c91b149594d70c66443ee4f9ea086240fcbaf2d18ce5f0915d2570e8c91b149594d70c66443821a0012ad68a1581cdc2ac9b105bbfa44ceb9804b7e008e4e760bc6a9370305cabee01a69a145724553544b01021a00031678031a3b9aca0005a1581de1ee4f9ea086240fcbaf2d18ce5f0915d2570e8c91b149594d70c664431a00be1c5fa100d90102848258206deded95728804a6ea36a2fe2a31c1ae07c678e315ec335e62861f2a795a74f65840529f624cac1e419199ea4905c353601bfb89ddd0a5ecab8e5dc3793fbc61dff716e54c573693cc30fe989cd7a4b72e1e04d9f955168512afa89b99c898aa44018258206deded95728804a6ea36a2fe2a31c1ae07c678e315ec335e62861f2a795a74f65840529f624cac1e419199ea4905c353601bfb89ddd0a5ecab8e5dc3793fbc61dff716e54c573693cc30fe989cd7a4b72e1e04d9f955168512afa89b99c898aa44018258206deded95728804a6ea36a2fe2a31c1ae07c678e315ec335e62861f2a795a74f65840529f624cac1e419199ea4905c353601bfb89ddd0a5ecab8e5dc3793fbc61dff716e54c573693cc30fe989cd7a4b72e1e04d9f955168512afa89b99c898aa44018258206deded95728804a6ea36a2fe2a31c1ae07c678e315ec335e62861f2a795a74f65840529f624cac1e419199ea4905c353601bfb89ddd0a5ecab8e5dc3793fbc61dff716e54c573693cc30fe989cd7a4b72e1e04d9f955168512afa89b99c898aa4401f5f6'
        },
        {
            id: 'e62735db2d0f67b3710106a424d13a7a33ebf15abe5cfb2de33f914a7023daba',
            spends: 'inputs',
            inputs: [
                {
                    transaction: {
                        id: '5ae51f004fb7798aec1ad476af14c6c15296a3f1662f74789788f560ee6ff269'
                    },
                    index: 0
                },
                {
                    transaction: {
                        id: '850ed4baf783d2c145f1f879f1f4181615ad9b341e0b5b98cdc5c9c5cc52a3e6'
                    },
                    index: 1
                },
                {
                    transaction: {
                        id: 'b274d52c0517f3603d09eae3daa82c579925932f04975d2542b2c3a3c2d9ff2e'
                    },
                    index: 4
                }
            ],
            references: [
                {
                    transaction: {
                        id: '0dc17712e37a4e741767db2f90d4ffbf69faf88b9bed4c47864f7bd912924bea'
                    },
                    index: 0
                },
                {
                    transaction: {
                        id: '2536194d2a976370a932174c10975493ab58fd7c16395d50e62b7c0e1949baea'
                    },
                    index: 0
                },
                {
                    transaction: {
                        id: 'cf4ecddde0d81f9ce8fcc881a85eb1f8ccdaf6807f03fea4cd02da896a621776'
                    },
                    index: 0
                },
                {
                    transaction: {
                        id: 'd46bd227bd2cf93dedd22ae9b6d92d30140cf0d68b756f6608e38d680c61ad17'
                    },
                    index: 0
                }
            ],
            outputs: [
                {
                    address: 'addr1qyjhsn4r6ldfrnkedcsuwj7sguzjcm3ptay4n4fskw4e4s37ywzej8elagtyjt43v2x3ewkmm8mgrz8dpr2snefk0lts4kwn8p',
                    value: {
                        ada: {
                            lovelace: 955353529
                        }
                    }
                },
                {
                    address: 'addr1z84q0denmyep98ph3tmzwsmw0j7zau9ljmsqx6a4rvaau66j2c79gy9l76sdg0xwhd7r0c0kna0tycz4y5s6mlenh8pq777e2a',
                    value: {
                        ada: {
                            lovelace: 560669787094
                        },
                        e992ef75f2367e6ecd93716ae88eba0d005dd91fd3a21f650b6496b5: {
                            '5355524745': 2944032493524
                        },
                        f5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4c: {
                            '4d5350': 1,
                            ab2bc7cba8f1e4edbfbb83b630082ba6d711b7059dad402baa636d0e355732d5: 9223370758807616423
                        }
                    },
                    datum: 'd8799fd8799fd87a9f581c1eae96baf29e27682ea3f815aba361a0c6059d45e4bfbe95bbd2f44affffd8799f4040ffd8799f581ce992ef75f2367e6ecd93716ae88eba0d005dd91fd3a21f650b6496b5455355524745ff1b00000129918c04621b00000082879affdf1b000002ad6754cf100505d8799f190682ffd87980ff'
                },
                {
                    address: 'addr1q9dhugez3ka82k2kgh7r2lg0j7aztr8uell46kydfwu3vk6n8w2cdu8mn2ha278q6q25a9rc6gmpfeekavuargcd32vsvxhl7e',
                    value: {
                        ada: {
                            lovelace: 104976101
                        }
                    }
                }
            ],
            collaterals: [
                {
                    transaction: {
                        id: 'b274d52c0517f3603d09eae3daa82c579925932f04975d2542b2c3a3c2d9ff2e'
                    },
                    index: 4
                }
            ],
            collateralReturn: {
                address: 'addr1q9dhugez3ka82k2kgh7r2lg0j7aztr8uell46kydfwu3vk6n8w2cdu8mn2ha278q6q25a9rc6gmpfeekavuargcd32vsvxhl7e',
                value: {
                    ada: {
                        lovelace: 99941784
                    }
                }
            },
            totalCollateral: {
                ada: {
                    lovelace: 5000000
                }
            },
            withdrawals: {
                stake17y02a946720zw6pw50upt2arvxsvvpvaghjtl054h0f0gjsfyjz59: {
                    ada: {
                        lovelace: 0
                    }
                }
            },
            requiredExtraSignatories: ['5b7e23228dba75595645fc357d0f97ba258cfccfff5d588d4bb9165b'],
            scriptIntegrityHash: '98aacaf7c0dae9b86b0d987a17cda8b10e7fd8f02b896aea0dda9bb23de65f84',
            fee: {
                ada: {
                    lovelace: 665683
                }
            },
            validityInterval: {
                invalidBefore: 175213401,
                invalidAfter: 175213581
            },
            treasury: {},
            metadata: {
                hash: '5160f88b929bf8a6c57c285b889488f9137c0ef3cfd0bcf408a10020e69146d5',
                labels: {
                    '674': {
                        json: {
                            msg: ['Minswap: Order Executed']
                        }
                    }
                }
            },
            signatories: [
                {
                    key: 'c5d63d7dc066df52592135b6d3cb4f3470d06f7bdd4b2d2e32eb59ca3782662f',
                    signature: 'e3aa1eee6afd9cf866f23fd5be4421de0cb881dfa90424c85f131805618de54db41edf671fd78cbd8667bb98894ccf6c2ccbc0c14cd3d0becca43b4dc8959603'
                }
            ],
            redeemers: [
                {
                    validator: {
                        index: 0,
                        purpose: 'spend'
                    },
                    redeemer: 'd87980',
                    executionUnits: {
                        memory: 25305,
                        cpu: 8177555
                    }
                },
                {
                    validator: {
                        index: 1,
                        purpose: 'spend'
                    },
                    redeemer: 'd87980',
                    executionUnits: {
                        memory: 77308,
                        cpu: 23525984
                    }
                },
                {
                    validator: {
                        index: 0,
                        purpose: 'withdraw'
                    },
                    redeemer: 'd8799f009f1a000aae60ff4100d87a809fd87a80ffff',
                    executionUnits: {
                        memory: 1336746,
                        cpu: 429968526
                    }
                }
            ],
            cbor: '84ad00d90102838258205ae51f004fb7798aec1ad476af14c6c15296a3f1662f74789788f560ee6ff26900825820850ed4baf783d2c145f1f879f1f4181615ad9b341e0b5b98cdc5c9c5cc52a3e601825820b274d52c0517f3603d09eae3daa82c579925932f04975d2542b2c3a3c2d9ff2e0401838258390125784ea3d7da91ced96e21c74bd047052c6e215f4959d530b3ab9ac23e2385991f3fea16492eb1628d1cbadbd9f68188ed08d509e5367fd71a38f189b9a300583911ea07b733d932129c378af627436e7cbc2ef0bf96e0036bb51b3bde6b52563c5410bff6a0d43ccebb7c37e1f69f5eb260552521adff33b9c201821b000000828a8603d6a2581ce992ef75f2367e6ecd93716ae88eba0d005dd91fd3a21f650b6496b5a14553555247451b000002ad7602cfd4581cf5808c2c990d86da54bfc97d89cee6efa20cd8461616359478d96b4ca2434d5350015820ab2bc7cba8f1e4edbfbb83b630082ba6d711b7059dad402baa636d0e355732d51b7ffffed66e73fba7028201d818587fd8799fd8799fd87a9f581c1eae96baf29e27682ea3f815aba361a0c6059d45e4bfbe95bbd2f44affffd8799f4040ffd8799f581ce992ef75f2367e6ecd93716ae88eba0d005dd91fd3a21f650b6496b5455355524745ff1b00000129918c04621b00000082879affdf1b000002ad6754cf100505d8799f190682ffd87980ff825839015b7e23228dba75595645fc357d0f97ba258cfccfff5d588d4bb9165b533b9586f0fb9aafd578e0d0154e9478d23614e736eb39d1a30d8a991a0641cee5021a000a2853031a0a718c0d05a1581df11eae96baf29e27682ea3f815aba361a0c6059d45e4bfbe95bbd2f44a000758205160f88b929bf8a6c57c285b889488f9137c0ef3cfd0bcf408a10020e69146d5081a0a718b590b582098aacaf7c0dae9b86b0d987a17cda8b10e7fd8f02b896aea0dda9bb23de65f840dd9010281825820b274d52c0517f3603d09eae3daa82c579925932f04975d2542b2c3a3c2d9ff2e040ed9010281581c5b7e23228dba75595645fc357d0f97ba258cfccfff5d588d4bb9165b10825839015b7e23228dba75595645fc357d0f97ba258cfccfff5d588d4bb9165b533b9586f0fb9aafd578e0d0154e9478d23614e736eb39d1a30d8a991a05f4fd98111a004c4b4012d90102848258200dc17712e37a4e741767db2f90d4ffbf69faf88b9bed4c47864f7bd912924bea00825820cf4ecddde0d81f9ce8fcc881a85eb1f8ccdaf6807f03fea4cd02da896a621776008258202536194d2a976370a932174c10975493ab58fd7c16395d50e62b7c0e1949baea00825820d46bd227bd2cf93dedd22ae9b6d92d30140cf0d68b756f6608e38d680c61ad1700a200d9010281825820c5d63d7dc066df52592135b6d3cb4f3470d06f7bdd4b2d2e32eb59ca3782662f5840e3aa1eee6afd9cf866f23fd5be4421de0cb881dfa90424c85f131805618de54db41edf671fd78cbd8667bb98894ccf6c2ccbc0c14cd3d0becca43b4dc89596030583840000d87980821962d91a007cc793840001d87980821a00012dfc1a0166fa60840300d8799f009f1a000aae60ff4100d87a809fd87a80ffff821a001465aa1a19a0cc8ef5a11902a2a1636d736781774d696e737761703a204f72646572204578656375746564'
        },
        {
            id: '641096f241b8e0d2ab744fba442adda7d498c1f51200b1f02b1e596eee3ff3f3',
            spends: 'inputs',
            inputs: [
                {
                    transaction: {
                        id: '00f0d876f1611b59439ae1457f7d11a9ec1355cc91f708e6bdbfe89256114893'
                    },
                    index: 1
                },
                {
                    transaction: {
                        id: '9972b0d0034d19eb7d59432ab2285c1b68e461ecf76764eec6870c923d1ebc04'
                    },
                    index: 1
                },
                {
                    transaction: {
                        id: 'fb07dd6a74ecbaabc237ea692b7be483c2158d8f8edb8df9da309916a203b577'
                    },
                    index: 1
                }
            ],
            outputs: [
                {
                    address: 'addr1z8d9k3aw6w24eyfjacy809h68dv2rwnpw0arrfau98jk6nhv88awp8sgxk65d6kry0mar3rd0dlkfljz7dv64eu39vfs38yd9p',
                    value: {
                        ada: {
                            lovelace: 2690000
                        },
                        '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa': {
                            '4e49474854': 2743589633
                        }
                    },
                    datum: 'd8799fd8799fd8799f581c636d0d0118a8933ac167d4c448150bb325deaf7a4fdfb44adc7f2f5affd8799fd8799fd8799f581ce39b5f40aa85fbc121a625d777a776eca1cb4c923426949c997d8828ffffffff9f9f40401a257839acffff9f9f581c0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa454e4947485400ffffd879800a0fff'
                },
                {
                    address: 'addr1q93k6rgprz5fxwkpvl2vgjq4pwejth400f8aldz2m3lj7khrnd05p259l0qjrf396am6wahv5895ey35y62fexta3q5q3cc3k8',
                    value: {
                        ada: {
                            lovelace: 2000000
                        },
                        '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa': {
                            '4e49474854': 6597308164
                        }
                    }
                },
                {
                    address: 'addr1q93k6rgprz5fxwkpvl2vgjq4pwejth400f8aldz2m3lj7khrnd05p259l0qjrf396am6wahv5895ey35y62fexta3q5q3cc3k8',
                    value: {
                        ada: {
                            lovelace: 2000000
                        },
                        '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa': {
                            '4e49474854': 6597308164
                        }
                    }
                },
                {
                    address: 'addr1q93k6rgprz5fxwkpvl2vgjq4pwejth400f8aldz2m3lj7khrnd05p259l0qjrf396am6wahv5895ey35y62fexta3q5q3cc3k8',
                    value: {
                        ada: {
                            lovelace: 11402336207
                        }
                    }
                }
            ],
            fee: {
                ada: {
                    lovelace: 190405
                }
            },
            validityInterval: {
                invalidAfter: 175214603
            },
            treasury: {},
            signatories: [
                {
                    key: '62e8297eae4d6a606981e93afec220dda426b38d38c3f504efe7ea44288a6194',
                    signature: '15ff3283be0bf3a2fb9c7fff64448487e8f2d4cfee9769c347e546d2f45ce41404b0548cdff291ade43f810205a76ddd07916acf18a7d10ee81b553cc6cb440a'
                }
            ],
            cbor: '84a400d901028382582000f0d876f1611b59439ae1457f7d11a9ec1355cc91f708e6bdbfe89256114893018258209972b0d0034d19eb7d59432ab2285c1b68e461ecf76764eec6870c923d1ebc0401825820fb07dd6a74ecbaabc237ea692b7be483c2158d8f8edb8df9da309916a203b577010184a300583911da5b47aed3955c9132ee087796fa3b58a1ba6173fa31a7bc29e56d4eec39fae09e0835b546eac323f7d1c46d7b7f64fe42f359aae7912b1301821a00290bd0a1581c0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1faa1454e494748541aa387db01028201d818588dd8799fd8799fd8799f581c636d0d0118a8933ac167d4c448150bb325deaf7a4fdfb44adc7f2f5affd8799fd8799fd8799f581ce39b5f40aa85fbc121a625d777a776eca1cb4c923426949c997d8828ffffffff9f9f40401a257839acffff9f9f581c0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa454e4947485400ffffd879800a0fff82583901636d0d0118a8933ac167d4c448150bb325deaf7a4fdfb44adc7f2f5ae39b5f40aa85fbc121a625d777a776eca1cb4c923426949c997d8828821a001e8480a1581c0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1faa1454e494748541b00000001893aef0482583901636d0d0118a8933ac167d4c448150bb325deaf7a4fdfb44adc7f2f5ae39b5f40aa85fbc121a625d777a776eca1cb4c923426949c997d8828821a001e8480a1581c0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1faa1454e494748541b00000001893aef0482583901636d0d0118a8933ac167d4c448150bb325deaf7a4fdfb44adc7f2f5ae39b5f40aa85fbc121a625d777a776eca1cb4c923426949c997d88281b00000002a7a1d7cf021a0002e7c5031a0a71900ba100d901028182582062e8297eae4d6a606981e93afec220dda426b38d38c3f504efe7ea44288a6194584015ff3283be0bf3a2fb9c7fff64448487e8f2d4cfee9769c347e546d2f45ce41404b0548cdff291ade43f810205a76ddd07916acf18a7d10ee81b553cc6cb440af5f6'
        },
        {
            id: 'cef659230fc1499940042769476c64d0274aecbf463dc732a81355c731ea69c4',
            spends: 'inputs',
            inputs: [
                {
                    transaction: {
                        id: '3be461599875780e9e01461d4c25d277d81f06e10ce69a71ff2832f808ff82da'
                    },
                    index: 1
                }
            ],
            outputs: [
                {
                    address: 'addr1qxzgjtcejm7634pp5u0spsfxysh04xw376z3ppvym9pnhpz58njxy545ldalpghka7sx94479e49pt7w94mc0ehe0kascvrr5y',
                    value: {
                        ada: {
                            lovelace: 1000000
                        }
                    }
                },
                {
                    address: 'addr1q8yhrhs8vkffe3zfdf57j6x9kw2qzzemf69y0lmzqqqz0f258njxy545ldalpghka7sx94479e49pt7w94mc0ehe0kaszh649h',
                    value: {
                        ada: {
                            lovelace: 70574030
                        }
                    }
                }
            ],
            fee: {
                ada: {
                    lovelace: 179581
                }
            },
            validityInterval: {
                invalidAfter: 175220622
            },
            treasury: {},
            metadata: {
                hash: '678247b6bd4d25cd301a57ac0df6d907f170645247763cc3c814900213546c4d',
                labels: {
                    '0': {
                        json: {
                            string: '27a82cd4b68fb515cb638fd815a6e9e7021d68195fa3b247b8bab790afad5e14'
                        }
                    },
                    '1': {
                        json: {
                            string: '14264362025-12-26 14:08'
                        }
                    },
                    '2': {
                        json: {
                            string: 'EMISOR OSCAR TONATHIU ESQUIVEL GALLEGOS'
                        }
                    },
                    '3': {
                        json: {
                            string: 'BENEFICIARIO NR FINANCE MEXICO, S.A. DE C.V.'
                        }
                    },
                    '4': {
                        cbor: 'a0'
                    }
                }
            },
            signatories: [
                {
                    key: '7ee489686893c46e760379ae2858ebee8107a9fcbfc531c41cde3278a6b95c99',
                    signature: 'f00848d3946a7340a06dabfb02f6067ced6e35ddb4f6a6abf2dda29333b8d2d84686ccde564773dda3cdd457da8e48e5ef5456cdaf98a090d36d16a344c00509'
                }
            ],
            cbor: '84a500d90102818258203be461599875780e9e01461d4c25d277d81f06e10ce69a71ff2832f808ff82da0101828258390184892f1996fda8d421a71f00c126242efa99d1f685108584d9433b84543ce46252b4fb7bf0a2f6efa062d6be2e6a50afce2d7787e6f97dbb1a000f424082583901c971de0765929cc4496a69e968c5b394010b3b4e8a47ff62000027a5543ce46252b4fb7bf0a2f6efa062d6be2e6a50afce2d7787e6f97dbb1a0434dfce021a0002bd7d031a0a71a78e075820678247b6bd4d25cd301a57ac0df6d907f170645247763cc3c814900213546c4da100d90102818258207ee489686893c46e760379ae2858ebee8107a9fcbfc531c41cde3278a6b95c995840f00848d3946a7340a06dabfb02f6067ced6e35ddb4f6a6abf2dda29333b8d2d84686ccde564773dda3cdd457da8e48e5ef5456cdaf98a090d36d16a344c00509f5d90103a100a500a166737472696e6778403237613832636434623638666235313563623633386664383135613665396537303231643638313935666133623234376238626162373930616661643565313401a166737472696e677731343236343336323032352d31322d32362031343a303802a166737472696e677827454d49534f52204f5343415220544f4e415448495520455351554956454c2047414c4c45474f5303a166737472696e67782c42454e45464943494152494f204e522046494e414e4345204d455849434f2c20532e412e20444520432e562e04a0'
        },
        {
            id: '3b032dea2cadb4b11ffa644ef740d591fc2bdfdd5e320b08ab3a6f3383c85e31',
            spends: 'inputs',
            inputs: [
                {
                    transaction: {
                        id: 'bc9010527c5e22cbda20cc390ce5d40a99ff9e27e76e97af88b2b718085ddb1e'
                    },
                    index: 0
                }
            ],
            outputs: [
                {
                    address: 'addr1qy9f7wepw3fegcf9m27pnyp9z8kvhrzyad0qk4tpehqr55kl854w0hemr56c66a2cylzzt6hyvkl9r2s73h7d3kr6vrsm943w8',
                    value: {
                        ada: {
                            lovelace: 207891563
                        }
                    }
                }
            ],
            fee: {
                ada: {
                    lovelace: 166588
                }
            },
            validityInterval: {
                invalidAfter: 1000000000
            },
            treasury: {},
            signatories: [
                {
                    key: '9780e61f47f7a6bf8ffaddbc96c832ab18aa8aceaaac4214f0d18f8296f47e89',
                    signature: '730415a2df3ed0f282caa50d965f5dc88ca6c797bf2836133a414366eb6b04934718cdd92cac8895aeaf4fff37216dd6f5cb68ebc2b38f56290204babcb6350e'
                }
            ],
            cbor: '84a400d9010281825820bc9010527c5e22cbda20cc390ce5d40a99ff9e27e76e97af88b2b718085ddb1e000181825839010a9f3b217453946125dabc19902511eccb8c44eb5e0b5561cdc03a52df3d2ae7df3b1d358d6baac13e212f57232df28d50f46fe6c6c3d3071a0c642c6b021a00028abc031a3b9aca00a100d90102818258209780e61f47f7a6bf8ffaddbc96c832ab18aa8aceaaac4214f0d18f8296f47e895840730415a2df3ed0f282caa50d965f5dc88ca6c797bf2836133a414366eb6b04934718cdd92cac8895aeaf4fff37216dd6f5cb68ebc2b38f56290204babcb6350ef5f6'
        },
        {
            id: '46e9c80f24149260b9e11591e1b521b57ba4819558a0bb06b61ef6663daea661',
            spends: 'inputs',
            inputs: [
                {
                    transaction: {
                        id: '0c2e4df5950ec6a57b80d500b443891e311e678f8776eb3e1cfa890a70e7a70d'
                    },
                    index: 11
                },
                {
                    transaction: {
                        id: '188a6d7f304bd9afa2fd0e38502afb15e29ed28f9c64c2b8a66f2662c3f8e262'
                    },
                    index: 0
                }
            ],
            references: [
                {
                    transaction: {
                        id: '99a59f7873fd932635cc416464cb3b681bb1187eba3441d6d8c11bf4d3bb1ff4'
                    },
                    index: 0
                }
            ],
            outputs: [
                {
                    address: 'addr1w92nme22mmx9exl6spktuq6pm6wg4ruw7y7j36r2sy5yxvcyerj3z',
                    value: {
                        ada: {
                            lovelace: 1340410
                        },
                        f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                            '000de14068616e646c655f726f6f744068616e646c655f73657474696e6773': 1
                        }
                    },
                    datum: 'd8799f5820f6e7f60bce3ea0ea42d760252b02350b6c30c609195f67ca8693edd068fc201eff'
                },
                {
                    address: 'addr1wxktka03n943759y4pcexpmftdhzsrrv8kcd2qs8cwgtdhgg6j4ux',
                    value: {
                        ada: {
                            lovelace: 3939340
                        },
                        f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                            '000643b0707379636869636d656469756d': 1
                        }
                    },
                    datum: 'd8799fab446e616d654e24707379636869636d656469756d45696d6167655838697066733a2f2f7a623272685a4d73756b6837584257564e526d55714e6e554136744b5a5261634733515456413359573552477770315675496d65646961547970654a696d6167652f6a706567426f6700496f675f6e756d6265720046726172697479456261736963466c656e6774680d4a63686172616374657273476c657474657273516e756d657269635f6d6f64696669657273404b68616e646c655f747970654668616e646c654776657273696f6e0101b04e7374616e646172645f696d6167655838697066733a2f2f7a623272685a4d73756b6837584257564e526d55714e6e554136744b5a526163473351545641335957355247777031567546706f7274616c404864657369676e65724047736f6369616c73404676656e646f72404764656661756c7400536c6173745f7570646174655f61646472657373583901191dfa68c413ac58144431596e1c62a6c2b6689ed0e2405fb422f3932bb596a65b7c6f84133647dcec1969a458a9e325e96fe46c107ccadc4c76616c6964617465645f6279581c4da965a049dfd15ed1ee19fba6e2974a0b79fc416dd1796a1f97f5e14a696d6167655f686173685820285f7118909ad9c5787b6cf2490999715f21e906ee817acf67dddec1617b4ca4537374616e646172645f696d6167655f686173685820285f7118909ad9c5787b6cf2490999715f21e906ee817acf67dddec1617b4ca44b7376675f76657273696f6e46332e302e31354c6167726565645f7465726d735768747470733a2f2f68616e646c652e6d652f242f746f75546d6967726174655f7369675f72657175697265640045747269616c00446e736677004a707a5f656e61626c656401ff'
                },
                {
                    address: 'addr1qyv3m7ngcsf6ckq5gsc4jmsuv2nv9dngnmgwyszlks308yetkkt2vkmud7zpxdj8mnkpj6dytz57xf0fdljxcyruetwqxsq9c9',
                    value: {
                        ada: {
                            lovelace: 1288690
                        },
                        f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                            '000de140707379636869636d656469756d': 1
                        }
                    },
                    datum: '4d707379636869636d656469756d'
                },
                {
                    address: 'addr1wxktka03n943759y4pcexpmftdhzsrrv8kcd2qs8cwgtdhgg6j4ux',
                    value: {
                        ada: {
                            lovelace: 3904860
                        },
                        f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                            '000643b062656e6e7962657473': 1
                        }
                    },
                    datum: 'd8799fab446e616d654a2462656e6e796265747345696d6167655838697066733a2f2f7a623272686e7770706751706a623177374c6e37467a4b5665464d61715475397948624564347735414355336b46725846496d65646961547970654a696d6167652f6a706567426f6700496f675f6e756d6265720046726172697479456261736963466c656e677468094a63686172616374657273476c657474657273516e756d657269635f6d6f64696669657273404b68616e646c655f747970654668616e646c654776657273696f6e0101b04e7374616e646172645f696d6167655838697066733a2f2f7a623272686e7770706751706a623177374c6e37467a4b5665464d61715475397948624564347735414355336b4672584646706f7274616c404864657369676e65724047736f6369616c73404676656e646f72404764656661756c7400536c6173745f7570646174655f61646472657373583901997855bb3dcd7905944406401f2ea74814a9b98b61a4db5410be635abd3e68ac1fdef1d5f4d10b3aaaaf236fb5b67ce4fe0280d1d4a875a14c76616c6964617465645f6279581c4da965a049dfd15ed1ee19fba6e2974a0b79fc416dd1796a1f97f5e14a696d6167655f686173685820f239a0d8cc4866d01b94c054e61cd21ff656acaf16668eeb704722f86764931e537374616e646172645f696d6167655f686173685820f239a0d8cc4866d01b94c054e61cd21ff656acaf16668eeb704722f86764931e4b7376675f76657273696f6e46332e302e31354c6167726565645f7465726d735768747470733a2f2f68616e646c652e6d652f242f746f75546d6967726174655f7369675f72657175697265640045747269616c00446e736677004a707a5f656e61626c656401ff'
                },
                {
                    address: 'addr1qxvhs4dm8hxhjpv5gsryq8ew5aypf2de3ds6fk65zzlxxk4a8e52c877782lf5gt82427gm0kkm8ee87q2qdr49gwkss6q9gfr',
                    value: {
                        ada: {
                            lovelace: 1254210
                        },
                        f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                            '000de14062656e6e7962657473': 1
                        }
                    },
                    datum: '4962656e6e7962657473'
                },
                {
                    address: 'addr1wxktka03n943759y4pcexpmftdhzsrrv8kcd2qs8cwgtdhgg6j4ux',
                    value: {
                        ada: {
                            lovelace: 3947960
                        },
                        f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                            '000643b062656e6e795f62657473': 1
                        }
                    },
                    datum: 'd8799fab446e616d654b2462656e6e795f6265747345696d6167655838697066733a2f2f7a623272686245664c54726a4857456d77676a374a413176334336715633627876694e6b7964634d685857645276537957496d65646961547970654a696d6167652f6a706567426f6700496f675f6e756d6265720046726172697479456261736963466c656e6774680a4a636861726163746572734f6c6574746572732c7370656369616c516e756d657269635f6d6f64696669657273404b68616e646c655f747970654668616e646c654776657273696f6e0101b04e7374616e646172645f696d6167655838697066733a2f2f7a623272686245664c54726a4857456d77676a374a413176334336715633627876694e6b7964634d68585764527653795746706f7274616c404864657369676e65724047736f6369616c73404676656e646f72404764656661756c7400536c6173745f7570646174655f61646472657373583901997855bb3dcd7905944406401f2ea74814a9b98b61a4db5410be635abd3e68ac1fdef1d5f4d10b3aaaaf236fb5b67ce4fe0280d1d4a875a14c76616c6964617465645f6279581c4da965a049dfd15ed1ee19fba6e2974a0b79fc416dd1796a1f97f5e14a696d6167655f686173685820443d88545e2d66f4a0187173e945d48518d2a6c46e714f605321be73d28f0fd9537374616e646172645f696d6167655f686173685820443d88545e2d66f4a0187173e945d48518d2a6c46e714f605321be73d28f0fd94b7376675f76657273696f6e46332e302e31354c6167726565645f7465726d735768747470733a2f2f68616e646c652e6d652f242f746f75546d6967726174655f7369675f72657175697265640045747269616c00446e736677004a707a5f656e61626c656401ff'
                },
                {
                    address: 'addr1qxvhs4dm8hxhjpv5gsryq8ew5aypf2de3ds6fk65zzlxxk4a8e52c877782lf5gt82427gm0kkm8ee87q2qdr49gwkss6q9gfr',
                    value: {
                        ada: {
                            lovelace: 1262830
                        },
                        f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                            '000de14062656e6e795f62657473': 1
                        }
                    },
                    datum: '4a62656e6e795f62657473'
                },
                {
                    address: 'addr1wxktka03n943759y4pcexpmftdhzsrrv8kcd2qs8cwgtdhgg6j4ux',
                    value: {
                        ada: {
                            lovelace: 3874690
                        },
                        f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                            '000643b06162646576': 1
                        }
                    },
                    datum: 'd8799fab446e616d654624616264657645696d6167655838697066733a2f2f7a623272686d5751455658597a75664e5a69704e5431726d4d35664d45745133765563634b4554654d7174447067695778496d65646961547970654a696d6167652f6a706567426f6700496f675f6e756d626572004672617269747946636f6d6d6f6e466c656e677468054a63686172616374657273476c657474657273516e756d657269635f6d6f64696669657273404b68616e646c655f747970654668616e646c654776657273696f6e0101b04e7374616e646172645f696d6167655838697066733a2f2f7a623272686d5751455658597a75664e5a69704e5431726d4d35664d45745133765563634b4554654d717444706769577846706f7274616c404864657369676e65724047736f6369616c73404676656e646f72404764656661756c7400536c6173745f7570646174655f6164647265737358390138e0181fb5f9636167a15c36d0a61ba03c6eb01cee460c358ceadca6b71152a4f8498a8bcf409735fd4110eb0d9d673d23f92b477c0c2d904c76616c6964617465645f6279581c4da965a049dfd15ed1ee19fba6e2974a0b79fc416dd1796a1f97f5e14a696d6167655f686173685820dcda9e2713b9af40456dc74f075240f7dee3bd226986fd0ac492de3cc1c743d5537374616e646172645f696d6167655f686173685820dcda9e2713b9af40456dc74f075240f7dee3bd226986fd0ac492de3cc1c743d54b7376675f76657273696f6e46332e302e31354c6167726565645f7465726d735768747470733a2f2f68616e646c652e6d652f242f746f75546d6967726174655f7369675f72657175697265640045747269616c00446e736677004a707a5f656e61626c656401ff'
                },
                {
                    address: 'addr1qyuwqxqlkhukxct859wrd59xrwsrcm4srnhyvrp43n4def4hz9f2f7zf329u7syhxh75zy8tpkwkw0frly45wlqv9kgq33tkzm',
                    value: {
                        ada: {
                            lovelace: 1219730
                        },
                        f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                            '000de1406162646576': 1
                        }
                    },
                    datum: '456162646576'
                },
                {
                    address: 'addr1wxktka03n943759y4pcexpmftdhzsrrv8kcd2qs8cwgtdhgg6j4ux',
                    value: {
                        ada: {
                            lovelace: 4314310
                        },
                        f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                            '000643b0776f6f647340686f736b796d6f6a69': 1
                        }
                    },
                    datum: 'd8799faf446e616d655024776f6f647340686f736b796d6f6a6945696d6167655838697066733a2f2f7a62327268576a68475a7161706d3554566d544b4148376675704b505847776a584532315a3441346371434a4e35544754496d65646961547970654a696d6167652f6a706567426f6700496f675f6e756d6265720046726172697479456261736963466c656e6774680f4a63686172616374657273476c657474657273516e756d657269635f6d6f64696669657273404b68616e646c655f747970654d6e66745f73756268616e646c654776657273696f6e014a7375625f72617269747946636f6d6d6f6e4a7375625f6c656e677468054e7375625f63686172616374657273476c657474657273557375625f6e756d657269635f6d6f646966696572734001b04e7374616e646172645f696d6167655838697066733a2f2f7a62327268576a68475a7161706d3554566d544b4148376675704b505847776a584532315a3441346371434a4e3554475446706f7274616c404864657369676e65724047736f6369616c73404676656e646f72404764656661756c7400536c6173745f7570646174655f616464726573735839016f37730d5888ad36ba476f513a2c44ce48a213f26df69c379f03a821ec0111ac0b2d26c6b8ba35b64ef1a054c1061e3eb26ff59098b3d2394c76616c6964617465645f6279581c4da965a049dfd15ed1ee19fba6e2974a0b79fc416dd1796a1f97f5e14a696d6167655f6861736858200163207663d9ee4a68818f0e28d3c311e5a1d7a681a70839b5414e853bd00d78537374616e646172645f696d6167655f6861736858200163207663d9ee4a68818f0e28d3c311e5a1d7a681a70839b5414e853bd00d784b7376675f76657273696f6e46332e302e31354c6167726565645f7465726d735768747470733a2f2f68616e646c652e6d652f242f746f75546d6967726174655f7369675f72657175697265640045747269616c00446e736677004a707a5f656e61626c656401ff'
                },
                {
                    address: 'addr1q822xzvnxwtkdd556c5namjthxd4ezzmhk2f3ckfugxdmtmge7uh3j7040l00g5r3mg96uqc6rwtaxe9hewvmmprnkxqw7vwsg',
                    value: {
                        ada: {
                            lovelace: 1305930
                        },
                        f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                            '000de140776f6f647340686f736b796d6f6a69': 1
                        }
                    },
                    datum: '4f776f6f647340686f736b796d6f6a69'
                },
                {
                    address: 'addr1v9m40zw2zsen29k2d2aq7h8q72qj7ne4sz7lq7lcverr3cqj9g7u5',
                    value: {
                        ada: {
                            lovelace: 640074128
                        }
                    }
                }
            ],
            collaterals: [
                {
                    transaction: {
                        id: '0c2e4df5950ec6a57b80d500b443891e311e678f8776eb3e1cfa890a70e7a70d'
                    },
                    index: 11
                }
            ],
            collateralReturn: {
                address: 'addr1v9m40zw2zsen29k2d2aq7h8q72qj7ne4sz7lq7lcverr3cqj9g7u5',
                value: {
                    ada: {
                        lovelace: 665911180
                    }
                }
            },
            mint: {
                f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                    '000643b06162646576': 1,
                    '000643b062656e6e795f62657473': 1,
                    '000643b062656e6e7962657473': 1,
                    '000643b0707379636869636d656469756d': 1,
                    '000643b0776f6f647340686f736b796d6f6a69': 1,
                    '000de1406162646576': 1,
                    '000de14062656e6e795f62657473': 1,
                    '000de14062656e6e7962657473': 1,
                    '000de140707379636869636d656469756d': 1,
                    '000de140776f6f647340686f736b796d6f6a69': 1
                }
            },
            requiredExtraSignatories: ['4da965a049dfd15ed1ee19fba6e2974a0b79fc416dd1796a1f97f5e1'],
            scriptIntegrityHash: 'cfdbc43e53309e01c564eaeb65b73d87764c191b7fce1f7a9ddb14de1d88ca20',
            fee: {
                ada: {
                    lovelace: 950994
                }
            },
            validityInterval: {
                invalidAfter: 175215225
            },
            treasury: {},
            metadata: {
                hash: '467692f1f288a9a287679ba3120c84ebc9b2b7614cfb9ff1864c3ba9119cbf64',
                labels: {
                    '721': {
                        json: {
                            f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                                '000de140707379636869636d656469756d': {
                                    name: '$psychicmedium',
                                    image: 'ipfs://zb2rhZMsukh7XBWVNRmUqNnUA6tKZRacG3QTVA3YW5RGwp1Vu',
                                    mediaType: 'image/jpeg',
                                    og: 0,
                                    og_number: 0,
                                    rarity: 'basic',
                                    length: 13,
                                    characters: 'letters',
                                    numeric_modifiers: '',
                                    handle_type: 'handle',
                                    version: 1
                                },
                                '000de14062656e6e7962657473': {
                                    name: '$bennybets',
                                    image: 'ipfs://zb2rhnwppgQpjb1w7Ln7FzKVeFMaqTu9yHbEd4w5ACU3kFrXF',
                                    mediaType: 'image/jpeg',
                                    og: 0,
                                    og_number: 0,
                                    rarity: 'basic',
                                    length: 9,
                                    characters: 'letters',
                                    numeric_modifiers: '',
                                    handle_type: 'handle',
                                    version: 1
                                },
                                '000de14062656e6e795f62657473': {
                                    name: '$benny_bets',
                                    image: 'ipfs://zb2rhbEfLTrjHWEmwgj7JA1v3C6qV3bxviNkydcMhXWdRvSyW',
                                    mediaType: 'image/jpeg',
                                    og: 0,
                                    og_number: 0,
                                    rarity: 'basic',
                                    length: 10,
                                    characters: 'letters,special',
                                    numeric_modifiers: '',
                                    handle_type: 'handle',
                                    version: 1
                                },
                                '000de1406162646576': {
                                    name: '$abdev',
                                    image: 'ipfs://zb2rhmWQEVXYzufNZipNT1rmM5fMEtQ3vUccKETeMqtDpgiWx',
                                    mediaType: 'image/jpeg',
                                    og: 0,
                                    og_number: 0,
                                    rarity: 'common',
                                    length: 5,
                                    characters: 'letters',
                                    numeric_modifiers: '',
                                    handle_type: 'handle',
                                    version: 1
                                },
                                '000de140776f6f647340686f736b796d6f6a69': {
                                    name: '$woods@hoskymoji',
                                    image: 'ipfs://zb2rhWjhGZqapm5TVmTKAH7fupKPXGwjXE21Z4A4cqCJN5TGT',
                                    mediaType: 'image/jpeg',
                                    og: 0,
                                    og_number: 0,
                                    rarity: 'basic',
                                    length: 15,
                                    characters: 'letters',
                                    numeric_modifiers: '',
                                    handle_type: 'nft_subhandle',
                                    version: 1,
                                    sub_rarity: 'common',
                                    sub_length: 5,
                                    sub_characters: 'letters',
                                    sub_numeric_modifiers: ''
                                }
                            }
                        }
                    }
                }
            },
            signatories: [
                {
                    key: 'b62a7193927f47ef703ba99a06add1ee2d4d94853a16dcd68ad0f5d9baa18530',
                    signature: 'd01df5e9cfa549fbaf87cf994ffab676b542d54edfdde33421c008f3c6e6f0cbe171a365cdff86dab172e2afda29fbeabd5f7a12cd553e747cca79569d0f0702'
                },
                {
                    key: '45b4af9cb14acbfe28fd626f4d88c8a17807cfd5f78281d7c3e16a46f283d744',
                    signature: '3e4514a8ce85202d2484bdbdf27c34b4bd4380eb1d10f7ef34adc632b1f1406e1d3920761cdf77f74130588ae1de8a4c24c4b3bb942bf4e38a4b5bdc4deed009'
                }
            ],
            scripts: {
                f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: {
                    language: 'native',
                    json: {
                        clause: 'signature',
                        from: '4da965a049dfd15ed1ee19fba6e2974a0b79fc416dd1796a1f97f5e1'
                    }
                }
            },
            redeemers: [
                {
                    validator: {
                        index: 1,
                        purpose: 'spend'
                    },
                    redeemer:
                        'd87a9f9fd8799f9fd8799f005f5840df3b0f69989cf7f02929c735a4e3f32fa07600f0ea7270b5316fff8c838a0aaf3f18149af6dafd6a25fe8a0f7603b6263fe553ed38bb17b3790e19ae6744987558401c80708fc8aed4d092d816ff5b3270a5afaf358754c290dfddcb88f326c3ebc7601fb21ad04a59d712d2ca9d43bb2a4734c0da06c6d9d422de90755659240248ffffd8799f005f584053e73e8363a670a4380c0176da51d8185a8d69e10ea79250765e57f5cf39b1c1b001e5ea95df403c3846b67fca8043c68b26eda026d528823bbbc74b014a1eb5584005a12045d2e668cd9e90459103c14c6f94a99e9134dacb2fb23a1a9345cec1b3f54da4cdb387e09b0fae43a00bc1d5ba56fd42c06442dd3995ebb72391783aebffffd8799f005f5840c7205b18b3e5e28bb58f615ab4a1b2b793a9ea7cbda36d9269a404615a4a2b12c4ea99ff0c65e607d0fcc5ac51ff42c4547a5999cbd68d98d7f68f2b92ff24cb5840ce9d0f2749fa461802edf1e92df809237900145e668c4523133a2fccfdd9231869ea3b13ce3c4cb0f7ba25e1d3b52d979d8cecc70e6028b8e613026513b63b02ffffd8799f005f5840c7660702d50dd0dac15622875e9ee3d089e634682dbf00d821c44ae32f0c77b6e115ad1fd6d37b3d1e0817004d90c76cbd26f6a49c08ac600142386220f592cb5840b362592f062cd0ed7b31975bd39d985417659f0d45c11d65fa58f8524ccc90987f711f2cb2b810a8158c7a0a5dbe2e086eceb66ea7640f7fcbe664af797338b9ffffff4d707379636869636d656469756d00ffd8799f9fd8799f005f5840df3b0f69989cf7f02929c735a4e3f32fa07600f0ea7270b5316fff8c838a0aaf3f18149af6dafd6a25fe8a0f7603b6263fe553ed38bb17b3790e19ae6744987558401c80708fc8aed4d092d816ff5b3270a5afaf358754c290dfddcb88f326c3ebc7601fb21ad04a59d712d2ca9d43bb2a4734c0da06c6d9d422de90755659240248ffffd8799f005f5840ac203c3dfff25a3ee29c58ebe71b453763c30710f09248dd107366e5d68b25cb2a5dda918240956a05bb50a23819e2fe173c28d47227cad94c0e9371a302887b5840de9d5ae35f18b12e1326d798624b889a712fb45aa46d6d8a0b0312aca50b099346d37d45e4f9954849f6ed0a78f5eb898cc699fe9756c7ce6bc070cc22369e67ffffd8799f005f5840a4fe6ac9ffd0174d500f8241e63342a1a490a3bc6a36967c1ad1b0db494fa5420caae32f558dc9a63d50a61e495fd5781e2a185449a18e7372dec93bdafcbeab584093b5ed145ff79b6b2d0692de442462f472977d2bdd28249857920a77de42ef7bc2a6182a6eb9da7dec020ef603dffdbdf9ebfee1e0d680312d7b0267ef67edceffffd8799f005f5840db3f72e5c9cef73fbb79a3a151b229bbde31f6285d2709aaf17baed2cecc71d8a5d8991f75b7424f0d405afca79e1c10644092916b1af830d3179c8d805a7d295840e586829636b6d8f93581981f3fc5ee6d789385f2988e127a31ceb1916c5c821cfa7a2ae102557fbd14f83df71eaef0a8f3b92f7b1cd27094f4e104b72ad61f24ffffd8799f005f58402c5ef7949672952ce56a965f70b23d18399a61fa50a14329032f703c2f26c42f85c09af929492a871e4fae32d9d5c36e352471cd659bcdb61de08f1722acc3b158400eb923b0cbd24df54401d998531feead35a47a99f4deed205de4af81120f9761d051e7b0d7cdf230a201f892052d9fa697b94dec911825b65a6d992770622079ffffff4962656e6e796265747300ffd8799f9fd8799f005f5840d19988e4dfa243f49fff2f82e9cb5ba5c0810157997f7d6df3859eef7ee0668e32d9df0c962ab4898acfb38ad6f906097e475d69c8fb34f0cdd1b727560231be5840ad2720899a8dcd4433df0fbe2c903b59059039c5ddb339c456a1795a7f9d45e55d9ca0812228a67816523aab1b881a11ddfc84353a8bd9acf4826953e3846918ffffd8799f005f58405fd2b0bdd49cf890337ec8215049010b5f8607c15e66b70dcf15a594945e9d2366d3258da49ddd817ef1fcf2f1958a4d3946102002ea51f8fd848cf48ae550f9584022aa75784fb6a0195d3a4d8c5447df73f416a150621350f18d9db41e2a6879863147c97b2c19c2d3565a39a3d58ce545f82b447aaa6c0692acd3007d0bc82f6bffffd8799f005f58409205764c16ad5d3efacc1d18edae9cca8a0b80a6c72302b5320ca3e6c5fd86e007cde098e6dc3c333c6e540ef7afbac96e87552b8a60f14aed6aaeb7e8865f635840604069473f426d669c8eac525208ae8b30cb299dd6666b18e8f2d0f71fe4d96d786be95172031cd77a4f1c76a71b52dbadc2bfd2e0de54de6516c8e08366507bffffd8799f005f5840666dd4fad99de2be7f8aa19c59d0c005f976de45584cdb5c32ec37182937d5636471b864d66024c8f973f45184d6cc76c3decae676bf675c1f79eb3a94fd76695840077a476358c9bce168bf7329ea55c678861d8451389d7d177b9c0b29553840e1b29d31d129fd0f247f797cca369e0cae6251fa200c3b560084cece9da5e93caeffffd8799f005f5840d4c1dd446dea5dd1b7af9b6e0d59dcf8bfb407a6f11d6a4f704cc90fe0fdf7ff6e8b5495a10c3adb9cbf946fe65b4af0ca766d295e70b258ad939c7064bb928458400eb923b0cbd24df54401d998531feead35a47a99f4deed205de4af81120f97610000000000000000000000000000000000000000000000000000000000000000ffffff4a62656e6e795f6265747300ffd8799f9fd8799f005f58404bddce9c11944b08292c62dcd825a9522fe0e43eb16b753a7cba7e8e148d9f5374d3ae0d65f6203fe10a43cdb2c21a8c14a792ab22650f1872ed9279f10327725840178d7758e17c36c1bb111685e54b43cfaeafeaaaa706fd84e30121afdeccf79214ccf75984a6ac5d96cbaeab5a81534448feca97a929cba09b3bd29c899f2145ffffd8799f005f5840869f5f45339b0de949305138c38bca52e1a97eb7b9927623fccfa12dcccee278c749815cf546465c8da07a5cac864709239ae169fd78088b4482b52647fb314c5840f7886d89bcd0c056f510e386b7b5c302fecd33e0e4f26c760775c0a4b3a3dcf56b555e7139f347eb5553c6e42df578aeec8c2f6054a3e74aa8912fddb0c6f736ffffd8799f005f5840eeac23cd4f997ff575c6f998b43d9640fc955969323d8a4a520e0cfee7a2b85101ee0d25e2b2acbdf15cc0ce84645de4cdc128bf7f877237970b4ec79bb0889758409e2483cf966f059c4ec1a0d50a4d1bd3a9f462f6224b158c96dc6dbb572e417369744067d9b599952d283fdcd3a9c020cc99273db633700c3fef95991ca9cdc3ffffd8799f005f58401c10e71ea9aa777bf19a9ea840afcd01bfbdca0a130b487a3054c317688b432b98328839313c6d98d695349a116e15ac31e44a6fa640a9c6c9ba4c48fbac37c558400d7c78015cab0041eb5b14983d386c06220728d28c86fce8264ce67676eb8a50e4f993d702874d76b1aa4dcf089b5532adce36d53af8ae675d943979c75224faffffd8799f005f5840edd33839c0c5044c16f6da48189daf4f45ea0187f898c7a13ac030aaaedf5791b0365f7a1248f1d63acd12c0de694b0d2944608e6960f6f8a2e4278de42df00158400eb923b0cbd24df54401d998531feead35a47a99f4deed205de4af81120f97610000000000000000000000000000000000000000000000000000000000000000ffffff45616264657600ffd8799f9fd8799f005f58404bddce9c11944b08292c62dcd825a9522fe0e43eb16b753a7cba7e8e148d9f5374d3ae0d65f6203fe10a43cdb2c21a8c14a792ab22650f1872ed9279f10327725840178d7758e17c36c1bb111685e54b43cfaeafeaaaa706fd84e30121afdeccf792926eb4a993f426f7c5736d5f472fb2ec25c9ab76fb5a92ffeea9d058be5ddcbdffffd8799f005f5840e1da92765a12425e800229bd8b39b666d04d9bd9c267717248478a1f20f965d5ea2fecdea4898e0ab369a4005a321139540c68fe0b6cc5ba75fcae9c93cc196a584091a0d08ae0fca8ae37fa0d99ddd4b87e3f5789d03e587e3d19a2f4a4c29d371e46cd34cca9e5dbd54e12628247fd6d2f856fce34a27c639363ecbb1219115cebffffd8799f005f5840b62186abc714bd090932471010f037bf51c8cdddb472839bbaea4cb563467b7c332dfb62716d9ae213ee1a9642a91ed4caad4978d41b034c2b856912c27fa83858401626c34ebdeafa21558b36e31e93f7b82e1bf281af6632cffa84c83233404e1c9280026c31023eae37ce8e549aa8b350bc377f3da5c9da651fd454740bc91482ffffd8799f005f584023ca7a4a1f7c6a6ce7c1b9fd677e193fa16fa575120847e84351a2dd72723af40a84b425aafb78788d65b73b41c14402308c936d8e6c18dd2d093cf9c04782ea58406403f293bfa78b9b5a76fb3b94b04dbdc79bc55975dbcfc08bf519b810916f2d7c2efe700f955d67648df43ab21878d3aab855b2758441b1b778334100dc098dffffd8799f005f584079644647dbef3763e1192b798de3833bba56c4770dda102fcbcd62930ae9e8e782152b171e3afb43cd10bd05a84e4d6b238acab5d2504524e623a32450f381865840ac7895773e3f8863419236417de3535d9e5ec0896316786bd104e708e6335ea60000000000000000000000000000000000000000000000000000000000000000ffffff4f776f6f647340686f736b796d6f6a6900ffffff',
                    executionUnits: {
                        memory: 2987830,
                        cpu: 862914622
                    }
                }
            ],
            cbor: '84ab00d90102828258200c2e4df5950ec6a57b80d500b443891e311e678f8776eb3e1cfa890a70e7a70d0b825820188a6d7f304bd9afa2fd0e38502afb15e29ed28f9c64c2b8a66f2662c3f8e26200018ca300581d71553de54adecc5c9bfa806cbe0341de9c8a8f8ef13d28e86a8128433301821a001473faa1581cf0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9aa1581f000de14068616e646c655f726f6f744068616e646c655f73657474696e677301028201d8185826d8799f5820f6e7f60bce3ea0ea42d760252b02350b6c30c609195f67ca8693edd068fc201effa300581d71acbb75f1996b1f50a4a8719307695b6e280c6c3db0d50207c390b6dd01821a003c1c0ca1581cf0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9aa151000643b0707379636869636d656469756d01028201d81859028fd8799fab446e616d654e24707379636869636d656469756d45696d6167655838697066733a2f2f7a623272685a4d73756b6837584257564e526d55714e6e554136744b5a5261634733515456413359573552477770315675496d65646961547970654a696d6167652f6a706567426f6700496f675f6e756d6265720046726172697479456261736963466c656e6774680d4a63686172616374657273476c657474657273516e756d657269635f6d6f64696669657273404b68616e646c655f747970654668616e646c654776657273696f6e0101b04e7374616e646172645f696d6167655838697066733a2f2f7a623272685a4d73756b6837584257564e526d55714e6e554136744b5a526163473351545641335957355247777031567546706f7274616c404864657369676e65724047736f6369616c73404676656e646f72404764656661756c7400536c6173745f7570646174655f61646472657373583901191dfa68c413ac58144431596e1c62a6c2b6689ed0e2405fb422f3932bb596a65b7c6f84133647dcec1969a458a9e325e96fe46c107ccadc4c76616c6964617465645f6279581c4da965a049dfd15ed1ee19fba6e2974a0b79fc416dd1796a1f97f5e14a696d6167655f686173685820285f7118909ad9c5787b6cf2490999715f21e906ee817acf67dddec1617b4ca4537374616e646172645f696d6167655f686173685820285f7118909ad9c5787b6cf2490999715f21e906ee817acf67dddec1617b4ca44b7376675f76657273696f6e46332e302e31354c6167726565645f7465726d735768747470733a2f2f68616e646c652e6d652f242f746f75546d6967726174655f7369675f72657175697265640045747269616c00446e736677004a707a5f656e61626c656401ffa300583901191dfa68c413ac58144431596e1c62a6c2b6689ed0e2405fb422f3932bb596a65b7c6f84133647dcec1969a458a9e325e96fe46c107ccadc01821a0013a9f2a1581cf0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9aa151000de140707379636869636d656469756d01028201d8184e4d707379636869636d656469756da300581d71acbb75f1996b1f50a4a8719307695b6e280c6c3db0d50207c390b6dd01821a003b955ca1581cf0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9aa14d000643b062656e6e796265747301028201d81859028bd8799fab446e616d654a2462656e6e796265747345696d6167655838697066733a2f2f7a623272686e7770706751706a623177374c6e37467a4b5665464d61715475397948624564347735414355336b46725846496d65646961547970654a696d6167652f6a706567426f6700496f675f6e756d6265720046726172697479456261736963466c656e677468094a63686172616374657273476c657474657273516e756d657269635f6d6f64696669657273404b68616e646c655f747970654668616e646c654776657273696f6e0101b04e7374616e646172645f696d6167655838697066733a2f2f7a623272686e7770706751706a623177374c6e37467a4b5665464d61715475397948624564347735414355336b4672584646706f7274616c404864657369676e65724047736f6369616c73404676656e646f72404764656661756c7400536c6173745f7570646174655f61646472657373583901997855bb3dcd7905944406401f2ea74814a9b98b61a4db5410be635abd3e68ac1fdef1d5f4d10b3aaaaf236fb5b67ce4fe0280d1d4a875a14c76616c6964617465645f6279581c4da965a049dfd15ed1ee19fba6e2974a0b79fc416dd1796a1f97f5e14a696d6167655f686173685820f239a0d8cc4866d01b94c054e61cd21ff656acaf16668eeb704722f86764931e537374616e646172645f696d6167655f686173685820f239a0d8cc4866d01b94c054e61cd21ff656acaf16668eeb704722f86764931e4b7376675f76657273696f6e46332e302e31354c6167726565645f7465726d735768747470733a2f2f68616e646c652e6d652f242f746f75546d6967726174655f7369675f72657175697265640045747269616c00446e736677004a707a5f656e61626c656401ffa300583901997855bb3dcd7905944406401f2ea74814a9b98b61a4db5410be635abd3e68ac1fdef1d5f4d10b3aaaaf236fb5b67ce4fe0280d1d4a875a101821a00132342a1581cf0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9aa14d000de14062656e6e796265747301028201d8184a4962656e6e7962657473a300581d71acbb75f1996b1f50a4a8719307695b6e280c6c3db0d50207c390b6dd01821a003c3db8a1581cf0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9aa14e000643b062656e6e795f6265747301028201d818590294d8799fab446e616d654b2462656e6e795f6265747345696d6167655838697066733a2f2f7a623272686245664c54726a4857456d77676a374a413176334336715633627876694e6b7964634d685857645276537957496d65646961547970654a696d6167652f6a706567426f6700496f675f6e756d6265720046726172697479456261736963466c656e6774680a4a636861726163746572734f6c6574746572732c7370656369616c516e756d657269635f6d6f64696669657273404b68616e646c655f747970654668616e646c654776657273696f6e0101b04e7374616e646172645f696d6167655838697066733a2f2f7a623272686245664c54726a4857456d77676a374a413176334336715633627876694e6b7964634d68585764527653795746706f7274616c404864657369676e65724047736f6369616c73404676656e646f72404764656661756c7400536c6173745f7570646174655f61646472657373583901997855bb3dcd7905944406401f2ea74814a9b98b61a4db5410be635abd3e68ac1fdef1d5f4d10b3aaaaf236fb5b67ce4fe0280d1d4a875a14c76616c6964617465645f6279581c4da965a049dfd15ed1ee19fba6e2974a0b79fc416dd1796a1f97f5e14a696d6167655f686173685820443d88545e2d66f4a0187173e945d48518d2a6c46e714f605321be73d28f0fd9537374616e646172645f696d6167655f686173685820443d88545e2d66f4a0187173e945d48518d2a6c46e714f605321be73d28f0fd94b7376675f76657273696f6e46332e302e31354c6167726565645f7465726d735768747470733a2f2f68616e646c652e6d652f242f746f75546d6967726174655f7369675f72657175697265640045747269616c00446e736677004a707a5f656e61626c656401ffa300583901997855bb3dcd7905944406401f2ea74814a9b98b61a4db5410be635abd3e68ac1fdef1d5f4d10b3aaaaf236fb5b67ce4fe0280d1d4a875a101821a001344eea1581cf0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9aa14e000de14062656e6e795f6265747301028201d8184b4a62656e6e795f62657473a300581d71acbb75f1996b1f50a4a8719307695b6e280c6c3db0d50207c390b6dd01821a003b1f82a1581cf0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9aa149000643b0616264657601028201d818590288d8799fab446e616d654624616264657645696d6167655838697066733a2f2f7a623272686d5751455658597a75664e5a69704e5431726d4d35664d45745133765563634b4554654d7174447067695778496d65646961547970654a696d6167652f6a706567426f6700496f675f6e756d626572004672617269747946636f6d6d6f6e466c656e677468054a63686172616374657273476c657474657273516e756d657269635f6d6f64696669657273404b68616e646c655f747970654668616e646c654776657273696f6e0101b04e7374616e646172645f696d6167655838697066733a2f2f7a623272686d5751455658597a75664e5a69704e5431726d4d35664d45745133765563634b4554654d717444706769577846706f7274616c404864657369676e65724047736f6369616c73404676656e646f72404764656661756c7400536c6173745f7570646174655f6164647265737358390138e0181fb5f9636167a15c36d0a61ba03c6eb01cee460c358ceadca6b71152a4f8498a8bcf409735fd4110eb0d9d673d23f92b477c0c2d904c76616c6964617465645f6279581c4da965a049dfd15ed1ee19fba6e2974a0b79fc416dd1796a1f97f5e14a696d6167655f686173685820dcda9e2713b9af40456dc74f075240f7dee3bd226986fd0ac492de3cc1c743d5537374616e646172645f696d6167655f686173685820dcda9e2713b9af40456dc74f075240f7dee3bd226986fd0ac492de3cc1c743d54b7376675f76657273696f6e46332e302e31354c6167726565645f7465726d735768747470733a2f2f68616e646c652e6d652f242f746f75546d6967726174655f7369675f72657175697265640045747269616c00446e736677004a707a5f656e61626c656401ffa30058390138e0181fb5f9636167a15c36d0a61ba03c6eb01cee460c358ceadca6b71152a4f8498a8bcf409735fd4110eb0d9d673d23f92b477c0c2d9001821a00129c92a1581cf0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9aa149000de140616264657601028201d81846456162646576a300581d71acbb75f1996b1f50a4a8719307695b6e280c6c3db0d50207c390b6dd01821a0041d4c6a1581cf0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9aa153000643b0776f6f647340686f736b796d6f6a6901028201d8185902e4d8799faf446e616d655024776f6f647340686f736b796d6f6a6945696d6167655838697066733a2f2f7a62327268576a68475a7161706d3554566d544b4148376675704b505847776a584532315a3441346371434a4e35544754496d65646961547970654a696d6167652f6a706567426f6700496f675f6e756d6265720046726172697479456261736963466c656e6774680f4a63686172616374657273476c657474657273516e756d657269635f6d6f64696669657273404b68616e646c655f747970654d6e66745f73756268616e646c654776657273696f6e014a7375625f72617269747946636f6d6d6f6e4a7375625f6c656e677468054e7375625f63686172616374657273476c657474657273557375625f6e756d657269635f6d6f646966696572734001b04e7374616e646172645f696d6167655838697066733a2f2f7a62327268576a68475a7161706d3554566d544b4148376675704b505847776a584532315a3441346371434a4e3554475446706f7274616c404864657369676e65724047736f6369616c73404676656e646f72404764656661756c7400536c6173745f7570646174655f616464726573735839016f37730d5888ad36ba476f513a2c44ce48a213f26df69c379f03a821ec0111ac0b2d26c6b8ba35b64ef1a054c1061e3eb26ff59098b3d2394c76616c6964617465645f6279581c4da965a049dfd15ed1ee19fba6e2974a0b79fc416dd1796a1f97f5e14a696d6167655f6861736858200163207663d9ee4a68818f0e28d3c311e5a1d7a681a70839b5414e853bd00d78537374616e646172645f696d6167655f6861736858200163207663d9ee4a68818f0e28d3c311e5a1d7a681a70839b5414e853bd00d784b7376675f76657273696f6e46332e302e31354c6167726565645f7465726d735768747470733a2f2f68616e646c652e6d652f242f746f75546d6967726174655f7369675f72657175697265640045747269616c00446e736677004a707a5f656e61626c656401ffa300583901d4a30993339766b694d6293eee4bb99b5c885bbd9498e2c9e20cddaf68cfb978cbcfabfef7a2838ed05d7018d0dcbe9b25be5ccdec239d8c01821a0013ed4aa1581cf0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9aa153000de140776f6f647340686f736b796d6f6a6901028201d818504f776f6f647340686f736b796d6f6a69a200581d61775789ca14333516ca6aba0f5ce0f2812f4f3580bdf07bf8664638e0011a2626c190021a000e82d2031a0a719279075820467692f1f288a9a287679ba3120c84ebc9b2b7614cfb9ff1864c3ba9119cbf6409a1581cf0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9aaa49000643b06162646576014e000643b062656e6e795f62657473014d000643b062656e6e79626574730151000643b0707379636869636d656469756d0153000643b0776f6f647340686f736b796d6f6a690149000de1406162646576014e000de14062656e6e795f62657473014d000de14062656e6e79626574730151000de140707379636869636d656469756d0153000de140776f6f647340686f736b796d6f6a69010b5820cfdbc43e53309e01c564eaeb65b73d87764c191b7fce1f7a9ddb14de1d88ca200d818258200c2e4df5950ec6a57b80d500b443891e311e678f8776eb3e1cfa890a70e7a70d0b0e81581c4da965a049dfd15ed1ee19fba6e2974a0b79fc416dd1796a1f97f5e110a200581d61775789ca14333516ca6aba0f5ce0f2812f4f3580bdf07bf8664638e0011a27b0ff8c128182582099a59f7873fd932635cc416464cb3b681bb1187eba3441d6d8c11bf4d3bb1ff400a300d9010282825820b62a7193927f47ef703ba99a06add1ee2d4d94853a16dcd68ad0f5d9baa185305840d01df5e9cfa549fbaf87cf994ffab676b542d54edfdde33421c008f3c6e6f0cbe171a365cdff86dab172e2afda29fbeabd5f7a12cd553e747cca79569d0f070282582045b4af9cb14acbfe28fd626f4d88c8a17807cfd5f78281d7c3e16a46f283d74458403e4514a8ce85202d2484bdbdf27c34b4bd4380eb1d10f7ef34adc632b1f1406e1d3920761cdf77f74130588ae1de8a4c24c4b3bb942bf4e38a4b5bdc4deed00901818200581c4da965a049dfd15ed1ee19fba6e2974a0b79fc416dd1796a1f97f5e10581840001d87a9f9fd8799f9fd8799f005f5840df3b0f69989cf7f02929c735a4e3f32fa07600f0ea7270b5316fff8c838a0aaf3f18149af6dafd6a25fe8a0f7603b6263fe553ed38bb17b3790e19ae6744987558401c80708fc8aed4d092d816ff5b3270a5afaf358754c290dfddcb88f326c3ebc7601fb21ad04a59d712d2ca9d43bb2a4734c0da06c6d9d422de90755659240248ffffd8799f005f584053e73e8363a670a4380c0176da51d8185a8d69e10ea79250765e57f5cf39b1c1b001e5ea95df403c3846b67fca8043c68b26eda026d528823bbbc74b014a1eb5584005a12045d2e668cd9e90459103c14c6f94a99e9134dacb2fb23a1a9345cec1b3f54da4cdb387e09b0fae43a00bc1d5ba56fd42c06442dd3995ebb72391783aebffffd8799f005f5840c7205b18b3e5e28bb58f615ab4a1b2b793a9ea7cbda36d9269a404615a4a2b12c4ea99ff0c65e607d0fcc5ac51ff42c4547a5999cbd68d98d7f68f2b92ff24cb5840ce9d0f2749fa461802edf1e92df809237900145e668c4523133a2fccfdd9231869ea3b13ce3c4cb0f7ba25e1d3b52d979d8cecc70e6028b8e613026513b63b02ffffd8799f005f5840c7660702d50dd0dac15622875e9ee3d089e634682dbf00d821c44ae32f0c77b6e115ad1fd6d37b3d1e0817004d90c76cbd26f6a49c08ac600142386220f592cb5840b362592f062cd0ed7b31975bd39d985417659f0d45c11d65fa58f8524ccc90987f711f2cb2b810a8158c7a0a5dbe2e086eceb66ea7640f7fcbe664af797338b9ffffff4d707379636869636d656469756d00ffd8799f9fd8799f005f5840df3b0f69989cf7f02929c735a4e3f32fa07600f0ea7270b5316fff8c838a0aaf3f18149af6dafd6a25fe8a0f7603b6263fe553ed38bb17b3790e19ae6744987558401c80708fc8aed4d092d816ff5b3270a5afaf358754c290dfddcb88f326c3ebc7601fb21ad04a59d712d2ca9d43bb2a4734c0da06c6d9d422de90755659240248ffffd8799f005f5840ac203c3dfff25a3ee29c58ebe71b453763c30710f09248dd107366e5d68b25cb2a5dda918240956a05bb50a23819e2fe173c28d47227cad94c0e9371a302887b5840de9d5ae35f18b12e1326d798624b889a712fb45aa46d6d8a0b0312aca50b099346d37d45e4f9954849f6ed0a78f5eb898cc699fe9756c7ce6bc070cc22369e67ffffd8799f005f5840a4fe6ac9ffd0174d500f8241e63342a1a490a3bc6a36967c1ad1b0db494fa5420caae32f558dc9a63d50a61e495fd5781e2a185449a18e7372dec93bdafcbeab584093b5ed145ff79b6b2d0692de442462f472977d2bdd28249857920a77de42ef7bc2a6182a6eb9da7dec020ef603dffdbdf9ebfee1e0d680312d7b0267ef67edceffffd8799f005f5840db3f72e5c9cef73fbb79a3a151b229bbde31f6285d2709aaf17baed2cecc71d8a5d8991f75b7424f0d405afca79e1c10644092916b1af830d3179c8d805a7d295840e586829636b6d8f93581981f3fc5ee6d789385f2988e127a31ceb1916c5c821cfa7a2ae102557fbd14f83df71eaef0a8f3b92f7b1cd27094f4e104b72ad61f24ffffd8799f005f58402c5ef7949672952ce56a965f70b23d18399a61fa50a14329032f703c2f26c42f85c09af929492a871e4fae32d9d5c36e352471cd659bcdb61de08f1722acc3b158400eb923b0cbd24df54401d998531feead35a47a99f4deed205de4af81120f9761d051e7b0d7cdf230a201f892052d9fa697b94dec911825b65a6d992770622079ffffff4962656e6e796265747300ffd8799f9fd8799f005f5840d19988e4dfa243f49fff2f82e9cb5ba5c0810157997f7d6df3859eef7ee0668e32d9df0c962ab4898acfb38ad6f906097e475d69c8fb34f0cdd1b727560231be5840ad2720899a8dcd4433df0fbe2c903b59059039c5ddb339c456a1795a7f9d45e55d9ca0812228a67816523aab1b881a11ddfc84353a8bd9acf4826953e3846918ffffd8799f005f58405fd2b0bdd49cf890337ec8215049010b5f8607c15e66b70dcf15a594945e9d2366d3258da49ddd817ef1fcf2f1958a4d3946102002ea51f8fd848cf48ae550f9584022aa75784fb6a0195d3a4d8c5447df73f416a150621350f18d9db41e2a6879863147c97b2c19c2d3565a39a3d58ce545f82b447aaa6c0692acd3007d0bc82f6bffffd8799f005f58409205764c16ad5d3efacc1d18edae9cca8a0b80a6c72302b5320ca3e6c5fd86e007cde098e6dc3c333c6e540ef7afbac96e87552b8a60f14aed6aaeb7e8865f635840604069473f426d669c8eac525208ae8b30cb299dd6666b18e8f2d0f71fe4d96d786be95172031cd77a4f1c76a71b52dbadc2bfd2e0de54de6516c8e08366507bffffd8799f005f5840666dd4fad99de2be7f8aa19c59d0c005f976de45584cdb5c32ec37182937d5636471b864d66024c8f973f45184d6cc76c3decae676bf675c1f79eb3a94fd76695840077a476358c9bce168bf7329ea55c678861d8451389d7d177b9c0b29553840e1b29d31d129fd0f247f797cca369e0cae6251fa200c3b560084cece9da5e93caeffffd8799f005f5840d4c1dd446dea5dd1b7af9b6e0d59dcf8bfb407a6f11d6a4f704cc90fe0fdf7ff6e8b5495a10c3adb9cbf946fe65b4af0ca766d295e70b258ad939c7064bb928458400eb923b0cbd24df54401d998531feead35a47a99f4deed205de4af81120f97610000000000000000000000000000000000000000000000000000000000000000ffffff4a62656e6e795f6265747300ffd8799f9fd8799f005f58404bddce9c11944b08292c62dcd825a9522fe0e43eb16b753a7cba7e8e148d9f5374d3ae0d65f6203fe10a43cdb2c21a8c14a792ab22650f1872ed9279f10327725840178d7758e17c36c1bb111685e54b43cfaeafeaaaa706fd84e30121afdeccf79214ccf75984a6ac5d96cbaeab5a81534448feca97a929cba09b3bd29c899f2145ffffd8799f005f5840869f5f45339b0de949305138c38bca52e1a97eb7b9927623fccfa12dcccee278c749815cf546465c8da07a5cac864709239ae169fd78088b4482b52647fb314c5840f7886d89bcd0c056f510e386b7b5c302fecd33e0e4f26c760775c0a4b3a3dcf56b555e7139f347eb5553c6e42df578aeec8c2f6054a3e74aa8912fddb0c6f736ffffd8799f005f5840eeac23cd4f997ff575c6f998b43d9640fc955969323d8a4a520e0cfee7a2b85101ee0d25e2b2acbdf15cc0ce84645de4cdc128bf7f877237970b4ec79bb0889758409e2483cf966f059c4ec1a0d50a4d1bd3a9f462f6224b158c96dc6dbb572e417369744067d9b599952d283fdcd3a9c020cc99273db633700c3fef95991ca9cdc3ffffd8799f005f58401c10e71ea9aa777bf19a9ea840afcd01bfbdca0a130b487a3054c317688b432b98328839313c6d98d695349a116e15ac31e44a6fa640a9c6c9ba4c48fbac37c558400d7c78015cab0041eb5b14983d386c06220728d28c86fce8264ce67676eb8a50e4f993d702874d76b1aa4dcf089b5532adce36d53af8ae675d943979c75224faffffd8799f005f5840edd33839c0c5044c16f6da48189daf4f45ea0187f898c7a13ac030aaaedf5791b0365f7a1248f1d63acd12c0de694b0d2944608e6960f6f8a2e4278de42df00158400eb923b0cbd24df54401d998531feead35a47a99f4deed205de4af81120f97610000000000000000000000000000000000000000000000000000000000000000ffffff45616264657600ffd8799f9fd8799f005f58404bddce9c11944b08292c62dcd825a9522fe0e43eb16b753a7cba7e8e148d9f5374d3ae0d65f6203fe10a43cdb2c21a8c14a792ab22650f1872ed9279f10327725840178d7758e17c36c1bb111685e54b43cfaeafeaaaa706fd84e30121afdeccf792926eb4a993f426f7c5736d5f472fb2ec25c9ab76fb5a92ffeea9d058be5ddcbdffffd8799f005f5840e1da92765a12425e800229bd8b39b666d04d9bd9c267717248478a1f20f965d5ea2fecdea4898e0ab369a4005a321139540c68fe0b6cc5ba75fcae9c93cc196a584091a0d08ae0fca8ae37fa0d99ddd4b87e3f5789d03e587e3d19a2f4a4c29d371e46cd34cca9e5dbd54e12628247fd6d2f856fce34a27c639363ecbb1219115cebffffd8799f005f5840b62186abc714bd090932471010f037bf51c8cdddb472839bbaea4cb563467b7c332dfb62716d9ae213ee1a9642a91ed4caad4978d41b034c2b856912c27fa83858401626c34ebdeafa21558b36e31e93f7b82e1bf281af6632cffa84c83233404e1c9280026c31023eae37ce8e549aa8b350bc377f3da5c9da651fd454740bc91482ffffd8799f005f584023ca7a4a1f7c6a6ce7c1b9fd677e193fa16fa575120847e84351a2dd72723af40a84b425aafb78788d65b73b41c14402308c936d8e6c18dd2d093cf9c04782ea58406403f293bfa78b9b5a76fb3b94b04dbdc79bc55975dbcfc08bf519b810916f2d7c2efe700f955d67648df43ab21878d3aab855b2758441b1b778334100dc098dffffd8799f005f584079644647dbef3763e1192b798de3833bba56c4770dda102fcbcd62930ae9e8e782152b171e3afb43cd10bd05a84e4d6b238acab5d2504524e623a32450f381865840ac7895773e3f8863419236417de3535d9e5ec0896316786bd104e708e6335ea60000000000000000000000000000000000000000000000000000000000000000ffffff4f776f6f647340686f736b796d6f6a6900ffffff821a002d97361a336f083ef5a11902d1a178386630666634386262623762626539643539613430663163653930653965396430666635303032656334386632333262343963613066623961a5782230303064653134303730373337393633363836393633366436353634363937353664ab646e616d656e24707379636869636d656469756d65696d6167657838697066733a2f2f7a623272685a4d73756b6837584257564e526d55714e6e554136744b5a5261634733515456413359573552477770315675696d65646961547970656a696d6167652f6a706567626f6700696f675f6e756d6265720066726172697479656261736963666c656e6774680d6a63686172616374657273676c657474657273716e756d657269635f6d6f64696669657273606b68616e646c655f747970656668616e646c656776657273696f6e01781a3030306465313430363236353665366537393632363537343733ab646e616d656a2462656e6e796265747365696d6167657838697066733a2f2f7a623272686e7770706751706a623177374c6e37467a4b5665464d61715475397948624564347735414355336b46725846696d65646961547970656a696d6167652f6a706567626f6700696f675f6e756d6265720066726172697479656261736963666c656e677468096a63686172616374657273676c657474657273716e756d657269635f6d6f64696669657273606b68616e646c655f747970656668616e646c656776657273696f6e01781c30303064653134303632363536653665373935663632363537343733ab646e616d656b2462656e6e795f6265747365696d6167657838697066733a2f2f7a623272686245664c54726a4857456d77676a374a413176334336715633627876694e6b7964634d685857645276537957696d65646961547970656a696d6167652f6a706567626f6700696f675f6e756d6265720066726172697479656261736963666c656e6774680a6a636861726163746572736f6c6574746572732c7370656369616c716e756d657269635f6d6f64696669657273606b68616e646c655f747970656668616e646c656776657273696f6e0172303030646531343036313632363436353736ab646e616d656624616264657665696d6167657838697066733a2f2f7a623272686d5751455658597a75664e5a69704e5431726d4d35664d45745133765563634b4554654d7174447067695778696d65646961547970656a696d6167652f6a706567626f6700696f675f6e756d626572006672617269747966636f6d6d6f6e666c656e677468056a63686172616374657273676c657474657273716e756d657269635f6d6f64696669657273606b68616e646c655f747970656668616e646c656776657273696f6e0178263030306465313430373736663666363437333430363836663733366237393664366636613639af646e616d657024776f6f647340686f736b796d6f6a6965696d6167657838697066733a2f2f7a62327268576a68475a7161706d3554566d544b4148376675704b505847776a584532315a3441346371434a4e35544754696d65646961547970656a696d6167652f6a706567626f6700696f675f6e756d6265720066726172697479656261736963666c656e6774680f6a63686172616374657273676c657474657273716e756d657269635f6d6f64696669657273606b68616e646c655f747970656d6e66745f73756268616e646c656776657273696f6e016a7375625f72617269747966636f6d6d6f6e6a7375625f6c656e677468056e7375625f63686172616374657273676c657474657273757375625f6e756d657269635f6d6f6469666965727360'
        }
    ]
};

describe('processBlock Tests', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });
    beforeEach(() => {
        repo.rollBackToGenesis();
    });

    it('Lambda Scanner should process block correctly', () => {
        jest.spyOn(HandlesRepository.prototype, 'getMetrics').mockReturnValue({});

        storeInstance.addValueToIndexedSet(IndexNames.MINT, 'handle_root@handle_settings', JSON.stringify({ created_slot: 152760685, metadata: { '721': { f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a: { '000de14068616e646c655f726f6f744068616e646c655f73657474696e6773': { name: '$handle_root@handle_settings', image: 'ipfs://zb2rhoVwidYR7oPwLwTcTPWZNkTHBiw3FrY4yjow5NuJUDieT', mediaType: 'image/jpeg', og: 0, og_number: 0, rarity: 'basic', length: 27, characters: 'letters,special', numeric_modifiers: '', handle_type: 'nft_subhandle', version: 1, sub_rarity: 'basic', sub_length: 11, sub_characters: 'letters,special', sub_numeric_modifiers: '' } } } }, txHash: 'fc359e1177bc38f261e8ee5408c0f1f608cadd23f06bb6cad33a3acb049bf01c' }));

        ogmiosService.Internal.processBlock(block as unknown as BlockPraos);

        const handle = repo.getHandle('papagoose');
        // expect(handle).toEqual(null);

        // Correct UTxO
        expect(handle?.utxo).toBe('fe40d980c3105c956c2cf29567966b6cafcab0e150e856ec6d4969a4d08aa353#0');
        // test metadata
        expect(handle?.image).toBe('ipfs://zb2rhn73PodzBd6ahhusERJ3e42ZNx6e9VrD6KgzfmbPFfyB3');
        // test datum
        expect(handle?.last_update_address).toBe('0x011ec952cbca7b8f6d7068d1e4ff29f1017f8dc76e9f93eb1e3a70b679c251da0507cacfe8146dcb7e528c695a35824bc1d005880b234a507f');

        const handle2 = repo.getHandle('bigirishlion');
        // Correct UTxO
        expect(handle2?.utxo).toBe('fe40d980c3105c956c2cf29567966b6cafcab0e150e856ec6d4969a4d08aa353#3');
        // test metadata
        expect(handle2?.image).toBe('ipfs://zb2rhn73PodzBd6ahhusERJ3e42ZNx6e9VrD6KgzfmbPFfyB3');
        // test datum
        expect(handle2?.last_update_address).toBe(undefined);
    });

    it('Should scan current block', () => {});
});
