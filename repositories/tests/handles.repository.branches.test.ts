import * as common from '@koralabs/kora-labs-common';
import { AssetNameLabel, decodeAddress, EMPTY, IndexNames, Logger } from '@koralabs/kora-labs-common';
import * as crypto from 'crypto';
import * as config from '../../config';
import * as ogmiosUtils from '../../services/ogmios/utils';
import * as ipfs from '../../utils/ipfs';
import { HandlesRepository, RewoundHandle, UpdatedOwnerHandle } from '../handlesRepository';

const policy = 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a';
const address = 'addr_test1qzdzhdzf9ud8k2suzryvcdl78l3tfesnwp962vcuh99k8z834r3hjynmsy2cxpc04a6dkqxcsr29qfl7v9cmrd5mm89qfmc97q';
const holder = 'stake_test1urc63cmezfacz9vrqu867axmqrvgp4zsyllxzud3k6danjsn0dn70';

const buildStoreMock = () => {
    const sets = new Map<string, Set<string>>();
    const setKey = (index: IndexNames, key: string | number) => `${index}:${key}`;

    return {
        initialize: jest.fn().mockResolvedValue(undefined),
        destroy: jest.fn(),
        rollBackToGenesis: jest.fn(),
        getMetrics: jest.fn().mockReturnValue({}),
        setMetrics: jest.fn(),
        getHashFromIndex: jest.fn(),
        setHashOnIndex: jest.fn(),
        removeKeyFromIndex: jest.fn(),
        addValueToOrderedSet: jest.fn(),
        removeValuesFromOrderedSet: jest.fn(),
        getValuesFromIndexedSet: jest.fn((index: IndexNames, key: string | number) => sets.get(setKey(index, key))),
        addValueToIndexedSet: jest.fn((index: IndexNames, key: string | number, value: string) => {
            const k = setKey(index, key);
            const existing = sets.get(k) ?? new Set<string>();
            existing.add(value);
            sets.set(k, existing);
        }),
        removeValueFromIndexedSet: jest.fn((index: IndexNames, key: string | number, value: string) => {
            const k = setKey(index, key);
            const existing = sets.get(k) ?? new Set<string>();
            existing.delete(value);
            sets.set(k, existing);
        }),
        getValuesFromOrderedSet: jest.fn().mockReturnValue([]),
        getKeysFromIndex: jest.fn().mockReturnValue([]),
        pipeline: jest.fn((commands: () => void) => {
            commands();
            return [];
        })
    } as any;
};

const buildUtxo = (assetName: string, slot: number, datum?: string) =>
    ({
        id: `tx_${slot}#0`,
        tx_id: `tx_${slot}`,
        index: 0,
        slot,
        address,
        lovelace: 1,
        datum,
        handles: [[policy, [assetName]]],
        mint: [[policy, [assetName]]],
        metadata: { '721': { [policy]: {} } },
        blockHash: 'hash',
        blockNum: 1
    }) as any;

