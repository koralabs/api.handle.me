import { AssetNameLabel, Logger } from '@koralabs/kora-labs-common';
import OgmiosService from '../ogmios.service';

const policyId = 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a';
const address = 'addr_test1qzdzhdzf9ud8k2suzryvcdl78l3tfesnwp962vcuh99k8z834r3hjynmsy2cxpc04a6dkqxcsr29qfl7v9cmrd5mm89qfmc97q';

const createRepoMock = () =>
    ({
        getMetrics: jest.fn().mockReturnValue({ currentSlot: 0 }),
        addMintDataFromUTxOs: jest.fn(),
        getHandle: jest.fn(),
        removeHandle: jest.fn(),
        addUTxOAndMintData: jest.fn(),
        removeUTxOs: jest.fn()
    }) as any;

const createBlock = (transactions: any[], slot = 100) =>
    ({
        type: 'praos',
        id: `block_${slot}`,
        slot,
        height: slot,
        transactions
    }) as any;

describe('OgmiosService processBlock unit tests', () => {
    const originalNetwork = process.env.NETWORK;

    beforeEach(() => {
        process.env.NETWORK = 'preview';
    });

    afterEach(() => {
        process.env.NETWORK = originalNetwork;
        jest.restoreAllMocks();
    });

    it('sorts 222 UTxOs first and removes spent inputs', () => {
        const repo = createRepoMock();
        const service = new OgmiosService(repo);

        const alpha100 = `${AssetNameLabel.LBL_100}${Buffer.from('alpha').toString('hex')}`;
        const beta222 = `${AssetNameLabel.LBL_222}${Buffer.from('beta').toString('hex')}`;
        const txId = 'tx_sort';

        const block = createBlock([
            {
                id: txId,
                inputs: [
                    {
                        transaction: { id: 'spent_tx' },
                        index: 0
                    }
                ],
                outputs: [
                    {
                        address,
                        value: {
                            ada: { lovelace: 1n },
                            [policyId]: { [alpha100]: 1n }
                        }
                    },
                    {
                        address,
                        value: {
                            ada: { lovelace: 1n },
                            [policyId]: { [beta222]: 1n }
                        }
                    }
                ],
                mint: {
                    [policyId]: {
                        [alpha100]: 1n,
                        [beta222]: 1n
                    }
                },
                metadata: {
                    labels: {
                        721: {
                            json: {
                                [policyId]: {
                                    [alpha100]: { image: 'ipfs://alpha' },
                                    [beta222]: { image: 'ipfs://beta' }
                                }
                            }
                        }
                    }
                }
            }
        ]);

        service.Internal.processBlock(block);

        expect(repo.addMintDataFromUTxOs).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({ id: `${txId}#0` }),
                expect.objectContaining({ id: `${txId}#1` })
            ])
        );
        expect(repo.addUTxOAndMintData).toHaveBeenNthCalledWith(1, expect.objectContaining({ id: `${txId}#1` }), true);
        expect(repo.addUTxOAndMintData).toHaveBeenNthCalledWith(2, expect.objectContaining({ id: `${txId}#0` }), true);
        expect(repo.removeUTxOs).toHaveBeenCalledWith(['spent_tx#0']);
    });

    it('removes handle on non-CIP67 burn', () => {
        const repo = createRepoMock();
        const service = new OgmiosService(repo);
        const burnedHandle = { name: 'burnme' };
        const burnHex = Buffer.from('burnme').toString('hex');
        repo.getHandle.mockReturnValue(burnedHandle);

        const block = createBlock([
            {
                id: 'tx_burn',
                inputs: [],
                outputs: [],
                mint: {
                    [policyId]: {
                        [burnHex]: -1n
                    }
                },
                metadata: undefined
            }
        ]);

        service.Internal.processBlock(block);

        expect(repo.getHandle).toHaveBeenCalledWith('burnme');
        expect(repo.removeHandle).toHaveBeenCalledWith(burnedHandle);
    });

    it('ignores CIP67-100 burn from handle removal path', () => {
        const repo = createRepoMock();
        const service = new OgmiosService(repo);
        const cip67Hundred = `${AssetNameLabel.LBL_100}${Buffer.from('nonowner').toString('hex')}`;

        const block = createBlock([
            {
                id: 'tx_burn_100',
                inputs: [],
                outputs: [],
                mint: {
                    [policyId]: {
                        [cip67Hundred]: -1n
                    }
                },
                metadata: undefined
            }
        ]);

        service.Internal.processBlock(block);

        expect(repo.getHandle).not.toHaveBeenCalled();
        expect(repo.removeHandle).not.toHaveBeenCalled();
    });

    it('logs datum decoding errors and still processes UTxO', () => {
        const repo = createRepoMock();
        const service = new OgmiosService(repo);
        const loggerSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());
        const circularDatum: any = {};
        circularDatum.self = circularDatum;
        const assetName = Buffer.from('datumtest').toString('hex');

        const block = createBlock([
            {
                id: 'tx_datum',
                inputs: [],
                outputs: [
                    {
                        address,
                        datum: circularDatum,
                        value: {
                            ada: { lovelace: 1n },
                            [policyId]: { [assetName]: 1n }
                        }
                    }
                ],
                mint: {
                    [policyId]: {
                        [assetName]: 1n
                    }
                },
                metadata: undefined
            }
        ]);

        service.Internal.processBlock(block);

        expect(loggerSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                event: 'processBlock.decodingDatum'
            })
        );
        expect(repo.addUTxOAndMintData).toHaveBeenCalledWith(expect.objectContaining({ id: 'tx_datum#0', datum: undefined }), true);
    });

    it('uses repo currentSlot fallback and handles missing tx fields', () => {
        const repo = createRepoMock();
        repo.getMetrics.mockReturnValue({ currentSlot: 77 });
        const service = new OgmiosService(repo);
        const assetName = Buffer.from('fallbackslot').toString('hex');

        const block = createBlock(
            [
                undefined,
                {
                    id: 'tx_sparse',
                    inputs: [],
                    outputs: [
                        {
                            address,
                            value: {
                                ada: { lovelace: 1n },
                                [policyId]: { [assetName]: 1n }
                            },
                            metadata: undefined,
                            script: {
                                language: 'plutus:v2',
                                cbor: '4e4d0100'
                            }
                        },
                        {
                            address
                        }
                    ]
                }
            ] as any,
            null as any
        );

        service.Internal.processBlock(block);

        expect(repo.addUTxOAndMintData).toHaveBeenCalledWith(
            expect.objectContaining({
                id: 'tx_sparse#0',
                slot: 77,
                datum: undefined,
                script: { type: 'plutus_v2', cbor: '4e4d0100' },
                mint: []
            }),
            true
        );
        expect(repo.removeUTxOs).toHaveBeenCalledWith([]);
    });

    it('falls back to slot zero and empty transaction list when data is missing', () => {
        const repo = createRepoMock();
        repo.getMetrics.mockReturnValue({});
        const service = new OgmiosService(repo);

        service.Internal.processBlock(createBlock(undefined as any, null as any));
        service.Internal.processBlock(createBlock([undefined] as any, null as any));

        expect(repo.addMintDataFromUTxOs).toHaveBeenCalledWith([]);
    });

    it('keeps non-222 ordering branch and skips burns when handle no longer exists', () => {
        const repo = createRepoMock();
        repo.getHandle.mockReturnValue(undefined);
        const service = new OgmiosService(repo);
        const first = Buffer.from('first').toString('hex');
        const second = Buffer.from('second').toString('hex');
        const burnHex = Buffer.from('missingburn').toString('hex');

        const block = createBlock([
            {
                id: 'tx_non_222',
                outputs: [
                    {
                        address,
                        value: {
                            ada: { lovelace: 1n },
                            [policyId]: { [first]: 1n }
                        }
                    },
                    {
                        address,
                        value: {
                            ada: { lovelace: 1n },
                            [policyId]: { [second]: 1n }
                        }
                    }
                ],
                mint: {
                    [policyId]: {
                        [first]: 1n,
                        [second]: 1n,
                        [burnHex]: -1n
                    }
                },
                inputs: []
            }
        ]);

        service.Internal.processBlock(block);

        expect(repo.addUTxOAndMintData).toHaveBeenCalledTimes(2);
        expect(repo.removeHandle).not.toHaveBeenCalled();
    });

    it('preserves metadata entries without version labels', () => {
        const repo = createRepoMock();
        const service = new OgmiosService(repo);
        const alpha = Buffer.from('alpha_without_version').toString('hex');

        const block = createBlock([
            {
                id: 'tx_no_version',
                inputs: [],
                outputs: [
                    {
                        address,
                        value: {
                            ada: { lovelace: 1n },
                            [policyId]: { [alpha]: 1n }
                        }
                    }
                ],
                mint: {
                    [policyId]: {
                        [alpha]: 1n
                    }
                },
                metadata: {
                    labels: {
                        721: {
                            json: {
                                [policyId]: {
                                    [alpha]: { image: 'ipfs://alpha' }
                                }
                            }
                        }
                    }
                }
            }
        ]);

        service.Internal.processBlock(block);

        expect(repo.addUTxOAndMintData).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: {
                    '721': {
                        [policyId]: {
                            [alpha]: { image: 'ipfs://alpha' }
                        }
                    }
                }
            }),
            true
        );
    });
});
