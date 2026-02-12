import { AssetNameLabel, decodeAddress, EMPTY, IndexNames, Logger } from '@koralabs/kora-labs-common';
import * as crypto from 'crypto';
import { HandlesRepository } from '../handlesRepository';
import * as ogmiosUtils from '../../services/ogmios/utils';
import * as ipfs from '../../utils/ipfs';

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
        expect(holderMap.get(holder)?.has('alpha')).toBe(true);
        expect((handle as any).default).toBeUndefined();

        const removeDefault = {
            name: 'alpha',
            holder,
            default: false
        } as any;
        repo.updateHolder(removeDefault);
        expect(store.removeValueFromIndexedSet).toHaveBeenCalledWith(IndexNames.DEFAULT_HANDLE, holder, 'alpha');
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

    it('prefers metadata-rich mint record when slots tie', () => {
        const repo = new HandlesRepository(buildStoreMock());
        const saveSpy = jest.spyOn(repo, 'save').mockImplementation(jest.fn());
        jest.spyOn(repo, 'updateHolder').mockImplementation(jest.fn());

        const name = 'alpha';
        const handleHex = `${AssetNameLabel.LBL_222}${Buffer.from(name).toString('hex')}`;
        const metadataRich = {
            '721': {
                [policy]: {
                    [handleHex]: {
                        image: 'ipfs://preferred-image',
                        core: { og: 1n }
                    }
                }
            }
        };

        const mintingData = new Map<string, any[]>([
            [
                name,
                [
                    { created_slot: 100, metadata: {}, txHash: 'zzzz' },
                    { created_slot: 100, metadata: metadataRich, txHash: 'aaaa' }
                ]
            ]
        ]);

        repo.updateHandleIndexes(
            {
                ...buildUtxo(handleHex, 100),
                mint: [[policy, [handleHex]]]
            } as any,
            mintingData as any,
            new Map(),
            new Map()
        );

        expect(saveSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                name,
                image: 'ipfs://preferred-image'
            }),
            undefined
        );
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

        repo.addMintDataFromUTxOs([
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
});