describe('HandlesRepository branch tests', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('decrements amount and re-saves handle when burning one of many tokens', () => {
        const repo = new HandlesRepository(buildStoreMock());
        const saveSpy = jest.spyOn(repo, 'save').mockImplementation(jest.fn());

        const handle = {
            name: 'alpha',
            amount: 2,
            holder,
            rarity: 'basic',
            og_number: 0,
            characters: 'letters',
            resolved_addresses: { ada: address },
            numeric_modifiers: '',
            length: 5
        } as any;

        repo.removeHandle(handle);

        expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'alpha', amount: 1 }), handle);
    });

    it('updates default index and holder set in updateHolder', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        const holderMap = new Map<string, Set<string>>();

        const handle = {
            name: 'alpha',
            holder,
            default: true
        } as any;
        repo.updateHolder(handle, holderMap as any);

        expect(store.addValueToIndexedSet).toHaveBeenCalledWith(IndexNames.DEFAULT_HANDLE, holder, 'alpha');
        expect(store.addValueToIndexedSet).toHaveBeenCalledWith(IndexNames.HOLDER, holder, 'alpha');
        expect(store.addValueToOrderedSet).toHaveBeenCalledWith(IndexNames.HOLDER_COUNT, 1, holder);
        expect(holderMap.get(holder)?.has('alpha')).toBe(true);
        expect((handle as any).default).toBeUndefined();

        const removeDefault = {
            name: 'alpha',
            holder,
            default: false
        } as any;
        repo.updateHolder(removeDefault);
        expect(store.removeValueFromIndexedSet).toHaveBeenCalledWith(IndexNames.DEFAULT_HANDLE, holder, 'alpha');

        repo.Internal.removeHandleFromHolder(holder, 'alpha');
        expect(store.removeValuesFromOrderedSet).toHaveBeenCalledWith(IndexNames.HOLDER_COUNT, holder);
    });

    it('logs unknown asset labels while still saving handle state', () => {
        const repo = new HandlesRepository(buildStoreMock());
        const saveSpy = jest.spyOn(repo, 'save').mockImplementation(jest.fn());
        const updateHolderSpy = jest.spyOn(repo, 'updateHolder').mockImplementation(jest.fn());
        const loggerSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());
        const existing = repo.Internal.buildHandle({
            name: 'alpha',
            hex: Buffer.from('alpha').toString('hex'),
            policy,
            utxo: 'old_tx#0',
            resolved_addresses: { ada: address },
            updated_slot_number: 10
        });

        jest.spyOn(ogmiosUtils, 'getHandleNameFromAssetName').mockReturnValue({
            name: 'alpha',
            ownerTokenHex: Buffer.from('alpha').toString('hex'),
            isCip67: true,
            assetLabel: '99999999' as any
        });

        const mintingData = new Map<string, any[]>([['alpha', [{ created_slot: 1, metadata: {}, txHash: 'tx' }]]]);
        repo.updateHandleIndexes(
            buildUtxo('asset', 100),
            mintingData as any,
            new Map([['alpha', existing]]),
            new Map([[holder, new Set(['alpha'])]])
        );

        expect(loggerSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                event: 'processScannedHandleInfo.unknownAssetName'
            })
        );
        expect(updateHolderSpy).toHaveBeenCalled();
        expect(saveSpy).toHaveBeenCalled();
    });

    it('updates created slot from earlier mint and increments amount on possible double mint', () => {
        const repo = new HandlesRepository(buildStoreMock());
        const saveSpy = jest.spyOn(repo, 'save').mockImplementation(jest.fn());
        jest.spyOn(repo, 'updateHolder').mockImplementation(jest.fn());
        const loggerSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());
        const handleHex = `${AssetNameLabel.LBL_222}${Buffer.from('alpha').toString('hex')}`;
        const existing = repo.Internal.buildHandle({
            name: 'alpha',
            hex: handleHex,
            policy,
            utxo: 'old_tx#0',
            amount: 1,
            resolved_addresses: { ada: address },
            created_slot_number: 500,
            updated_slot_number: 1000
        });

        jest.spyOn(ogmiosUtils, 'getHandleNameFromAssetName').mockReturnValue({
            name: 'alpha',
            ownerTokenHex: handleHex,
            isCip67: true,
            assetLabel: AssetNameLabel.LBL_222
        });

        const mintingData = new Map<string, any[]>([['alpha', [{ created_slot: 500, metadata: {}, txHash: 'tx' }]]]);
        repo.updateHandleIndexes(
            {
                ...buildUtxo(handleHex, 400),
                mint: [[policy, [handleHex]]]
            } as any,
            mintingData as any,
            new Map([['alpha', existing]]),
            new Map([[holder, new Set(['alpha'])]])
        );

        repo.updateHandleIndexes(
            {
                ...buildUtxo(handleHex, 1200),
                mint: [[policy, [handleHex]]]
            } as any,
            mintingData as any,
            new Map([['alpha', existing]]),
            new Map([[holder, new Set(['alpha'])]])
        );

        expect(saveSpy).toHaveBeenNthCalledWith(
            1,
            expect.objectContaining({
                name: 'alpha',
                created_slot_number: 400,
                updated_slot_number: 1000
            }),
            existing
        );
        expect(saveSpy).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                name: 'alpha',
                amount: 2
            }),
            existing
        );
        expect(loggerSpy).toHaveBeenCalledWith(expect.objectContaining({ event: 'saveHandleUpdate.utxoAlreadyExists' }));
    });

    it('logs and exits early when subhandle settings token has no datum', () => {
        const repo = new HandlesRepository(buildStoreMock());
        const saveSpy = jest.spyOn(repo, 'save').mockImplementation(jest.fn());
        const loggerSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());

        jest.spyOn(ogmiosUtils, 'getHandleNameFromAssetName').mockReturnValue({
            name: 'tiny@root',
            ownerTokenHex: Buffer.from('tiny@root').toString('hex'),
            isCip67: true,
            assetLabel: AssetNameLabel.LBL_001
        });

        const mintingData = new Map<string, any[]>([['tiny@root', [{ created_slot: 1, metadata: {}, txHash: 'tx' }]]]);
        repo.updateHandleIndexes(buildUtxo('asset001', 90, undefined), mintingData as any, new Map(), new Map());

        expect(loggerSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                event: 'processScannedHandleInfo.subHandle.noDatum'
            })
        );
        expect(saveSpy).not.toHaveBeenCalled();
    });

    it('applies virtual subhandle resolved addresses from datum payload', () => {
        const repo = new HandlesRepository(buildStoreMock());
        const saveSpy = jest.spyOn(repo, 'save').mockImplementation(jest.fn());
        jest.spyOn(repo, 'updateHolder').mockImplementation(jest.fn());
        const ownerTokenHex = `${AssetNameLabel.LBL_000}${Buffer.from('tiny@root').toString('hex')}`;
        const adaHex = `0x${decodeAddress(address)}`;

        jest.spyOn(ogmiosUtils, 'getHandleNameFromAssetName').mockReturnValue({
            name: 'tiny@root',
            ownerTokenHex,
            isCip67: true,
            assetLabel: AssetNameLabel.LBL_000
        });
        jest.spyOn(repo, 'buildPersonalizationData').mockReturnValue({
            nftAttributes: null,
            projectAttributes: {
                resolved_addresses: {
                    ada: adaHex,
                    btc: 'bc1qdemo',
                    eth: '0xabc'
                },
                virtual: {
                    expires_time: 123,
                    public_mint: 1
                }
            } as any
        });

        repo.updateHandleIndexes(
            {
                ...buildUtxo(ownerTokenHex, 100, 'd87980'),
                mint: [[policy, [ownerTokenHex]]]
            } as any,
            new Map([['tiny@root', [{ created_slot: 1, metadata: {}, txHash: 'tx' } as any]]]),
            new Map(),
            new Map()
        );

        expect(saveSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'tiny@root',
                handle_type: 'virtual_subhandle',
                resolved_addresses: expect.objectContaining({
                    ada: expect.stringMatching(/^addr/),
                    btc: 'bc1qdemo',
                    eth: '0xabc'
                }),
                virtual: {
                    expires_time: 123,
                    public_mint: true
                }
            }),
            undefined
        );
    });

    it('keeps has_datum true while hiding datum payload when datum endpoint is disabled', () => {
        const repo = new HandlesRepository(buildStoreMock());
        const saveSpy = jest.spyOn(repo, 'save').mockImplementation(jest.fn());
        jest.spyOn(repo, 'updateHolder').mockImplementation(jest.fn());
        jest.spyOn(config, 'isDatumEndpointEnabled').mockReturnValue(false);
        const assetHex = Buffer.from('alpha').toString('hex');

        jest.spyOn(ogmiosUtils, 'getHandleNameFromAssetName').mockReturnValue({
            name: 'alpha',
            ownerTokenHex: assetHex,
            isCip67: false,
            assetLabel: null as any
        });

        repo.updateHandleIndexes(
            {
                ...buildUtxo(assetHex, 110, 'd87980'),
                script: {
                    type: 'PlutusScriptV2',
                    cbor: 'a247'
                },
                mint: [[policy, [assetHex]]]
            } as any,
            new Map([['alpha', [{ created_slot: 1, metadata: {}, txHash: 'tx' } as any]]]),
            new Map(),
            new Map()
        );

        expect(saveSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                name: 'alpha',
                has_datum: true,
                datum: undefined,
                script: {
                    type: 'PlutusScriptV2',
                    cbor: 'a247'
                }
            }),
            undefined
        );
    });

    it('normalizes mint data from block utxos before index updates', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        const alphaHex = Buffer.from('alpha').toString('hex');
        const betaHex = Buffer.from('beta').toString('hex');
        const alpha100 = `${AssetNameLabel.LBL_100}${alphaHex}`;
        const alpha222 = `${AssetNameLabel.LBL_222}${alphaHex}`;
        const beta222 = `${AssetNameLabel.LBL_222}${betaHex}`;

        repo.addMintDataFromUTxOs([
            {
                ...buildUtxo(alpha100, 100),
                mint: [[policy, [alpha100]]]
            } as any,
            {
                ...buildUtxo(alpha222, 100),
                mint: [[policy, [alpha222]]]
            } as any,
            {
                ...buildUtxo(beta222, 101),
                mint: [[policy, { [beta222]: 1n }]]
            } as any
        ]);

        const indexed = store.getValuesFromIndexedSet(IndexNames.MINT, 'alpha') as Set<string>;
        expect(indexed.size).toBe(1);
        expect(Array.from(indexed).map((value) => JSON.parse(value))).toEqual([
            expect.objectContaining({
                created_slot: 100,
                txHash: 'tx_100'
            })
        ]);

        const indexedBeta = store.getValuesFromIndexedSet(IndexNames.MINT, 'beta') as Set<string>;
        expect(indexedBeta.size).toBe(1);
        expect(Array.from(indexedBeta).map((value) => JSON.parse(value))).toEqual([
            expect.objectContaining({
                created_slot: 101,
                txHash: 'tx_101'
            })
        ]);
    });

    it('throws hard when mint data cannot be found for update', () => {
        const repo = new HandlesRepository(buildStoreMock());
        jest.spyOn(ogmiosUtils, 'getHandleNameFromAssetName').mockReturnValue({
            name: 'missing',
            ownerTokenHex: `${AssetNameLabel.LBL_222}${Buffer.from('missing').toString('hex')}`,
            isCip67: true,
            assetLabel: AssetNameLabel.LBL_100
        });

        expect(() => {
            repo.updateHandleIndexes(
                {
                    ...buildUtxo('asset100', 90, 'd87980'),
                    id: 'missing_tx#0',
                    mint: [[policy, ['asset100']]]
                } as any,
                new Map(),
                new Map(),
                new Map()
            );
        }).toThrow('No minting data found for missing while processing missing_tx#0');

        try {
            repo.updateHandleIndexes(
                {
                    ...buildUtxo('asset100', 90, 'd87980'),
                    id: 'missing_tx#0',
                    mint: [[policy, ['asset100']]]
                } as any,
                new Map(),
                new Map(),
                new Map()
            );
        } catch (error: any) {
            expect(error.message).toContain('mintingContext=');
            expect(error.message).toContain('"handleName":"missing"');
        }
    });

    it('returns EMPTY fallbacks for holder/hash/address lookups without matches', () => {
        const repo = new HandlesRepository(buildStoreMock());

        expect(repo.getHandlesByHolderAddresses(['invalid-address'])).toEqual([EMPTY, EMPTY]);
        expect(repo.getHandlesByStakeKeyHashes(['deadbeef'])).toEqual([EMPTY]);
        expect(repo.getHandlesByPaymentKeyHashes(['deadbeef'])).toEqual([EMPTY]);
        expect(repo.getHandlesByAddresses(['addr_test1_missing'])).toEqual([EMPTY]);
    });

    it('returns holder/hash lookup matches when decoded address hash exists', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        const decoded = decodeAddress(address)!;
        const hashedStakeKey = crypto.createHash('md5').update(decoded, 'hex').digest('hex');
        store.addValueToIndexedSet(IndexNames.HASH_OF_STAKE_KEY_HASH, hashedStakeKey, 'alpha');

        expect(repo.getHandlesByHolderAddresses([address])).toEqual([EMPTY, 'alpha']);
    });

    it('returns handle datum only when handle and datum exist', () => {
        const repo = new HandlesRepository(buildStoreMock());
        const getHandleSpy = jest.spyOn(repo, 'getHandle');

        getHandleSpy.mockReturnValueOnce(null);
        expect(() => repo.getHandleDatumByName('missing')).toThrow('Not found');

        getHandleSpy.mockReturnValueOnce({ utxo: 'tx#0', has_datum: false } as any);
        expect(repo.getHandleDatumByName('nodata')).toBeNull();

        getHandleSpy.mockReturnValueOnce({ utxo: 'tx#1', has_datum: true, datum: 'd87980' } as any);
        expect(repo.getHandleDatumByName('hasdata')).toBe('d87980');
    });

    it('returns only existing subhandles and root handle names', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        jest.spyOn(repo, 'getHandle').mockImplementation((name: string) => (name === 'alpha@root' ? ({ name } as any) : null));
        store.getValuesFromIndexedSet.mockImplementation((index: IndexNames, key: string | number) => {
            if (index === IndexNames.SUBHANDLE && key === 'root') {
                return new Set(['alpha@root', 'missing@root']);
            }
            return undefined;
        });
        store.getKeysFromIndex.mockReturnValue(['root']);

        expect(repo.getSubHandlesByRootHandle('root')).toEqual([{ name: 'alpha@root' }]);
        expect(repo.getRootHandleNames()).toEqual(['root']);
    });

    it('short-circuits default-handle selection for large holder sets', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        const names = new Set<string>(Array.from({ length: 1001 }, (_, i) => `h${i}`));
        store.getHashFromIndex.mockReturnValue({ name: 'h0' });

        expect(repo.getDefaultHandle(names as any)).toEqual({ name: 'h0' });
        expect(store.pipeline).not.toHaveBeenCalled();
    });

    it('evaluates caught-up status and HTTP code from metrics', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);

        store.getMetrics.mockReturnValue({
            lastSlot: 120,
            currentSlot: 50,
            currentBlockHash: 'tip',
            tipBlockHash: 'tip'
        });
        expect(repo.isCaughtUp()).toBe(true);
        expect(repo.currentHttpStatus()).toBe(200);

        store.getMetrics.mockReturnValue({
            lastSlot: 500,
            currentSlot: 50,
            currentBlockHash: 'block',
            tipBlockHash: 'tip'
        });
        expect(repo.isCaughtUp()).toBe(false);
        expect(repo.currentHttpStatus()).toBe(202);
    });

    it('falls back to default metrics and returns null for missing handle records', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);

        store.getMetrics.mockReturnValue({});
        store.getHashFromIndex.mockReturnValue(undefined);

        expect(repo.isCaughtUp()).toBe(false);
        expect(repo.currentHttpStatus()).toBe(202);
        expect(repo.getHandle('missing')).toBeNull();
    });

    it('returns undefined for empty holder sets and honors manual default handle', () => {
        const repo = new HandlesRepository(buildStoreMock());

        expect(repo.buildHolder(new Set(), holder)).toBeUndefined();
        expect(repo.buildHolder(new Set(['alpha']), holder, 'manual')).toEqual(
            expect.objectContaining({
                default_handle: 'manual',
                manually_set: true,
                total_handles: 1
            })
        );
    });

    it('builds holder default from computed default-handle when manual default is omitted', () => {
        const repo = new HandlesRepository(buildStoreMock());
        jest.spyOn(repo, 'getDefaultHandle').mockReturnValue({ name: 'auto' } as any);

        expect(repo.buildHolder(new Set(['alpha']), holder)).toEqual(
            expect.objectContaining({
                default_handle: 'auto',
                manually_set: false
            })
        );
    });

    it('returns handle by hex only when normalized hex matches', () => {
        const repo = new HandlesRepository(buildStoreMock());
        jest.spyOn(repo, 'getHandle').mockReturnValueOnce({ hex: 'deadbeef' } as any).mockReturnValueOnce({
            hex: '74657374'
        } as any);

        expect(repo.getHandleByHex('74657374')).toBeNull();
        expect(repo.getHandleByHex('74657374')).toEqual({ hex: '74657374' });
    });

    it('returns UTxOs for slot and builds holder from stored sets', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);

        store.getValuesFromOrderedSet.mockReturnValueOnce(undefined).mockReturnValueOnce(['tx#0', 'tx#1']);
        store.getHashFromIndex
            .mockReturnValueOnce({ id: 'tx#0' })
            .mockReturnValueOnce({ id: 'tx#1' })
            .mockReturnValueOnce({ resolved_addresses: { ada: address } });
        store.getValuesFromIndexedSet.mockImplementation((index: IndexNames, key: string | number) => {
            if (index === IndexNames.HOLDER && key === holder) return new Set(['alpha']);
            if (index === IndexNames.DEFAULT_HANDLE && key === holder) return new Set(['alpha']);
            return undefined;
        });

        expect(repo.getUTxOs(10)).toEqual([]);
        expect(repo.getUTxOs(11)).toEqual([{ id: 'tx#0' }, { id: 'tx#1' }]);
        expect(repo.getHolder(holder)).toEqual(
            expect.objectContaining({
                address: holder,
                default_handle: 'alpha',
                handles: ['alpha']
            })
        );
    });

    it('returns empty search results when indexed filter set has no entries', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        store.getValuesFromIndexedSet.mockReturnValue(undefined);

        expect(
            repo.search(
                { page: 1, handlesPerPage: 10, sort: 'asc' } as any,
                { characters: 'letters' } as any,
                true
            )
        ).toEqual({ searchTotal: 0, handles: [] });
    });

    it('matches search terms against CIP67 222 and 000 prefixed hex strings', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        store.getKeysFromIndex.mockReturnValue(['alpha']);
        const hex = Buffer.from('alpha').toString('hex');

        expect(
            repo.search(
                { page: 1, handlesPerPage: 10, sort: 'asc' } as any,
                { search: `${AssetNameLabel.LBL_222}${hex}` } as any,
                true
            ).handles
        ).toEqual(['alpha']);
        expect(
            repo.search(
                { page: 1, handlesPerPage: 10, sort: 'asc' } as any,
                { search: `${AssetNameLabel.LBL_000}${hex}` } as any,
                true
            ).handles
        ).toEqual(['alpha']);
    });

    it('returns empty holder-address filter results when holder set is missing', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        store.getValuesFromIndexedSet.mockImplementation(() => undefined);

        expect(
            repo.search(
                { page: 1, handlesPerPage: 10, sort: 'asc' } as any,
                { holder_address: holder } as any,
                true
            )
        ).toEqual({ searchTotal: 0, handles: [] });
    });

    it('handles length-range search with sparse indexed length buckets', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        store.getValuesFromIndexedSet.mockImplementation((index: IndexNames, key: string | number) => {
            if (index === IndexNames.LENGTH && key === 1) return undefined;
            if (index === IndexNames.LENGTH && key === 2) return new Set(['alpha']);
            if (index === IndexNames.PERSONALIZED) return new Set(['alpha']);
            if (index === IndexNames.OG) return new Set(['alpha']);
            return undefined;
        });

        expect(
            repo.search(
                { page: 1, handlesPerPage: 10, sort: 'asc' } as any,
                { length: '1-2', personalized: true, og: true } as any,
                true
            )
        ).toEqual({ searchTotal: 1, handles: ['alpha'] });
    });

    it('covers random and descending search sort branches', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        store.getKeysFromIndex.mockReturnValue(['beta', 'alpha']);
        jest.spyOn(Math, 'random').mockReturnValue(0.2);

        const randomResult = repo.search({ page: 1, handlesPerPage: 2, sort: 'random' } as any);
        const descResult = repo.search({ page: 1, handlesPerPage: 2, sort: 'desc' } as any);

        expect(randomResult.searchTotal).toBe(2);
        expect(descResult.searchTotal).toBe(2);
    });

    it('removes root index for subhandle burns and skips nameless assets', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        const handle = repo.Internal.buildHandle({
            name: 'tiny@root',
            hex: Buffer.from('tiny@root').toString('hex'),
            policy,
            resolved_addresses: { ada: address },
            updated_slot_number: 10
        });
        handle.holder = holder;
        handle.amount = 1;

        repo.removeHandle(handle);
        expect(store.removeValueFromIndexedSet).toHaveBeenCalledWith(IndexNames.SUBHANDLE, 'root', 'tiny@root');

        const saveSpy = jest.spyOn(repo, 'save').mockImplementation(jest.fn());
        repo.updateHandleIndexes(
            {
                ...buildUtxo('', 99),
                handles: [[policy, ['']]],
                mint: [[policy, ['']]]
            } as any,
            new Map([['ignored', [{ created_slot: 1, metadata: {}, txHash: 'tx' } as any]]]),
            new Map(),
            new Map()
        );
        expect(saveSpy).not.toHaveBeenCalled();
    });

    it('uses mint index fallback from store when minting map is omitted', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        const name = 'alpha';
        const assetHex = Buffer.from(name).toString('hex');
        const mintFromStore = {
            created_slot: 1,
            metadata: {},
            txHash: 'mint_tx'
        };
        store.addValueToIndexedSet(IndexNames.MINT, name, JSON.stringify(mintFromStore));
        jest.spyOn(repo, 'updateHolder').mockImplementation(jest.fn());
        const saveSpy = jest.spyOn(repo, 'save').mockImplementation(jest.fn());

        repo.updateHandleIndexes(
            {
                ...buildUtxo(assetHex, 30),
                handles: [[policy, [assetHex]]],
                mint: [[policy, [assetHex]]]
            } as any
        );

        expect(saveSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'alpha' }), undefined);
    });

    it('buildMintingDataFromUTxO supports missing mint shape and store fallback for missing mint records', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        const alphaHex = `${AssetNameLabel.LBL_222}${Buffer.from('alpha').toString('hex')}`;
        store.pipeline.mockReturnValue([undefined]);

        const mintingData = repo.buildMintingDataFromUTxO({
            ...buildUtxo(alphaHex, 50),
            handles: [[policy, [alphaHex]]],
            mint: [[policy, null as any]]
        } as any);

        expect(mintingData.get('alpha')).toEqual([]);
    });

    it('aggregates repeated mint records in addMintDataFromUTxOs', () => {
        const repo = new HandlesRepository(buildStoreMock());
        const addMintDataSpy = jest.spyOn(repo, 'addMintData').mockImplementation(jest.fn());
        const alphaHex = `${AssetNameLabel.LBL_222}${Buffer.from('alpha').toString('hex')}`;

        const mintData = repo.addMintDataFromUTxOs([
            {
                ...buildUtxo(alphaHex, 90),
                mint: [[policy, { [alphaHex]: 1n, '': 1n }]]
            } as any,
            {
                ...buildUtxo(alphaHex, 91),
                mint: [[policy, { [alphaHex]: 1n }]]
            } as any
        ]);

        const savedMap = addMintDataSpy.mock.calls[0][0] as Map<string, any[]>;
        expect(savedMap.get('alpha')?.length).toBe(2);
        expect(mintData.get('alpha')?.length).toBe(2);
    });

    it('pipelines addMintData writes', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        const mintData = new Map([
            ['alpha', [{ created_slot: 1, metadata: {}, txHash: 'tx_1' } as any]],
            ['beta', [{ created_slot: 2, metadata: {}, txHash: 'tx_2' } as any]]
        ]);

        repo.addMintData(mintData as any);

        expect(store.pipeline).toHaveBeenCalledTimes(1);
        expect(store.addValueToIndexedSet).toHaveBeenCalledTimes(2);
    });

    it('passes through store starting point requests', async () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        const point = { slot: 123, id: 'hash_123' };
        store.getStartingPoint = jest.fn().mockResolvedValue(point);

        await expect(repo.getStartingPoint({} as any, true)).resolves.toEqual(point);
        expect(store.getStartingPoint).toHaveBeenCalledWith({}, true);
    });

    it('uses default getStartingPoint failed flag when omitted', async () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        const point = { slot: 321, id: 'hash_321' };
        store.getStartingPoint = jest.fn().mockResolvedValue(point);

        await expect(repo.getStartingPoint({} as any)).resolves.toEqual(point);
        expect(store.getStartingPoint).toHaveBeenCalledWith({}, false);
    });

    it('builds personalization from datum links and preserves defaults when datum is missing', async () => {
        const repo = new HandlesRepository(buildStoreMock());
        const decodeSpy = jest.spyOn(ipfs, 'decodeCborFromIPFSFile').mockImplementation(async (cid: string) => {
            if (cid === 'portal') return { website: 'https://example.com' };
            if (cid === 'designer') return { name: 'design' };
            if (cid === 'socials') return { x: '@handle' };
            return undefined;
        });
        const base = { validated_by: '', trial: true, nsfw: true } as any;

        await expect(repo.Internal.buildPersonalization({ personalization: base, personalizationDatum: null as any })).resolves.toEqual(base);

        await expect(
            repo.Internal.buildPersonalization({
                personalization: base,
                personalizationDatum: {
                    portal: 'ipfs://portal',
                    designer: 'ipfs://designer',
                    socials: 'ipfs://socials',
                    validated_by: 'validator',
                    trial: false,
                    nsfw: false
                } as any
            })
        ).resolves.toEqual(
            expect.objectContaining({
                validated_by: 'validator',
                trial: false,
                nsfw: false,
                portal: { website: 'https://example.com' },
                designer: { name: 'design' },
                socials: { x: '@handle' }
            })
        );
        expect(decodeSpy).toHaveBeenCalledTimes(3);
    });

    it('skips non-ipfs personalization links when enriching data', async () => {
        const repo = new HandlesRepository(buildStoreMock());
        const decodeSpy = jest.spyOn(ipfs, 'decodeCborFromIPFSFile').mockImplementation(async () => ({ ignored: true }));

        await expect(
            repo.Internal.buildPersonalization({
                personalization: { validated_by: '', trial: true, nsfw: true } as any,
                personalizationDatum: {
                    portal: 'https://portal.example',
                    designer: 'https://designer.example',
                    socials: 'https://social.example',
                    validated_by: 'validator',
                    trial: false,
                    nsfw: false
                } as any
            })
        ).resolves.toEqual(
            expect.objectContaining({
                validated_by: 'validator',
                trial: false,
                nsfw: false
            })
        );
        expect(decodeSpy).not.toHaveBeenCalled();
    });

    it('returns empty arrays for internal length and slot sort helpers with empty input', () => {
        const repo = new HandlesRepository(buildStoreMock());

        expect(repo.Internal.sortedByLength([] as any)).toEqual([]);
        expect(repo.Internal.sortByCreatedSlotNumber([] as any)).toEqual([]);
    });

    it('buildHandle validates required fields and name/hex consistency', () => {
        const repo = new HandlesRepository(buildStoreMock());

        expect(() => repo.Internal.buildHandle({} as any)).toThrow('required properties');
        expect(() => repo.Internal.buildHandle({ name: 'alpha', hex: 'deadbeef', policy } as any)).toThrow('invalid hex for Handle name');
    });

    it('returns empty settings object for invalid subhandle-settings datum', () => {
        const repo = new HandlesRepository(buildStoreMock());
        const loggerSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());

        expect(repo.parseSubHandleSettingsDatum('not-valid-cbor')).toEqual({});
        expect(loggerSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                event: 'handleRepository.parseSubHandleSettingsDatum'
            })
        );
    });

    it('builds personalization from reference utxo when available', async () => {
        const repo = new HandlesRepository(buildStoreMock());
        jest.spyOn(console, 'log').mockImplementation(jest.fn());
        jest.spyOn(repo, 'getUTxO').mockReturnValue({ datum: 'd87980' } as any);
        jest.spyOn(repo, 'buildPersonalizationData').mockReturnValue({
            nftAttributes: null,
            projectAttributes: { validated_by: 'validator', trial: false, nsfw: false } as any
        });
        const buildPersonalizationSpy = jest.spyOn(repo as any, '_buildPersonalization').mockResolvedValue({ validated_by: 'validator' });

        const personalization = await repo.getPersonalization({
            reference_utxo: 'some_ref#0',
            personalization: { validated_by: '', trial: true, nsfw: true }
        } as any);

        expect(buildPersonalizationSpy).toHaveBeenCalled();
        expect(personalization).toEqual({ validated_by: 'validator' });
    });

    it('covers lifecycle wrapper methods and handle wrapper constructors', async () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);

        const baseHandle = { name: 'alpha', hex: Buffer.from('alpha').toString('hex'), policy } as any;
        expect(new RewoundHandle(baseHandle)).toEqual(expect.objectContaining({ name: 'alpha' }));
        expect(new UpdatedOwnerHandle(baseHandle)).toEqual(expect.objectContaining({ name: 'alpha' }));

        await expect(repo.initialize()).resolves.toBe(repo);
        repo.destroy();
        repo.setMetrics({ currentSlot: 12 });
        repo.rollBackToGenesis();
        store.getHashFromIndex.mockReturnValue({ id: 'tx#0' });
        expect(repo.getUTxO('tx#0')).toEqual({ id: 'tx#0' });
        expect(repo.getMetrics()).toEqual({});

        expect(store.initialize).toHaveBeenCalled();
        expect(store.destroy).toHaveBeenCalled();
        expect(store.setMetrics).toHaveBeenCalledWith({ currentSlot: 12 });
        expect(store.rollBackToGenesis).toHaveBeenCalled();
    });

    it('searches by slot pagination and hydrates defaults', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        const getDefaultSpy = jest.spyOn(repo, 'getDefaultHandle').mockReturnValue({ name: 'fallback' } as any);
        store.getKeysFromIndex.mockReturnValue(['alpha', 'beta']);
        store.getMetrics.mockReturnValue({
            firstSlot: 1,
            lastSlot: 500000,
            handleCount: 2
        });
        store.getValuesFromOrderedSet.mockImplementation((index: IndexNames) => {
            if (index === IndexNames.SLOT) return ['alpha', 'beta'];
            return [];
        });

        let callCount = 0;
        store.pipeline.mockImplementation((commands: () => void) => {
            callCount += 1;
            commands();
            if (callCount === 1) {
                return [
                    { name: 'alpha', hex: Buffer.from('alpha').toString('hex'), holder, resolved_addresses: { ada: address } },
                    { name: 'beta', hex: Buffer.from('beta').toString('hex'), holder, resolved_addresses: { ada: address } }
                ];
            }
            if (callCount === 2) return [undefined];
            if (callCount === 3) return [new Set(['alpha', 'beta'])];
            return [];
        });

        const result = repo.search({ page: 1, handlesPerPage: 2, sort: 'asc', slotNumber: 10 } as any);

        expect(result.searchTotal).toBe(2);
        expect((result.handles[0] as any).default_in_wallet).toBe('fallback');
        expect((result.handles[1] as any).default_in_wallet).toBe('fallback');
        expect(getDefaultSpy).toHaveBeenCalledTimes(1);
        expect(store.getValuesFromOrderedSet).toHaveBeenCalledWith(
            IndexNames.SLOT,
            0,
            expect.objectContaining({
                start: 10,
                end: 50010,
                orderBy: 'ASC'
            })
        );
    });

    it('builds index info from UTxO and conditionally updates indexes', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        const assetHex = Buffer.from('alpha').toString('hex');
        let callCount = 0;
        store.pipeline.mockImplementation((commands: () => void) => {
            callCount += 1;
            commands();
            if (callCount === 1) return [new Set(['alpha']), { name: 'alpha' }];
            return [];
        });
        const mintingSpy = jest.spyOn(repo, 'buildMintingDataFromUTxO').mockReturnValue(new Map([['alpha', [{ created_slot: 1, metadata: {}, txHash: 'tx' } as any]]]));

        const info = repo.buildIndexInfoFromUTxO({
            ...buildUtxo(assetHex, 42),
            handles: [[policy, [assetHex]]]
        } as any);

        expect(mintingSpy).toHaveBeenCalled();
        expect(info.holders.get(holder)).toEqual(new Set(['alpha']));
        expect(info.handles.get('alpha')).toEqual({ name: 'alpha' });

        const addUTxOSpy = jest.spyOn(repo, 'addUTxO').mockImplementation(jest.fn());
        const addMintSpy = jest.spyOn(repo, 'addMintData').mockImplementation(jest.fn());
        const updateSpy = jest.spyOn(repo, 'updateHandleIndexes').mockImplementation(jest.fn());
        jest.spyOn(repo, 'buildIndexInfoFromUTxO').mockReturnValue({
            mintingData: new Map(),
            holders: new Map(),
            handles: new Map()
        } as any);

        repo.addUTxOsWithMintData([buildUtxo(assetHex, 43) as any]);
        repo.addUTxOsWithMintDataAndUpdateIndexes([buildUtxo(assetHex, 44) as any]);

        expect(addUTxOSpy).toHaveBeenCalledTimes(2);
        expect(addMintSpy).toHaveBeenCalledTimes(2);
        expect(updateSpy).toHaveBeenCalledTimes(1);
    });

    it('adds mint data once when processing a UTxO batch', () => {
        const repo = new HandlesRepository(buildStoreMock());
        const assetHex = Buffer.from('alpha').toString('hex');
        const utxoA = buildUtxo(assetHex, 43) as any;
        const utxoB = buildUtxo(assetHex, 44) as any;
        const mintingData = new Map([['alpha', [{ created_slot: 1, metadata: {}, txHash: 'tx' } as any]]]);
        const addMintFromUtxosSpy = jest.spyOn(repo, 'addMintDataFromUTxOs').mockReturnValue(mintingData);
        const addUTxOSpy = jest.spyOn(repo, 'addUTxO').mockImplementation(jest.fn());
        const updateIndexesSpy = jest.spyOn(repo, 'updateHandleIndexes').mockImplementation(jest.fn());
        const buildInfoSpy = jest.spyOn(repo, 'buildIndexInfoFromUTxO').mockReturnValue({
            mintingData: new Map(),
            holders: new Map(),
            handles: new Map()
        } as any);

        repo.addUTxOsWithMintDataAndUpdateIndexes([utxoA, utxoB]);

        expect(addMintFromUtxosSpy).toHaveBeenCalledWith([utxoA, utxoB]);
        expect(buildInfoSpy).toHaveBeenNthCalledWith(1, utxoA, mintingData);
        expect(buildInfoSpy).toHaveBeenNthCalledWith(2, utxoB, mintingData);
        expect(addUTxOSpy).toHaveBeenCalledTimes(2);
        expect(updateIndexesSpy).toHaveBeenCalledTimes(2);
    });

    it('falls back to per-utxo mint lookup for non-mint batch updates', () => {
        const repo = new HandlesRepository(buildStoreMock());
        const assetHex = Buffer.from('alpha').toString('hex');
        const utxo = { ...buildUtxo(assetHex, 45), mint: [] } as any;
        const mintingData = new Map([['alpha', [{ created_slot: 1, metadata: {}, txHash: 'tx' } as any]]]);
        const buildInfoSpy = jest.spyOn(repo, 'buildIndexInfoFromUTxO').mockReturnValue({
            mintingData: new Map(),
            holders: new Map(),
            handles: new Map()
        } as any);
        jest.spyOn(repo, 'updateHandleIndexes').mockImplementation(jest.fn());

        repo.addUTxOsWithMintDataAndUpdateIndexes([utxo], mintingData);

        expect(buildInfoSpy).toHaveBeenCalledWith(utxo, undefined);
    });

    it('adds and removes UTxOs through slot and hash indexes', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        const utxo = buildUtxo(Buffer.from('alpha').toString('hex'), 50);

        repo.addUTxO(utxo);
        repo.removeUTxOs(['tx_a#0', 'tx_b#1']);

        expect(store.addValueToOrderedSet).toHaveBeenCalledWith(IndexNames.UTXO_SLOT, 50, utxo.id);
        expect(store.setHashOnIndex).toHaveBeenCalledWith(IndexNames.UTXO, utxo.id, utxo);
        expect(store.removeValuesFromOrderedSet).toHaveBeenCalledWith(IndexNames.UTXO_SLOT, 'tx_a#0');
        expect(store.removeKeyFromIndex).toHaveBeenCalledWith(IndexNames.UTXO, 'tx_b#1');
    });

    it('builds all holders from paginated holder indexes', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        store.getValuesFromOrderedSet.mockReturnValueOnce([holder]);

        let callCount = 0;
        store.pipeline.mockImplementation((commands: () => void) => {
            callCount += 1;
            commands();
            if (callCount === 1) return [new Set(['alpha'])];
            if (callCount === 2) return [new Set(['alpha'])];
            if (callCount === 3) return [{ resolved_addresses: { ada: address } }];
            return [];
        });

        const holders = repo.getAllHolders({ pagination: { page: 1, recordsPerPage: 1, sort: 'desc' } as any });

        expect(holders).toHaveLength(1);
        expect(holders[0]).toEqual(
            expect.objectContaining({
                address: holder,
                default_handle: 'alpha',
                total_handles: 1
            })
        );
        expect(store.getValuesFromOrderedSet).toHaveBeenNthCalledWith(
            1,
            IndexNames.HOLDER_COUNT,
            0,
            expect.objectContaining({
                orderBy: 'desc',
                limit: { offset: 0, count: 1 }
            })
        );
    });

    it('builds holder summaries without returning handle arrays when includeHandles is false', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        store.getValuesFromOrderedSet.mockReturnValueOnce([holder]);
        (store as any).getScoresFromOrderedSet = jest.fn().mockReturnValue([1001]);

        let callCount = 0;
        store.pipeline.mockImplementation((commands: () => void) => {
            callCount += 1;
            commands();
            if (callCount === 1) return [new Set()];
            if (callCount === 2) return [new Set(['alpha'])];
            if (callCount === 3) return [{ resolved_addresses: { ada: address } }];
            return [];
        });

        const holders = repo.getAllHolders({
            pagination: { page: 1, recordsPerPage: 1, sort: 'desc' } as any,
            includeHandles: false
        });

        expect(holders).toEqual([
            expect.objectContaining({
                address: holder,
                default_handle: 'alpha',
                total_handles: 1001,
                handles: []
            })
        ]);
        expect((store as any).getScoresFromOrderedSet).toHaveBeenCalledWith(IndexNames.HOLDER_COUNT, [holder]);
        expect(store.getValuesFromIndexedSet).toHaveBeenCalledWith(
            IndexNames.HOLDER,
            holder,
            expect.objectContaining({ limit: { offset: 0, count: 1 } })
        );
    });

    it('returns no holders when holder count ranking is empty', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        store.getValuesFromOrderedSet.mockReturnValueOnce([]);

        const holders = repo.getAllHolders({ pagination: { page: 1, recordsPerPage: 2, sort: 'desc' } as any });

        expect(holders).toEqual([]);
    });

    it('saves handles and maintains slot/address/payment/subhandle indexes', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        const name = 'tiny@root';
        const handle = repo.Internal.buildHandle({
            name,
            hex: Buffer.from(name).toString('hex'),
            policy,
            updated_slot_number: 123,
            resolved_addresses: { ada: address },
            image_hash: 'new_hash',
            standard_image_hash: 'old_hash',
            personalization: { validated_by: '', trial: true, nsfw: true, designer: { alias: 'd' } } as any
        });
        handle.holder = holder;
        handle.holder_type = 'wallet';

        const oldHandle = {
            ...handle,
            resolved_addresses: { ada: 'addr_test1qz8zyhdetz270qzfvkym38wx4wsqzx0m49urfu3wjkqsuchs8t4235v9t0x5grxm2hel388ypz0q3fng8k6am5hqzacq0fc746' }
        } as any;

        repo.save(handle, oldHandle);

        expect(store.setHashOnIndex).toHaveBeenCalledWith(IndexNames.HANDLE, name, handle);
        expect(store.addValueToIndexedSet).toHaveBeenCalledWith(IndexNames.SUBHANDLE, 'root', name);
        expect(store.removeValueFromIndexedSet).toHaveBeenCalledWith(IndexNames.ADDRESS, oldHandle.resolved_addresses.ada, name);
        expect(store.addValueToIndexedSet).toHaveBeenCalledWith(IndexNames.ADDRESS, address, name);
        expect(store.addValueToOrderedSet).toHaveBeenCalledWith(IndexNames.SLOT, 123, name);
    });

    it('selects default handle from OG and deterministic fallback sorters', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);

        store.pipeline.mockReturnValueOnce([
            { name: 'beta', og_number: 4, created_slot_number: 10 },
            { name: 'alpha', og_number: 1, created_slot_number: 9 }
        ]);
        expect(repo.getDefaultHandle(new Set(['alpha', 'beta']) as any)?.name).toBe('alpha');

        store.pipeline.mockReturnValueOnce([
            { name: 'zeta', og_number: 0, created_slot_number: 10 },
            { name: 'beta', og_number: 0, created_slot_number: 10 }
        ]);
        expect(repo.getDefaultHandle(new Set(['zeta', 'beta']) as any)?.name).toBe('beta');

        expect(repo.Internal.sortOGHandle([{ name: 'x', og_number: 5 }, { name: 'y', og_number: 2 }] as any)?.name).toBe('y');
        expect(repo.Internal.sortedByLength([{ name: 'long' }, { name: 'a' }] as any)).toEqual([{ name: 'a' }]);
        expect(repo.Internal.sortByCreatedSlotNumber([{ created_slot_number: 2 }, { created_slot_number: 1 }] as any)).toEqual([{ created_slot_number: 1 }]);
        expect(repo.Internal.sortAlphabetically([{ name: 'z' }, { name: 'a' }] as any)?.name).toBe('a');
    });

    it('buildPersonalizationData updates handle fields for valid datum payload', () => {
        const repo = new HandlesRepository(buildStoreMock());
        const handle = repo.Internal.buildHandle({
            name: 'alpha',
            hex: Buffer.from('alpha').toString('hex'),
            policy,
            resolved_addresses: { ada: address }
        } as any);
        jest.spyOn(common, 'decodeCborToJson').mockReturnValue({
            constructor_0: [
                {
                    name: 'alpha',
                    image: 'ipfs://img',
                    mediaType: 'image/svg+xml',
                    og: 0,
                    og_number: 9,
                    rarity: 'basic',
                    length: 5,
                    characters: 'letters',
                    numeric_modifiers: '',
                    version: 3
                },
                {},
                {
                    standard_image: 'ipfs://std',
                    default: true,
                    last_update_address: address,
                    validated_by: 'validator',
                    image_hash: 'img_hash',
                    standard_image_hash: 'std_hash',
                    svg_version: '2',
                    agreed_terms: 'terms',
                    migrate_sig_required: 1,
                    trial: 0,
                    nsfw: 1,
                    bg_image: 'bg',
                    bg_asset: 'asset',
                    pfp_image: 'pfp',
                    pfp_asset: 'pfp_asset',
                    original_address: address,
                    id_hash: '0x123',
                    pz_enabled: true,
                    last_edited_time: 100,
                    resolved_addresses: { ada: '0x00' }
                }
            ]
        } as any);

        const result = repo.buildPersonalizationData(handle, 'd87980');

        expect(result.nftAttributes?.og_number).toBe(9);
        expect(result.projectAttributes?.standard_image).toBe('ipfs://std');
        expect(handle.default).toBe(true);
        expect(handle.image).toBe('ipfs://img');
        expect(handle.standard_image_hash).toBe('std_hash');
        expect(handle.id_hash).toBe('0x123');
    });

    it('buildPersonalizationData logs invalid datum payloads and returns null objects', () => {
        const repo = new HandlesRepository(buildStoreMock());
        const loggerSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());
        const handle = repo.Internal.buildHandle({
            name: 'alpha',
            hex: Buffer.from('alpha').toString('hex'),
            policy,
            resolved_addresses: { ada: address }
        } as any);
        jest.spyOn(common, 'decodeCborToJson').mockReturnValue({ constructor_0: ['invalid'] } as any);

        const result = repo.buildPersonalizationData(handle, 'd87980');

        expect(result).toEqual({ nftAttributes: null, projectAttributes: null });
        expect(loggerSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                event: 'buildValidDatum.invalidMetadata'
            })
        );
    });

    it('parses valid subhandle settings datum shape', () => {
        const repo = new HandlesRepository(buildStoreMock());
        jest.spyOn(common, 'decodeCborToJson').mockReturnValue([
            [true, false, [[1, 2]], { bg_image: '' }, true],
            [false, true, [[3, 4]], { bg_image: 'x' }, false],
            100,
            1,
            5,
            'https://terms',
            false,
            'addr_test1'
        ] as any);

        expect(repo.parseSubHandleSettingsDatum('d87980')).toEqual({
            nft: {
                public_minting_enabled: true,
                pz_enabled: false,
                tier_pricing: [[1, 2]],
                default_styles: { bg_image: '' },
                save_original_address: true
            },
            virtual: {
                public_minting_enabled: false,
                pz_enabled: true,
                tier_pricing: [[3, 4]],
                default_styles: { bg_image: 'x' },
                save_original_address: false
            },
            buy_down_price: 100,
            buy_down_paid: 1,
            buy_down_percent: 5,
            agreed_terms: 'https://terms',
            migrate_sig_required: false,
            payment_address: 'addr_test1'
        });
    });
});
