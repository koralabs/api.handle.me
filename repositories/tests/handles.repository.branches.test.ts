import * as common from '@koralabs/kora-labs-common';
import { AssetNameLabel, decodeAddress, EMPTY, getSlotNumberFromDate, HandleType, IndexNames, LockedLambdaReason, Logger } from '@koralabs/kora-labs-common';
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
        count: jest.fn().mockReturnValue(0),
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

    it('normalizes holder key from resolved ADA address during updateHolder', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        const holderMap = new Map<string, Set<string>>([[holder, new Set<string>()]]);
        const staleHolder = 'legacy-holder-key';
        const handle = {
            name: 'alpha',
            holder: staleHolder,
            resolved_addresses: { ada: address }
        } as any;

        repo.updateHolder(handle, holderMap as any);

        expect(handle.holder).toBe(holder);
        expect(handle.holder_type).toBe('wallet');
        expect(store.addValueToIndexedSet).toHaveBeenCalledWith(IndexNames.HOLDER, holder, 'alpha');
        expect(store.addValueToIndexedSet).not.toHaveBeenCalledWith(IndexNames.HOLDER, staleHolder, 'alpha');
    });

    it('removes empty-string holder indexes when an existing handle holder is corrected', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        const name = 'alpha';
        const hex = `${AssetNameLabel.LBL_222}${Buffer.from(name).toString('hex')}`;
        const existing = repo.Internal.buildHandle({
            name,
            hex,
            policy,
            updated_slot_number: 10,
            resolved_addresses: { ada: address },
            holder: '',
            holder_type: ''
        });

        jest.spyOn(ogmiosUtils, 'getHandleNameFromAssetName').mockReturnValue({
            name,
            ownerTokenHex: hex,
            isCip67: true,
            assetLabel: AssetNameLabel.LBL_222
        });

        const mintingData = new Map<string, any[]>([[name, [{ created_slot: 1, metadata: {}, txHash: 'tx' }]]]);
        repo.updateHandleIndexes(
            buildUtxo(hex, 20),
            mintingData as any,
            new Map([[name, existing]]),
            new Map([[holder, new Set<string>()]])
        );

        expect(store.removeValueFromIndexedSet).toHaveBeenCalledWith(IndexNames.HOLDER, '', name);
        expect(store.removeValuesFromOrderedSet).toHaveBeenCalledWith(IndexNames.HOLDER_COUNT, '');
        expect(store.removeKeyFromIndex).toHaveBeenCalledWith(IndexNames.HOLDER, '');
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
                handle_type: HandleType.VIRTUAL_SUBHANDLE,
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
        expect(repo.getHandlesByStakeKeyHashes(['abcde', 'not-hex'])).toEqual([EMPTY, EMPTY]);
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
        const freshCurrentSlot = getSlotNumberFromDate(new Date(Date.now() - 60_000));

        store.getMetrics.mockReturnValue({
            lastSlot: freshCurrentSlot + 100,
            currentSlot: freshCurrentSlot,
            currentBlockHash: 'tip',
            tipBlockHash: 'tip'
        });
        expect(repo.isCaughtUp()).toBe(true);
        expect(repo.currentHttpStatus()).toBe(200);

        store.getMetrics.mockReturnValue({
            lastSlot: freshCurrentSlot + 500,
            currentSlot: freshCurrentSlot,
            currentBlockHash: 'block',
            tipBlockHash: 'tip'
        });
        expect(repo.isCaughtUp()).toBe(false);
        expect(repo.currentHttpStatus()).toBe(202);

        store.getMetrics.mockReturnValue({
            lastSlot: freshCurrentSlot + 100,
            currentSlot: freshCurrentSlot,
            currentBlockHash: 'tip',
            tipBlockHash: 'tip',
            lockLambdas: LockedLambdaReason.REINDEX
        });
        expect(repo.isCaughtUp()).toBe(true);
        expect(repo.currentHttpStatus()).toBe(202);

        store.getMetrics.mockReturnValue({
            lastSlot: freshCurrentSlot + 100,
            currentSlot: freshCurrentSlot,
            currentBlockHash: 'tip',
            tipBlockHash: 'tip',
            lockLambdas: LockedLambdaReason.ROLLBACK
        });
        expect(repo.isCaughtUp()).toBe(true);
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

    it('matches search terms against handle hex and CIP67-prefixed hex strings', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        const alphaHex = Buffer.from('alpha').toString('hex');
        const virtualHex = Buffer.from('virtual@root').toString('hex');
        const plainHex = Buffer.from('plain').toString('hex');
        store.getKeysFromIndex.mockReturnValue(['alpha', 'virtual@root', 'plain']);
        store.getHashFromIndex.mockImplementation((index: IndexNames, key: string | number) => {
            if (index !== IndexNames.HANDLE) return undefined;
            if (key === 'alpha') return { hex: `${AssetNameLabel.LBL_222}${alphaHex}` };
            if (key === 'virtual@root') return { hex: `${AssetNameLabel.LBL_000}${virtualHex}` };
            if (key === 'plain') return { hex: plainHex };
            return undefined;
        });
        store.pipeline.mockImplementation((commands: () => void) => {
            commands();
            return [
                { hex: `${AssetNameLabel.LBL_222}${alphaHex}` },
                { hex: `${AssetNameLabel.LBL_000}${virtualHex}` },
                { hex: plainHex }
            ];
        });

        expect(
            repo.search(
                { page: 1, handlesPerPage: 10, sort: 'asc' } as any,
                { search: `${AssetNameLabel.LBL_222}${alphaHex}` } as any,
                true
            ).handles
        ).toEqual(['alpha']);
        expect(
            repo.search(
                { page: 1, handlesPerPage: 10, sort: 'asc' } as any,
                { search: `${AssetNameLabel.LBL_000}${virtualHex}` } as any,
                true
            ).handles
        ).toEqual(['virtual@root']);
        expect(
            repo.search(
                { page: 1, handlesPerPage: 10, sort: 'asc' } as any,
                { search: AssetNameLabel.LBL_222 } as any,
                true
            )
        ).toEqual({ searchTotal: 1, handles: ['alpha'] });
        expect(
            repo.search(
                { page: 1, handlesPerPage: 10, sort: 'asc' } as any,
                { search: AssetNameLabel.LBL_000 } as any,
                true
            )
        ).toEqual({ searchTotal: 1, handles: ['virtual@root'] });
        expect(
            repo.search(
                { page: 1, handlesPerPage: 10, sort: 'asc' } as any,
                { search: plainHex.slice(2, 8) } as any,
                true
            )
        ).toEqual({ searchTotal: 1, handles: ['plain'] });
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

    it('intersects root_handle with other search filters and explicit handle lists', () => {
        // Feature: `root_handle` should reuse the subhandle index and compose with other `/handles` filters.
        // Failure mode: root filtering could be applied separately or not at all, leaking subhandles from other roots.
        // Negative control: changing the SUBHANDLE set below to omit `alpha@root` would make this expectation fail.
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        store.getValuesFromIndexedSet.mockImplementation((index: IndexNames, key: string | number) => {
            if (index === IndexNames.SUBHANDLE && key === 'root') return new Set(['alpha@root', 'beta@root']);
            if (index === IndexNames.CHARACTER && key === 'letters') return new Set(['alpha@root', 'gamma@elsewhere']);
            return undefined;
        });

        expect(
            repo.search(
                { page: 1, handlesPerPage: 10, sort: 'asc' } as any,
                { root_handle: 'root', characters: 'letters', handles: ['alpha@root', 'gamma@elsewhere'] } as any,
                true
            )
        ).toEqual({ searchTotal: 1, handles: ['alpha@root'] });
    });

    it('returns empty results when the requested root_handle has no indexed subhandles', () => {
        // Feature: `root_handle` should return no matches when that root has no subhandle index entries.
        // Failure mode: missing root indexes could accidentally fall back to an unfiltered handle scan.
        // Negative control: adding any handle name to the mocked SUBHANDLE set would change this result.
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        store.getValuesFromIndexedSet.mockImplementation((index: IndexNames) => {
            if (index === IndexNames.SUBHANDLE) return undefined;
            return new Set(['alpha']);
        });

        expect(
            repo.search(
                { page: 1, handlesPerPage: 10, sort: 'asc' } as any,
                { root_handle: 'missing-root' } as any,
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
        store.count.mockReturnValue(2);
        jest.spyOn(Math, 'random').mockReturnValue(0.2);

        const randomResult = repo.search({ page: 1, handlesPerPage: 2, sort: 'random' } as any);
        const descResult = repo.search({ page: 1, handlesPerPage: 2, sort: 'desc' } as any);

        expect(randomResult.searchTotal).toBe(2);
        expect(descResult.searchTotal).toBe(2);
        expect(store.getKeysFromIndex).toHaveBeenCalledWith(
            IndexNames.HANDLE,
            expect.objectContaining({
                orderBy: 'desc',
                limit: { offset: 0, count: 2 }
            })
        );
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

    it('ignores missing handle records when computing default handle', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);

        store.pipeline.mockReturnValueOnce([
            undefined,
            { name: 'beta', og_number: 0, created_slot_number: 10 },
            { name: 'alpha', og_number: 1, created_slot_number: 9 }
        ]);
        expect(repo.getDefaultHandle(new Set(['ghost', 'beta', 'alpha']) as any)?.name).toBe('alpha');

        store.pipeline.mockReturnValueOnce([undefined]);
        expect(repo.getDefaultHandle(new Set(['ghost']) as any)).toBeUndefined();
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

    it('uses unfiltered metrics pagination fast path for names-only and hydrated searches', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        store.getMetrics.mockReturnValue({ handleCount: 2 });
        store.getKeysFromIndex.mockImplementation((index: IndexNames, options?: any) => {
            if (index !== IndexNames.HANDLE) return [];
            if (!options) return ['alpha', 'beta'];
            return options.orderBy === 'desc' ? ['beta', 'alpha'] : ['alpha', 'beta'];
        });
        store.getValuesFromIndexedSet.mockImplementation((index: IndexNames, key: string | number) => {
            if (index === IndexNames.DEFAULT_HANDLE && key === holder) return new Set(['alpha']);
            if (index === IndexNames.HOLDER && key === holder) return new Set(['alpha', 'beta']);
            return undefined;
        });

        let pipelineCalls = 0;
        store.pipeline.mockImplementation((commands: () => void) => {
            pipelineCalls += 1;
            commands();
            if (pipelineCalls === 1) {
                return [
                    { name: 'beta', hex: Buffer.from('beta').toString('hex'), holder, resolved_addresses: { ada: address } },
                    { name: 'alpha', hex: Buffer.from('alpha').toString('hex'), holder, resolved_addresses: { ada: address } }
                ];
            }
            if (pipelineCalls === 2) return [new Set(['alpha'])];
            return [];
        });

        const hydrated = repo.search({ page: 1, handlesPerPage: 2, sort: 'desc' } as any, undefined, false);
        expect(hydrated.searchTotal).toBe(2);
        expect((hydrated.handles[0] as any).default_in_wallet).toBe('alpha');

        const namesOnly = repo.search({ page: 1, handlesPerPage: 2, sort: 'asc' } as any, undefined, true);
        expect(namesOnly).toEqual({ searchTotal: 2, handles: ['alpha', 'beta'] });
    });

    it('covers resolveDefaultHandlesByHolder explicit, single, and large holder-set branches', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        const largeSet = new Set(Array.from({ length: 1001 }, (_, i) => `h${i}`));

        let pipelineCalls = 0;
        store.pipeline.mockImplementation((commands: () => void) => {
            pipelineCalls += 1;
            commands();
            if (pipelineCalls === 1) return [new Set(['explicit']), undefined, undefined];
            if (pipelineCalls === 2) return [new Set(['solo']), largeSet];
            return [];
        });

        const defaults = (repo as any).resolveDefaultHandlesByHolder([
            { holder: 'h-explicit' },
            { holder: 'h-single' },
            { holder: 'h-large' }
        ]);

        expect(defaults.get('h-explicit')).toBe('explicit');
        expect(defaults.get('h-single')).toBe('solo');
        expect(defaults.get('h-large')).toBe('h0');
    });

    it('covers descending slot-window pagination branch in search', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        store.getKeysFromIndex.mockReturnValue(['alpha']);
        store.getMetrics.mockReturnValue({
            firstSlot: 1,
            lastSlot: 999999,
            handleCount: 2
        });
        store.getValuesFromOrderedSet.mockImplementation((index: IndexNames) => {
            if (index === IndexNames.SLOT) return ['alpha'];
            return [];
        });

        const result = repo.search({ page: 1, handlesPerPage: 2, sort: 'desc', slotNumber: 100 } as any, undefined, true);
        expect(result).toEqual({ searchTotal: 1, handles: ['alpha'] });
        expect(store.getValuesFromOrderedSet).toHaveBeenCalledWith(
            IndexNames.SLOT,
            0,
            expect.objectContaining({
                start: 100,
                end: -49900,
                orderBy: 'DESC'
            })
        );
    });

    it('aggregates duplicate handle entries when minting data is built from one UTxO', () => {
        const repo = new HandlesRepository(buildStoreMock());
        const alphaHex = `${AssetNameLabel.LBL_222}${Buffer.from('alpha').toString('hex')}`;

        const mintingData = repo.buildMintingDataFromUTxO({
            ...buildUtxo(alphaHex, 55),
            handles: [[policy, [alphaHex, alphaHex]]],
            mint: [[policy, [alphaHex]]]
        } as any);

        expect(mintingData.get('alpha')?.length).toBe(2);
    });

    it('falls back to holder set size and computed defaults when score lookups are non-finite', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        store.getValuesFromOrderedSet.mockReturnValueOnce([holder]);
        (store as any).getScoresFromOrderedSet = jest.fn().mockReturnValue([NaN]);
        store.getValuesFromIndexedSet.mockImplementation((index: IndexNames, key: string | number, options?: any) => {
            if (index === IndexNames.HOLDER && key === holder && !options) return new Set(['alpha', 'beta']);
            return undefined;
        });
        jest.spyOn(repo, 'getDefaultHandle').mockReturnValue({ name: 'beta' } as any);

        let pipelineCalls = 0;
        store.pipeline.mockImplementation((commands: () => void) => {
            pipelineCalls += 1;
            commands();
            if (pipelineCalls === 1) return [undefined];
            if (pipelineCalls === 2) return [new Set(['alpha'])];
            if (pipelineCalls === 3) return [new Set(['alpha', 'beta'])];
            if (pipelineCalls === 4) return [{ resolved_addresses: { ada: address } }];
            return [];
        });

        const holders = repo.getAllHolders({
            pagination: { page: 1, recordsPerPage: 1, sort: 'desc' } as any,
            includeHandles: false
        });

        expect(holders).toEqual([
            expect.objectContaining({
                address: holder,
                total_handles: 2,
                default_handle: 'beta',
                handles: []
            })
        ]);
    });

    it('backfills empty resolved addresses for subhandle-settings updates', () => {
        const repo = new HandlesRepository(buildStoreMock());
        const saveSpy = jest.spyOn(repo, 'save').mockImplementation(jest.fn());
        jest.spyOn(repo, 'updateHolder').mockImplementation(jest.fn());
        const name = 'tiny@root';
        const ownerTokenHex = `${AssetNameLabel.LBL_001}${Buffer.from(name).toString('hex')}`;
        const existingHandle = {
            name,
            hex: ownerTokenHex,
            policy,
            holder: '',
            holder_type: '',
            updated_slot_number: 1,
            created_slot_number: 1
        } as any;

        jest.spyOn(ogmiosUtils, 'getHandleNameFromAssetName').mockReturnValue({
            name,
            ownerTokenHex,
            isCip67: true,
            assetLabel: AssetNameLabel.LBL_001
        });

        repo.updateHandleIndexes(
            {
                ...buildUtxo(ownerTokenHex, 200, 'd87980'),
                mint: [[policy, [ownerTokenHex]]]
            } as any,
            new Map([[name, [{ created_slot: 1, metadata: {}, txHash: 'tx' } as any]]]),
            new Map([[name, existingHandle]]),
            new Map()
        );

        expect(saveSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                name,
                resolved_addresses: { ada: '' },
                subhandle_settings: expect.objectContaining({ utxo_id: 'tx_200#0' })
            }),
            existingHandle
        );
    });

    it('parses CIP67 222 subhandle personalization payloads', () => {
        const repo = new HandlesRepository(buildStoreMock());
        const name = 'tiny@root';
        const handle = repo.Internal.buildHandle({
            name,
            hex: `${AssetNameLabel.LBL_222}${Buffer.from(name).toString('hex')}`,
            policy,
            resolved_addresses: { ada: address }
        } as any);
        jest.spyOn(common, 'decodeCborToJson').mockReturnValue({
            constructor_0: [
                {
                    name,
                    image: 'ipfs://img',
                    mediaType: 'image/svg+xml',
                    og: 0,
                    og_number: 1,
                    rarity: 'basic',
                    length: 9,
                    characters: 'letters',
                    numeric_modifiers: '',
                    version: 1
                },
                {},
                {
                    standard_image: '',
                    default: 0,
                    last_update_address: '',
                    validated_by: '',
                    image_hash: '',
                    standard_image_hash: '',
                    svg_version: '',
                    agreed_terms: '',
                    migrate_sig_required: 0,
                    trial: 0,
                    nsfw: 0
                }
            ]
        } as any);

        const result = repo.buildPersonalizationData(handle, 'd87980');
        expect(result.nftAttributes).toEqual(expect.objectContaining({ name }));
    });

    it('restores the owner utxo when a stale nft subhandle shell later sees the 222 owner token', () => {
        const repo = new HandlesRepository(buildStoreMock());
        const saveSpy = jest.spyOn(repo, 'save').mockImplementation(jest.fn());
        const name = 'tiny@root';
        const ownerTokenHex = `${AssetNameLabel.LBL_222}${Buffer.from(name).toString('hex')}`;
        const brokenHandle = repo.Internal.buildHandle({
            name,
            hex: ownerTokenHex,
            policy,
            resolved_addresses: { ada: '' },
            updated_slot_number: 90,
            created_slot_number: 1
        } as any);
        brokenHandle.reference_utxo = 'tx_90#0';
        brokenHandle.utxo = '';

        jest.spyOn(ogmiosUtils, 'getHandleNameFromAssetName').mockReturnValue({
            name,
            ownerTokenHex,
            isCip67: true,
            assetLabel: AssetNameLabel.LBL_222
        });

        repo.updateHandleIndexes(
            buildUtxo(ownerTokenHex, 10),
            new Map([[name, [{ created_slot: 1, metadata: {}, txHash: 'tx' } as any]]]) as any,
            new Map([[name, brokenHandle]]),
            new Map()
        );

        expect(saveSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                name,
                utxo: 'tx_10#0',
                lovelace: 1,
                resolved_addresses: { ada: address }
            }),
            brokenHandle
        );
    });

    // Invariant: burning a handle must remove it from every secondary index that save() populated,
    // or searches filtered by handle_type / personalized / slot keep returning keys that no longer
    // exist in IndexNames.HANDLE. Failure mode: without the three added removals, a burned handle
    // shows up in /handles?handle_type=... and /handles?personalized=true queries.
    it('removeHandle cleans HANDLE_TYPE, both PERSONALIZED buckets, and SLOT on full burn', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        const handle = {
            name: 'alpha',
            amount: 1,
            holder,
            handle_type: HandleType.HANDLE,
            rarity: 'basic',
            og_number: 0,
            characters: 'letters',
            resolved_addresses: { ada: address },
            numeric_modifiers: '',
            length: 5,
            image_hash: '0xhash',
            standard_image_hash: '0xhash',
            personalization: undefined
        } as any;

        repo.removeHandle(handle);

        expect(store.removeValueFromIndexedSet).toHaveBeenCalledWith(IndexNames.HANDLE_TYPE, 'handle', 'alpha');
        // Both PERSONALIZED buckets are pruned so a stored bucket mismatch (legacy or drifted
        // state) can't leave an orphan on the opposite side.
        expect(store.removeValueFromIndexedSet).toHaveBeenCalledWith(IndexNames.PERSONALIZED, 0, 'alpha');
        expect(store.removeValueFromIndexedSet).toHaveBeenCalledWith(IndexNames.PERSONALIZED, 1, 'alpha');
        expect(store.removeValuesFromOrderedSet).toHaveBeenCalledWith(IndexNames.SLOT, 'alpha');
    });

    // Invariant: save() must remove the old HANDLE_TYPE bucket entry when a handle's type
    // changes (e.g. HANDLE → VIRTUAL_SUBHANDLE when an LBL_000 update arrives). Without this,
    // the old bucket retains a stale reference and searches filtered by the old handle_type
    // return a handle that no longer matches that type.
    it('save() removes old HANDLE_TYPE bucket when handle_type changes', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);

        const newHandle = repo.Internal.buildHandle({
            name: 'alpha',
            hex: Buffer.from('alpha').toString('hex'),
            policy,
            resolved_addresses: { ada: address },
            updated_slot_number: 100,
            handle_type: HandleType.VIRTUAL_SUBHANDLE
        });
        newHandle.holder = holder;
        newHandle.holder_type = 'wallet';

        const oldHandle = { ...newHandle, handle_type: HandleType.HANDLE } as any;

        repo.save(newHandle, oldHandle);

        expect(store.removeValueFromIndexedSet).toHaveBeenCalledWith(IndexNames.HANDLE_TYPE, 'handle', 'alpha');
        expect(store.addValueToIndexedSet).toHaveBeenCalledWith(IndexNames.HANDLE_TYPE, 'virtual_subhandle', 'alpha');
    });

    it('save() does not remove HANDLE_TYPE bucket when handle_type is unchanged', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);

        const newHandle = repo.Internal.buildHandle({
            name: 'alpha',
            hex: Buffer.from('alpha').toString('hex'),
            policy,
            resolved_addresses: { ada: address },
            updated_slot_number: 100,
            handle_type: HandleType.HANDLE
        });
        newHandle.holder = holder;
        newHandle.holder_type = 'wallet';

        repo.save(newHandle, { ...newHandle } as any);

        const typeRemovals = (store.removeValueFromIndexedSet as jest.Mock).mock.calls.filter(
            (call) => call[0] === IndexNames.HANDLE_TYPE
        );
        expect(typeRemovals).toHaveLength(0);
    });

    // Invariant: save() must clean SLOT by the handle *name*, not by the slot ordinal. The prior
    // code called removeValuesFromOrderedSet(SLOT, updated_slot_number) which issued ZREM with
    // the stringified number — a no-op for normal handles, and worst case a wrong-target removal
    // for a handle whose name happened to collide with the slot string.
    it('save() cleans SLOT zset by handle name, not by slot ordinal', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);

        const newHandle = repo.Internal.buildHandle({
            name: 'alpha',
            hex: Buffer.from('alpha').toString('hex'),
            policy,
            resolved_addresses: { ada: address },
            updated_slot_number: 12345,
            handle_type: HandleType.HANDLE
        });
        newHandle.holder = holder;
        newHandle.holder_type = 'wallet';

        repo.save(newHandle);

        expect(store.removeValuesFromOrderedSet).toHaveBeenCalledWith(IndexNames.SLOT, 'alpha');
        expect(store.removeValuesFromOrderedSet).not.toHaveBeenCalledWith(IndexNames.SLOT, 12345);
    });

    // Invariant: when updateHandleIndexes encounters an LBL_100 or LBL_001 asset whose datum
    // is missing, it must skip only that asset and continue processing the rest of the UTxO's
    // handle assets. Failure mode: the prior `return` exited the whole function, abandoning
    // every subsequent handle asset with no error signal — a transfer of handle A in the same
    // UTxO as a broken reference token for handle B would silently leave A at its old UTxO.
    it('LBL_100 with missing datum skips only that asset; subsequent assets still save', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        const saveSpy = jest.spyOn(repo, 'save').mockImplementation(jest.fn());
        jest.spyOn(repo, 'updateHolder').mockImplementation(jest.fn());

        const assetRefBad = `${AssetNameLabel.LBL_100}${Buffer.from('broken').toString('hex')}`;
        const assetMain = `${AssetNameLabel.LBL_222}${Buffer.from('alpha').toString('hex')}`;

        jest.spyOn(ogmiosUtils, 'getHandleNameFromAssetName').mockImplementation((assetName: string) => {
            if (assetName === assetRefBad) return { name: 'broken', ownerTokenHex: assetRefBad, isCip67: true, assetLabel: AssetNameLabel.LBL_100 };
            return { name: 'alpha', ownerTokenHex: assetMain, isCip67: true, assetLabel: AssetNameLabel.LBL_222 };
        });

        const mintingData = new Map([
            ['broken', [{ created_slot: 1, metadata: {}, txHash: 'tx_a' } as any]],
            ['alpha', [{ created_slot: 1, metadata: {}, txHash: 'tx_a' } as any]]
        ]);

        repo.updateHandleIndexes(
            {
                ...buildUtxo('', 50, /* datum */ undefined),
                handles: [[policy, [assetRefBad, assetMain]]],
                mint: [[policy, [assetRefBad, assetMain]]]
            } as any,
            mintingData as any,
            new Map(),
            new Map()
        );

        expect(saveSpy.mock.calls.some(([handle]) => handle?.name === 'alpha')).toBe(true);
    });

    it('LBL_001 with missing datum skips only that asset; subsequent assets still save', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        const saveSpy = jest.spyOn(repo, 'save').mockImplementation(jest.fn());
        jest.spyOn(repo, 'updateHolder').mockImplementation(jest.fn());

        const assetSubHandleSettingsBad = `${AssetNameLabel.LBL_001}${Buffer.from('broken').toString('hex')}`;
        const assetMain = `${AssetNameLabel.LBL_222}${Buffer.from('alpha').toString('hex')}`;

        jest.spyOn(ogmiosUtils, 'getHandleNameFromAssetName').mockImplementation((assetName: string) => {
            if (assetName === assetSubHandleSettingsBad) return { name: 'broken', ownerTokenHex: assetSubHandleSettingsBad, isCip67: true, assetLabel: AssetNameLabel.LBL_001 };
            return { name: 'alpha', ownerTokenHex: assetMain, isCip67: true, assetLabel: AssetNameLabel.LBL_222 };
        });

        const mintingData = new Map([
            ['broken', [{ created_slot: 1, metadata: {}, txHash: 'tx_a' } as any]],
            ['alpha', [{ created_slot: 1, metadata: {}, txHash: 'tx_a' } as any]]
        ]);

        repo.updateHandleIndexes(
            {
                ...buildUtxo('', 50, /* datum */ undefined),
                handles: [[policy, [assetSubHandleSettingsBad, assetMain]]],
                mint: [[policy, [assetSubHandleSettingsBad, assetMain]]]
            } as any,
            mintingData as any,
            new Map(),
            new Map()
        );

        expect(saveSpy.mock.calls.some(([handle]) => handle?.name === 'alpha')).toBe(true);
    });

    // Invariant: during rollback repair, updateHandleIndexes is invoked with a known-stale stored
    // handle pointer and the canonical on-chain UTxO. Its double-mint detection compares the two
    // and increments handle.amount when they differ — which they always do during repair.
    // Repeated repairs would inflate amount past the burn threshold (amount - 1 <= 0 in
    // removeHandle) and leave burned handles permanently in the HANDLE index. The options flag
    // suppresses that detection so repair is safe to replay.
    it('updateHandleIndexes with suppressDoubleMintDetection does not bump amount on stale-vs-canonical utxo', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        const saveSpy = jest.spyOn(repo, 'save').mockImplementation(jest.fn());
        jest.spyOn(repo, 'updateHolder').mockImplementation(jest.fn());

        const assetMain = `${AssetNameLabel.LBL_222}${Buffer.from('alpha').toString('hex')}`;
        jest.spyOn(ogmiosUtils, 'getHandleNameFromAssetName').mockReturnValue({
            name: 'alpha',
            ownerTokenHex: assetMain,
            isCip67: true,
            assetLabel: AssetNameLabel.LBL_222
        });

        const stored = {
            name: 'alpha',
            hex: assetMain,
            policy,
            amount: 1,
            utxo: 'stale_tx#0',
            updated_slot_number: 10,
            created_slot_number: 5,
            resolved_addresses: { ada: address },
            holder
        } as any;

        repo.updateHandleIndexes(
            {
                ...buildUtxo(assetMain, 100),
                id: 'canonical_tx#0',
                tx_id: 'canonical_tx',
                mint: [[policy, [assetMain]]]
            } as any,
            new Map([['alpha', [{ created_slot: 5, metadata: {}, txHash: 'canonical_tx' } as any]]]),
            new Map([['alpha', stored]]),
            new Map(),
            { suppressDoubleMintDetection: true }
        );

        const [savedHandle] = saveSpy.mock.calls[0];
        expect(savedHandle.amount).toBe(1);
    });

    it('updateHandleIndexes without the suppress flag DOES bump amount (baseline)', () => {
        const store = buildStoreMock();
        const repo = new HandlesRepository(store);
        const saveSpy = jest.spyOn(repo, 'save').mockImplementation(jest.fn());
        jest.spyOn(repo, 'updateHolder').mockImplementation(jest.fn());
        jest.spyOn(Logger, 'log').mockImplementation(jest.fn());

        const assetMain = `${AssetNameLabel.LBL_222}${Buffer.from('alpha').toString('hex')}`;
        jest.spyOn(ogmiosUtils, 'getHandleNameFromAssetName').mockReturnValue({
            name: 'alpha',
            ownerTokenHex: assetMain,
            isCip67: true,
            assetLabel: AssetNameLabel.LBL_222
        });

        const stored = {
            name: 'alpha',
            hex: assetMain,
            policy,
            amount: 1,
            utxo: 'stale_tx#0',
            updated_slot_number: 10,
            created_slot_number: 5,
            resolved_addresses: { ada: address },
            holder
        } as any;

        repo.updateHandleIndexes(
            {
                ...buildUtxo(assetMain, 100),
                id: 'canonical_tx#0',
                tx_id: 'canonical_tx',
                mint: [[policy, [assetMain]]]
            } as any,
            new Map([['alpha', [{ created_slot: 5, metadata: {}, txHash: 'canonical_tx' } as any]]]),
            new Map([['alpha', stored]]),
            new Map()
        );

        const [savedHandle] = saveSpy.mock.calls[0];
        expect(savedHandle.amount).toBe(2);
    });
});
