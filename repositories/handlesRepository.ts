import { Point } from '@cardano-ogmios/schema';
import { AssetNameLabel, bech32FromHex, buildCharacters, buildDrep, buildHolderInfo, buildNumericModifiers, decodeAddress, decodeCborToJson, EMPTY, getPaymentKeyHash, getRarity, HandlePaginationModel, HandleSearchModel, HandleType, Holder, HolderHandleNames, HolderPaginationModel, HttpException, IApiMetrics, IApiStore, IHandleMetadata, IndexNames, IPersonalization, IPzDatum, IPzDatumConvertedUsingSchema, ISubHandleSettings, ISubHandleTypeSettings, LockedLambdaReason, LogCategory, Logger, MINTED_OG_LIST, MintingData, NETWORK, Sort, StoredHandle, UTxOFunctions, UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import { designerSchema, handleDatumSchema, portalSchema, socialsSchema, subHandleSettingsDatumSchema } from '@koralabs/kora-labs-common/utils/cbor';
import * as crypto from 'crypto';
import { isDatumEndpointEnabled } from '../config';
import { MAX_SETS_PER_PIPE } from '../config/constants';
import { BuildPersonalizationInput, HandleOnChainMetadata, MetadataLabel } from '../interfaces/ogmios.interfaces';
import { getHandleNameFromAssetName } from '../services/ogmios/utils';
import { decodeCborFromIPFSFile } from '../utils/ipfs';
const blackListedIpfsCids: string[] = [];
const isTestnet = NETWORK.toLowerCase() !== 'mainnet';
const magicSlotsRange = 50_000; // This is arbitrary and should be adjusted if not enough or too many slots come back from queries.

process.env.INDEX_SCHEMA_VERSION ??= '3'
process.env.UTXO_SCHEMA_VERSION ??= '1'

/********** RewoundHandle IS USED TO FLAG THE HANDLE TO AVOID SAVING SLOT HISTORY ********************/
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface RewoundHandle extends StoredHandle {}
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class RewoundHandle implements RewoundHandle {
    constructor(handle: StoredHandle) {
        Object.assign(this, handle);
    }
}

/********** UpdatedOwnerHandle IS USED TO FLAG THE HANDLE FOR HOLDER LOGIC ***************************/
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface UpdatedOwnerHandle extends StoredHandle {}
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class UpdatedOwnerHandle implements UpdatedOwnerHandle {
    constructor(handle: StoredHandle) {
        Object.assign(this, handle);
    }
}

export class HandlesRepository {
    private store: IApiStore;
    
    constructor(store: IApiStore) {
        this.store = store;
    }

    public async initialize() {
        await this.store.initialize();
        return this;
    }

    public destroy(): void {
        return this.store.destroy();
    }

    public currentHttpStatus(): number {
        const { lockLambdas } = this.store.getMetrics();
        if ([LockedLambdaReason.ROLLBACK_2160, LockedLambdaReason.REINDEX].includes(lockLambdas as LockedLambdaReason)) {
            return 202;
        }
        return this.isCaughtUp() ? 200 : 202        
    }

    public isCaughtUp(): boolean {
        const { lastSlot = 1, currentSlot = 0, currentBlockHash = '0', tipBlockHash = '1' } = this.store.getMetrics();
        return lastSlot - currentSlot < 120 && currentBlockHash == tipBlockHash;
    }
    
    public getHandle(key: string): StoredHandle | null {
        const handle = structuredClone(this.store.getHashFromIndex(IndexNames.HANDLE, key));
        if (!handle) return null;
        return this.prepareHandle(handle as StoredHandle);
    }

    public getHandleByHex(hex: string): StoredHandle | null {
        const {name} = getHandleNameFromAssetName(hex);
        const handle = this.getHandle(name);
        if(handle?.hex != hex) return null;
        return handle;
    }

    private prepareHandle(handle?: StoredHandle | null) {
        if (!handle) {
            return null;
        }

        // Attach the default Handle
        const handleNames = this.store.getValuesFromIndexedSet(IndexNames.HOLDER, handle.holder) as HolderHandleNames | undefined;
        if (handleNames) {
            const manuallySetDefaultHandle = this.store.getValuesFromIndexedSet(IndexNames.DEFAULT_HANDLE, handle.holder);
            //                                                                                                   Converts numeric handles to a string
            handle.default_in_wallet = manuallySetDefaultHandle?.size ? `${[...manuallySetDefaultHandle][0]}` : `${this.getDefaultHandle(handleNames)?.name ?? handle.name}`;
        }

        // Workaround for numeric handles names
        handle.name = `${handle.name}`
        handle.hex = `${handle.hex}`

        return handle;
    }

    public buildHolder(handles: Set<string>, address: string, defaultHandle?: string, totalHandles?: number, includeHandles = true, manuallySet?: boolean): Holder | undefined {
        if(!handles || handles.size === 0) return;

        const holderTotal = totalHandles ?? handles.size;

        const addressDetails = buildHolderInfo(address);

        const holder: Holder = {
            handles: includeHandles ? [...handles] : [],
            default_handle: defaultHandle || `${this.getDefaultHandle(handles ?? new Set())?.name ?? ''}`,
            manually_set: manuallySet ?? (defaultHandle ? true : false),
            type: addressDetails.type,
            known_owner_name: addressDetails.knownOwnerName?.name ?? '',
            total_handles: holderTotal,
            address: addressDetails.address
        }
        return holder;
    }

    private _shuffle(t: any[])
    { 
        let last = t.length
        let n
        while (last > 0)
        { 
            n = 0 | Math.random() * last;
            const q = t[n]
            const j = --last;
            t[n] = t[j]
            t[j] = q
        }
    }

    public search(pagination?: HandlePaginationModel, searchModel?: HandleSearchModel, namesOnly = false): { searchTotal: number, handles: (StoredHandle | string)[] } {
        const hasSearchFilters = Boolean(
            searchModel?.characters ||
                searchModel?.length ||
                searchModel?.rarity ||
                searchModel?.numeric_modifiers ||
                searchModel?.holder_address ||
                searchModel?.og ||
                searchModel?.personalized ||
                searchModel?.handle_type
        );
        const isUnfilteredPaginatedSearch =
            !hasSearchFilters &&
            !searchModel?.search &&
            !searchModel?.handles?.length &&
            !pagination?.slotNumber &&
            pagination?.sort !== 'random';

        if (isUnfilteredPaginatedSearch) {
            const metrics = this.store.getMetrics();
            const handleCountFromMetrics = Number(metrics?.handleCount);
            const searchTotal = Number.isFinite(handleCountFromMetrics)
                ? handleCountFromMetrics
                : Number((this.store as any).count?.() ?? 0);

            const startIndex = ((pagination?.page ?? 1) - 1) * (pagination?.handlesPerPage ?? 100);
            const sortOrder = pagination?.sort === 'desc' ? 'desc' : 'asc';
            const pageHandleNames = this.store.getKeysFromIndex(IndexNames.HANDLE, {
                orderBy: sortOrder,
                limit: { offset: startIndex, count: pagination?.handlesPerPage ?? 100 }
            }) as string[];

            if (namesOnly) {
                return { searchTotal, handles: pageHandleNames.map((name) => `${name}`) };
            }

            let handles = (this.store.pipeline(() => {
                for (const h of pageHandleNames) {
                    this.store.getHashFromIndex(IndexNames.HANDLE, h);
                }
            }) as StoredHandle[]);

            const defaultHandlesByHolder = this.resolveDefaultHandlesByHolder(handles);
            handles = handles
                .map((handle) => {
                    if (handle) {
                        handle.name = `${handle.name}`;
                        handle.hex = `${handle.hex}`;
                        handle.default_in_wallet = defaultHandlesByHolder.get(handle.holder) ?? handle.name;
                        return handle;
                    }
                })
                .filter((h): h is StoredHandle => !!h);

            return { searchTotal, handles };
        }

        let handles: StoredHandle[] = [];
        // The ['|empty|'] is important for `AND` searches here and indicates 
        // that we couldn't find any results for one of the search terms
        // When intersected with all other results, ['|empty|'] ensures empty result set
        // while [] means the term wasn't searched so return them all
        const checkEmptyResult = (indexName: IndexNames, term: string | number | undefined) => {
            if (!term) return [];
            const set = this.store.getValuesFromIndexedSet(indexName, term) ?? new Set<string>();
            return set.size === 0 ? [EMPTY] : [...set];
        };

        // get handle name arrays for all the search parameters
        const characterArray = checkEmptyResult(IndexNames.CHARACTER, searchModel?.characters);
        let lengthArray: string[] = [];
        if (searchModel?.length?.includes('-')) {
            for (let i = parseInt(searchModel?.length.split('-')[0]); i <= parseInt(searchModel?.length.split('-')[1]); i++) {
                lengthArray = lengthArray.concat([...this.store.getValuesFromIndexedSet(IndexNames.LENGTH, i) ?? new Set<string>()]);
            }
            if (lengthArray.length === 0) lengthArray = [EMPTY];
        } else {
            lengthArray = checkEmptyResult(IndexNames.LENGTH, parseInt(searchModel?.length || '0'));
        }
        const pzArray = searchModel?.personalized ? checkEmptyResult(IndexNames.PERSONALIZED, 1) : [];
        const typeArray = checkEmptyResult(IndexNames.HANDLE_TYPE, searchModel?.handle_type);
        const rarityArray = checkEmptyResult(IndexNames.RARITY, searchModel?.rarity);
        const numericModifiersArray = checkEmptyResult(IndexNames.NUMERIC_MODIFIER, searchModel?.numeric_modifiers);
        const ogArray = searchModel?.og ? checkEmptyResult(IndexNames.OG, 1) : [];
        const holderArray = (() => {
            if (!searchModel?.holder_address) return [];
            const holder = this.store.getValuesFromIndexedSet(IndexNames.HOLDER, searchModel?.holder_address) as HolderHandleNames | undefined;
            return holder?.size ? [...holder] : [EMPTY];
        })();

        let handleNames:string[] | undefined = undefined;
        
        // filter out any empty arrays
        const filtered = [characterArray, lengthArray, typeArray, rarityArray, numericModifiersArray, holderArray, ogArray, pzArray].filter((a) => a?.length)
        if (filtered.length == 0) {
            // This means request had no filtered terms, so we need to start with the whole set
            handleNames = Array.from(this.store.getKeysFromIndex(IndexNames.HANDLE)).map((handle) => handle as string);
        }
        else {
            // Get the intersection
            handleNames = [...new Set(filtered.reduce((a, b) => a.filter((c: string) => b.includes(c))))]
                // if there is an EMPTY here, there are no results
                .filter((name) => name !== EMPTY);
        }
        const checkSearch = (name: string, search?: string, handleHex?: string) => {
            if (!search) return true;
            if (name.includes(search)) return true;
            return (handleHex ?? '').includes(search);
        }

        // Check for the searched term or handle list
        handleNames = handleNames.filter((name) => !searchModel?.handles || searchModel?.handles.includes(name));
        if (searchModel?.search) {
            const handlesNeedingHexMatch = handleNames.filter((name) => !name.includes(searchModel.search!));
            const matchesByHex = new Set<string>();
            const fieldLookupStore = this.store as IApiStore & {
                getHashFieldFromIndex?: (index: IndexNames, key: string | number, field: string) => string | undefined;
            };
            for (let i = 0; i < handlesNeedingHexMatch.length; i += MAX_SETS_PER_PIPE) {
                const handleChunk = handlesNeedingHexMatch.slice(i, i + MAX_SETS_PER_PIPE);
                const handleHexes = (() => {
                    if (fieldLookupStore.getHashFieldFromIndex) {
                        return (this.store.pipeline(() => {
                            for (const handleName of handleChunk) {
                                fieldLookupStore.getHashFieldFromIndex!(IndexNames.HANDLE, handleName, 'hex');
                            }
                        }) as (string | undefined)[]).map((hex, index) => hex ?? Buffer.from(handleChunk[index], 'utf8').toString('hex'));
                    }
                    const searchedHandles = (this.store.pipeline(() => {
                        for (const handleName of handleChunk) {
                            this.store.getHashFromIndex(IndexNames.HANDLE, handleName);
                        }
                    }) as (StoredHandle | undefined)[]);
                    return handleChunk.map((handleName, index) => `${searchedHandles[index]?.hex ?? Buffer.from(handleName, 'utf8').toString('hex')}`);
                })();
                handleChunk.forEach((handleName, index) => {
                    const handleHex = handleHexes[index];
                    if (checkSearch(handleName, searchModel.search, handleHex)) {
                        matchesByHex.add(handleName);
                    }
                });
            }
            handleNames = handleNames.filter((name) => name.includes(searchModel.search!) || matchesByHex.has(name));
        }
        const searchTotal = handleNames.length;

        if (pagination?.slotNumber) {
            const {firstSlot, lastSlot, handleCount} = this.store.getMetrics();
            const handleNamesInSlotRage: string[] = [];
            let result: string[] = [];
            let iterations = 0;
            while (handleNamesInSlotRage.length < handleCount! && handleNamesInSlotRage.length < (pagination?.handlesPerPage || 100)) {
                iterations++;
                let options;
                // Get an arbitrary range of slots (slotNumber + magicSlotsRange)
                if (pagination?.sort.toUpperCase() == 'ASC') {
                    const start = pagination?.slotNumber + (magicSlotsRange * (iterations - 1));
                    if (start > (lastSlot ?? firstSlot!)) {
                        break;
                    }
                    options = {
                        start, 
                        end: pagination?.slotNumber + (magicSlotsRange * iterations),
                        orderBy: 'ASC' as Sort
                    }
                }
                else {
                    const start = pagination?.slotNumber - (magicSlotsRange * (iterations - 1));
                    if (start < firstSlot!) {
                        break;
                    }
                    options = {
                        start, 
                        end: pagination?.slotNumber - (magicSlotsRange * iterations) ,
                        orderBy: 'DESC' as Sort
                    }
                }
                result = this.store.getValuesFromOrderedSet(IndexNames.SLOT, 0, options) as string[]
                handleNamesInSlotRage.push(...result.filter(h => handleNames?.includes(h as string)) as string[]);
            }
            handleNames = handleNamesInSlotRage;
        }
        else {
            switch (pagination?.sort) {
                case 'random':
                    this._shuffle(handleNames);
                    break;
                case 'desc': 
                    handleNames.sort((h1, h2) => h2.localeCompare(h1));
                    break;
                default:
                    handleNames.sort((h1, h2) => h1.localeCompare(h2));
                    break;
            }
        }
    
        const startIndex = ((pagination?.page ?? 1) - 1) * (pagination?.handlesPerPage ?? 100);
        handleNames = handleNames.slice(startIndex, startIndex + (pagination?.handlesPerPage ?? 100));
        if (namesOnly) {
            return { searchTotal, handles: (handleNames ?? []).map((name) => `${name}`) };
        }

        handles = (this.store.pipeline(() => {
            for (const h of handleNames) {
                this.store.getHashFromIndex(IndexNames.HANDLE, h)
            }
        }) as StoredHandle[])
        const defaultHandlesByHolder = this.resolveDefaultHandlesByHolder(handles);

        handles = handles.map((handle,i) => {
            if (handle) {
                handle.name = `${handle.name}`
                handle.hex = `${handle.hex}`
                handle.default_in_wallet = defaultHandlesByHolder.get(handle.holder) ?? handle.name;
                return handle;
            }
        }).filter(h => !!h)
    

        return { searchTotal, handles };
    }

    private resolveDefaultHandlesByHolder(handles: StoredHandle[]): Map<string, string> {
        const defaultsByHolder = new Map<string, string>();
        const holderAddresses = [...new Set(handles.map((handle) => handle?.holder).filter((holder): holder is string => !!holder))];
        if (!holderAddresses.length) return defaultsByHolder;

        const explicitDefaultSets = (this.store.pipeline(() => {
            for (const holderAddress of holderAddresses) {
                this.store.getValuesFromIndexedSet(IndexNames.DEFAULT_HANDLE, holderAddress);
            }
        }) as (Set<string> | undefined)[]);

        const holdersMissingDefault: string[] = [];
        holderAddresses.forEach((holderAddress, index) => {
            const defaultSet = explicitDefaultSets[index];
            if (defaultSet?.size) {
                defaultsByHolder.set(holderAddress, `${[...defaultSet][0]}`);
                return;
            }
            holdersMissingDefault.push(holderAddress);
        });

        if (!holdersMissingDefault.length) return defaultsByHolder;

        const holderHandleSets = (this.store.pipeline(() => {
            for (const holderAddress of holdersMissingDefault) {
                this.store.getValuesFromIndexedSet(IndexNames.HOLDER, holderAddress) as HolderHandleNames;
            }
        }) as HolderHandleNames[]);

        holdersMissingDefault.forEach((holderAddress, index) => {
            const holderHandles = holderHandleSets[index] ?? new Set<string>();
            if (holderHandles.size === 1) {
                defaultsByHolder.set(holderAddress, `${[...holderHandles][0]}`);
                return;
            }
            if (holderHandles.size > 1000) {
                defaultsByHolder.set(holderAddress, `${[...holderHandles][0] ?? ''}`);
                return;
            }

            const fallbackDefault = this.getDefaultHandle(holderHandles)?.name;
            if (fallbackDefault) defaultsByHolder.set(holderAddress, `${fallbackDefault}`);
        });

        return defaultsByHolder;
    }

    public addUTxO(utxo: UTxOWithTxInfo) {
        // save the UTxO id to the store with slot as the key
        this.store.addValueToOrderedSet(IndexNames.UTXO_SLOT, utxo.slot, utxo.id);

        // save the UTxO to the store
        this.store.setHashOnIndex(IndexNames.UTXO, utxo.id, utxo);
    }

    public getHandleMintingData = (handle: string) => {
        return this.store.getValuesFromIndexedSet(IndexNames.MINT, handle) as Set<string>;
    }

    private getMintedAssetNames(utxo: UTxOWithTxInfo): string[] {
        const mintedAssetNames = new Set<string>();
        for (const [, rawMintAssets] of utxo.mint) {
            const mintAssets = rawMintAssets as unknown;
            if (Array.isArray(mintAssets)) {
                mintAssets.forEach((assetName) => mintedAssetNames.add(assetName));
                continue;
            }

            if (!mintAssets || typeof mintAssets !== 'object') continue;

            Object.entries(mintAssets as Record<string, bigint>).forEach(([assetName, quantity]) => {
                if (quantity > 0n) mintedAssetNames.add(assetName);
            });
        }
        return Array.from(mintedAssetNames);
    }

    public buildMintingDataFromUTxO(utxo: UTxOWithTxInfo) {
        const mintingData: Map<string, MintingData[]>  = new Map();
        const mintedAssetNames = this.getMintedAssetNames(utxo);
        for (const asset of utxo.handles) {
            for (const assetName of asset[1]) {
                // Don't process the nameless token.
                if (assetName === '') continue;
                const { isCip67, name, assetLabel } = getHandleNameFromAssetName(assetName);

                const justMinted = isCip67 
                    ? (assetLabel === AssetNameLabel.LBL_222 || assetLabel === AssetNameLabel.LBL_000)
                        ? mintedAssetNames.includes(assetName) 
                        : false 
                    : mintedAssetNames.includes(assetName);

                if (justMinted) {
                    // TODO: Change metadata to only include handle metadata
                    const data = { created_slot: utxo.slot, metadata: utxo.metadata, txHash: `${utxo.tx_id}` };
                    const existingMintData = mintingData.get(name);
                    if (existingMintData) existingMintData.push(data)
                    else mintingData.set(name, [data]);
                }
            }
        }

        const missingMintingDataHandles = utxo.handles.flatMap(([, handles]) => handles).map(h => getHandleNameFromAssetName(h).name).filter(handleName => {
            return !mintingData.get(handleName)
        })

        const retrievedMintingData = this.store.pipeline(() => {
            missingMintingDataHandles.forEach(name => {
                this.getHandleMintingData(name);
            })
        }) as Set<string>[];

        retrievedMintingData.forEach((md, i) => {
            const handleName = missingMintingDataHandles[i];
            mintingData.set(handleName, Array.from(md ?? []).map(md => JSON.parse(md)));
        })

        return mintingData
    }

    public buildIndexInfoFromUTxO(utxo: UTxOWithTxInfo, mintData?: Map<string, MintingData[]>) {
        const mintingData = mintData ?? this.buildMintingDataFromUTxO(utxo);
        
        // we need holders from the handles that are in the utxo
        const holders = new Map<string, HolderHandleNames>();
        const handles = new Map<string, StoredHandle>();

        const keys: string[] = [];
        const results = this.store.pipeline(() => {
            for (const asset of utxo.handles) {
                for (const assetName of asset[1]) {
                    if (assetName === '') continue;
                    const { name } = getHandleNameFromAssetName(assetName);

                    const info = buildHolderInfo(utxo.address);
                    this.store.getValuesFromIndexedSet(IndexNames.HOLDER, info.address) as HolderHandleNames

                    this.store.getHashFromIndex(IndexNames.HANDLE, name);

                    keys.push(info.address, name);
                }
            }
        }) as (HolderHandleNames | StoredHandle)[];

        for (let i = 0; i < keys.length; i = i + 2) {
            const handleNames = results[i] as HolderHandleNames;
            const storedHandle = results[i + 1] as StoredHandle;
            holders.set(keys[i] as string, handleNames);
            handles.set(keys[i + 1] as string, storedHandle);
        }

        const existingHolderAddresses = [...new Set([...handles.values()].map((handle) => handle?.holder).filter((holderAddress): holderAddress is string => !!holderAddress && !holders.has(holderAddress)))];
        if (existingHolderAddresses.length > 0) {
            const existingHolderSets = this.store.pipeline(() => {
                for (const holderAddress of existingHolderAddresses) this.store.getValuesFromIndexedSet(IndexNames.HOLDER, holderAddress);
            }) as HolderHandleNames[];
            existingHolderAddresses.forEach((holderAddress, index) => {
                holders.set(holderAddress, existingHolderSets[index] ?? new Set<string>());
            });
        }

        return {
            mintingData,
            holders,
            handles
        }
    }

    private addUTxOWithMintingData(utxo: UTxOWithTxInfo, mintingData?: Map<string, MintingData[]>) {
        const { mintingData: resolvedMintingData, holders, handles } = this.buildIndexInfoFromUTxO(utxo, mintingData);

        this.store.pipeline(() => {
            this.addUTxO(utxo);
            this.updateHandleIndexes(utxo, resolvedMintingData, handles, holders);
        });
    }

    public getUTxOs(slot: number): UTxOWithTxInfo[] {
        const utxoIds = this.store.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, slot)
        if (!utxoIds) return [];

        return [...utxoIds as string[]].map(id => this.store.getHashFromIndex(IndexNames.UTXO, id) as UTxOWithTxInfo);
    }

    public removeUTxOs(utxos: string[]) {
        this.store.pipeline(() => {
            for (const utxo of utxos) {
                this.store.removeValuesFromOrderedSet(IndexNames.UTXO_SLOT, utxo);
                this.store.removeKeyFromIndex(IndexNames.UTXO, utxo);
            }
        });
    }

    public addMintData(mintData: Map<string, MintingData[]>) {    
        this.store.pipeline(() => {
            for (const [handleName, mintingData] of mintData) {
                mintingData.forEach(md => {
                    this.store.addValueToIndexedSet(IndexNames.MINT, handleName, JSON.stringify(md, (_, val) => (typeof val === 'bigint' ? `${Number(val)}` : val)));
                }) 
            }
        });
    }

    private buildMintDataFromUTxOs(utxos: UTxOWithTxInfo[]): Map<string, MintingData[]> {
        const mintData = new Map<string, MintingData[]>();
        for (const utxo of utxos) {
            for (const assetName of this.getMintedAssetNames(utxo)) {
                if (assetName === '') continue;
                const { isCip67, name, assetLabel } = getHandleNameFromAssetName(assetName);
                const shouldIndexMint = isCip67
                    ? assetLabel === AssetNameLabel.LBL_222 || assetLabel === AssetNameLabel.LBL_000
                    : true;

                if (!shouldIndexMint) continue;
                const data: MintingData = { created_slot: utxo.slot, metadata: utxo.metadata, txHash: `${utxo.tx_id}` };
                const existing = mintData.get(name);
                if (existing) existing.push(data);
                else mintData.set(name, [data]);
            }
        }

        return mintData;
    }

    public addMintDataFromUTxOs(utxos: UTxOWithTxInfo[]): Map<string, MintingData[]> {
        const mintData = this.buildMintDataFromUTxOs(utxos);
        this.addMintData(mintData);
        return mintData;
    }

    public addUTxOsWithMintDataAndUpdateIndexes(utxos: UTxOWithTxInfo[], mintingData?: Map<string, MintingData[]>) {
        const resolvedMintingData = mintingData ?? this.addMintDataFromUTxOs(utxos);
        for (const utxo of utxos) {
            const utxoMintingData = this.getMintedAssetNames(utxo).length ? resolvedMintingData : undefined;
            this.addUTxOWithMintingData(utxo, utxoMintingData);
        }
    }

    public addUTxOsWithMintData(utxos: UTxOWithTxInfo[], mintingData?: Map<string, MintingData[]>) {
        if (!mintingData) this.addMintDataFromUTxOs(utxos);
        for (const utxo of utxos) {
            this.store.pipeline(() => {
                this.addUTxO(utxo);
            });
        }
    }

    public getMetrics(): IApiMetrics {  
        return this.store.getMetrics();
    }

    public getHandlesByHolderAddresses = (addresses: string[]): string[]  => {
        return addresses.map((address) => {
            const array = Array.from((this.store.getValuesFromIndexedSet(IndexNames.HOLDER, address) as HolderHandleNames) ?? new Set());
            return array.length === 0 ? [EMPTY] : array;
        }
        ).concat(addresses.map((address) => { // convert holder addresses to hash and look in that index too
            const decodedAddress = decodeAddress(address);
            if (!decodedAddress) return [EMPTY];
            const hashed = crypto.createHash('md5').update(decodedAddress, 'hex').digest('hex');
            const array: string[] = Array.from(this.store.getValuesFromIndexedSet(IndexNames.HASH_OF_STAKE_KEY_HASH, hashed!) ?? new Set());
            return array.length === 0 ? [EMPTY] : array;
        })).flat() as string[];
    }

    public getAllHolders(params: { pagination: HolderPaginationModel; includeHandles?: boolean; }): Holder[] {
        const pagination = params.pagination;
        const includeHandles = params.includeHandles ?? true;
        const startRecord = (pagination.page - 1) * pagination.recordsPerPage;
        const holderAddresses = (this.store.getValuesFromOrderedSet(
            IndexNames.HOLDER_COUNT,
            0,
            { orderBy: pagination.sort, limit: { offset: startRecord, count: pagination.recordsPerPage } }
        ) ?? []).map((holderAddress) => `${holderAddress}`);
        const holders: Holder[] = [];
        if (!holderAddresses.length) return holders;

        const defaultHandles: (Set<string> | undefined)[] = (this.store.pipeline(() => {
            for (const h of holderAddresses) {
                this.store.getValuesFromIndexedSet(IndexNames.DEFAULT_HANDLE, h);
            }
        }) as (Set<string> | undefined)[]);

        const holderCountsFromScores = includeHandles
            ? undefined
            : (this.store as IApiStore & { getScoresFromOrderedSet?: (index: IndexNames, values: string[]) => number[] })
                .getScoresFromOrderedSet?.(IndexNames.HOLDER_COUNT, holderAddresses);

        const holderHandleNames: HolderHandleNames[] = (this.store.pipeline(() => {
            for (const h of holderAddresses) {
                this.store.getValuesFromIndexedSet(
                    IndexNames.HOLDER,
                    h,
                    includeHandles ? undefined : { orderBy: 'asc', limit: { offset: 0, count: 1 } }
                ) as HolderHandleNames;
            }
        }) as HolderHandleNames[]);

        const holderCounts = holderAddresses.map((holderAddress, index) => {
            if (includeHandles) return holderHandleNames[index]?.size ?? 0;
            const score = Number(holderCountsFromScores?.[index]);
            if (Number.isFinite(score)) return score;
            return (this.store.getValuesFromIndexedSet(IndexNames.HOLDER, holderAddress) as HolderHandleNames)?.size ?? holderHandleNames[index]?.size ?? 0;
        });

        const holderAddressesMissingComputedDefault = includeHandles
            ? []
            : holderAddresses.filter((holderAddress, index) => {
                if (defaultHandles[index]?.size) return false;
                const holderCount = holderCounts[index] ?? 0;
                return holderCount > 1 && holderCount <= 1000;
            });

        const fullHolderSetsForDefault = new Map<string, HolderHandleNames>();
        if (holderAddressesMissingComputedDefault.length) {
            const fullSets = (this.store.pipeline(() => {
                for (const holderAddress of holderAddressesMissingComputedDefault) {
                    this.store.getValuesFromIndexedSet(IndexNames.HOLDER, holderAddress) as HolderHandleNames;
                }
            }) as HolderHandleNames[]);

            holderAddressesMissingComputedDefault.forEach((holderAddress, index) => {
                fullHolderSetsForDefault.set(holderAddress, fullSets[index] ?? new Set<string>());
            });
        }

        const firstHandleNames = holderHandleNames.map((names) => `${[...(names ?? new Set<string>())][0] ?? ''}`);
        const storedHandles = this.store.pipeline(() => {
            for (const firstHandleName of firstHandleNames) {
                if (firstHandleName) this.store.getHashFromIndex(IndexNames.HANDLE, firstHandleName) as StoredHandle;
            }
        }) as StoredHandle[]

        let storedHandleIndex = 0;
        holderAddresses.forEach((holderAddress, index) => {
            const firstHandleName = firstHandleNames[index];
            const holderHandleNamesSet = holderHandleNames[index] ?? new Set<string>();
            const storedHandle = firstHandleName ? storedHandles[storedHandleIndex++] : undefined;
            if (!storedHandle?.resolved_addresses?.ada) return;

            const manuallySetDefault = [...(defaultHandles[index] ?? [])]?.[0];
            const resolvedDefault = manuallySetDefault
                || (() => {
                    const holderCount = holderCounts[index] ?? holderHandleNamesSet.size;
                    if (holderCount <= 1 || holderCount > 1000) return `${firstHandleName}`;
                    const handlesForDefault = includeHandles
                        ? holderHandleNamesSet
                        : (fullHolderSetsForDefault.get(holderAddress) ?? holderHandleNamesSet);
                    return `${this.getDefaultHandle(handlesForDefault)?.name ?? firstHandleName}`;
                })();

            const holder = this.buildHolder(
                includeHandles ? holderHandleNamesSet : new Set(firstHandleName ? [firstHandleName] : []),
                storedHandle.resolved_addresses.ada,
                resolvedDefault,
                holderCounts[index] ?? holderHandleNamesSet.size,
                includeHandles,
                Boolean(manuallySetDefault)
            );
            if (holder) holders.push(holder);
        });

        return holders;
    }

    public getHolder(address: string): Holder | undefined {
        const handleNames = this.store.getValuesFromIndexedSet(IndexNames.HOLDER, address) as HolderHandleNames;
        const defaultHandle = this.store.getValuesFromIndexedSet(IndexNames.DEFAULT_HANDLE, address);
        const storedHandle = this.store.getHashFromIndex(IndexNames.HANDLE, [...handleNames][0]) as StoredHandle;
        return this.buildHolder(handleNames, storedHandle.resolved_addresses.ada, [...(defaultHandle ?? [])]?.[0])
    }

    public getHandlesByStakeKeyHashes = (hashes: string[]): string[]  => {
        return hashes.map((h) => {
            const hashed = crypto.createHash('md5').update(h, 'hex').digest('hex');
            const array = Array.from(this.store.getValuesFromIndexedSet(IndexNames.HASH_OF_STAKE_KEY_HASH, hashed!) ?? []);
            return array.length === 0 ? [EMPTY] : array;
        }).flat() as string[];
    }

    public getHandlesByPaymentKeyHashes = (hashes: string[]): string[]  => {
        return hashes.map((h) => {
            const array = Array.from(this.store.getValuesFromIndexedSet(IndexNames.PAYMENT_KEY_HASH, h) ?? []);
            return array.length === 0 ? [EMPTY] : array;
        }
        ).flat() as string[];
    }

    public getHandlesByAddresses = (addresses: string[]): string[] => {
        return addresses.map((h) => {
            const array = Array.from(this.store.getValuesFromIndexedSet(IndexNames.ADDRESS, h) ?? []);
            return array.length === 0 ? [EMPTY] : array;
        }
        ).flat() as string[];
    }

    public getHandleDatumByName(handleName: string): string | null {
        const handle = this.getHandle(handleName);
        if (!handle || !handle.utxo) {
            throw new HttpException(404, 'Not found');
        }

        const { has_datum, datum = null } = handle;
        if (!has_datum) return null;
        return datum;
    }

    public getSubHandlesByRootHandle(handleName: string): StoredHandle[] {
        const subHandles = this.store.getValuesFromIndexedSet(IndexNames.SUBHANDLE, handleName) ?? new Set<string>();
        return [...subHandles].reduce<StoredHandle[]>((agg, item) => {
            const subHandle = this.getHandle(item);
            if (subHandle) {
                agg.push(subHandle);
            }
            return agg;
        }, []);
    }

    public getRootHandleNames(): string[] {
        // We expect at least one SubHandle to be minted to be counted as a rootHandle (have an entry in SUBHANDLE index)
        return this.store.getKeysFromIndex(IndexNames.SUBHANDLE) as string[];
    }

    public setMetrics(metrics: Partial<IApiMetrics>): void {
        this.store.setMetrics(metrics);
    }

    public rollBackToGenesis(): void {
        this.store.rollBackToGenesis();
    }

    public removeHandle(handle: StoredHandle | RewoundHandle): void {
        const handleName = handle.name;
        const amount = handle.amount - 1;
        
        if (amount <= 0) {
            // if (handle.name == 'ap@adaprotocol')
            //     debugLog('ap@adaprotocol being burned', slotNumber, handle);
            this.store.removeKeyFromIndex(IndexNames.HANDLE, handle.name);

            // set all one-to-many indexes
            this.store.removeValueFromIndexedSet(IndexNames.RARITY, handle.rarity, handleName)
            this.store.removeValueFromIndexedSet(IndexNames.OG, Number(handle.og_number), handleName);
            this.store.removeValueFromIndexedSet(IndexNames.CHARACTER, handle.characters, handleName)
            const payment_key_hash = getPaymentKeyHash(handle.resolved_addresses.ada)!;
            this.store.removeValueFromIndexedSet(IndexNames.PAYMENT_KEY_HASH, payment_key_hash, handleName)
            this.store.removeValueFromIndexedSet(IndexNames.ADDRESS, handle.resolved_addresses.ada, handleName)
            this.store.removeValueFromIndexedSet(IndexNames.NUMERIC_MODIFIER, handle.numeric_modifiers, handleName)
            this.store.removeValueFromIndexedSet(IndexNames.LENGTH, handle.length, handleName)
    
            // delete from subhandles index
            if (handleName.includes('@')) {
                const rootHandle = handleName.split('@')[1];
                this.store.removeValueFromIndexedSet(IndexNames.SUBHANDLE, rootHandle, handleName);
            }
    
            // remove the handle from the holder
            this._removeHandleFromHolder(handle.holder, handleName);

            // if (handle.name == 'ap@adaprotocol')
            //     debugLog('ap@adaprotocol burned', slotNumber, this.store.getHandle(handle.name));
        } else {
            const updatedHandle = { ...handle, amount };
            this.save(updatedHandle, handle);
        }
    }

    public updateHolder(handle: StoredHandle, holders?: Map<string, HolderHandleNames>) {
        const resolvedAddress = handle.resolved_addresses?.ada;
        if (resolvedAddress) {
            const holderInfo = buildHolderInfo(resolvedAddress);
            handle.holder = holderInfo.address;
            handle.holder_type = holderInfo.type;
        }

        let holderHandles: Set<string> = new Set<string>();

        if(holders) {
            holderHandles = holders?.get(handle.holder) ?? new Set<string>();
        } else {
            holderHandles = this.store.getValuesFromIndexedSet(IndexNames.HOLDER, handle.holder) as HolderHandleNames;
        }

        if (handle.default) {
            this.store.addValueToIndexedSet(IndexNames.DEFAULT_HANDLE, handle.holder, handle.name);
        } else {
            this.store.removeValueFromIndexedSet(IndexNames.DEFAULT_HANDLE, handle.holder, handle.name);
        }

        delete handle.default; // This is a temp property not meant to save to the handle

        holders?.set(handle.holder, holderHandles.add(handle.name));

        this.store.addValueToIndexedSet(IndexNames.HOLDER, handle.holder, handle.name);
        this.store.addValueToOrderedSet(IndexNames.HOLDER_COUNT, holderHandles.size, handle.holder);
    }

    public updateHandleIndexes(utxo: UTxOWithTxInfo, mintingData?: Map<string, MintingData[]>, handles?: Map<string, StoredHandle>, holders?: Map<string, HolderHandleNames>): void {
        const mintedAssetNames = this.getMintedAssetNames(utxo);
        for (const asset of utxo.handles) {
            const policy = asset[0];
            for (const assetName of asset[1]) {
                if (assetName === '') {
                    // Don't process the nameless token.
                    continue;
                }

                const assetDetails = getHandleNameFromAssetName(assetName);
                const { ownerTokenHex, name, isCip67 } = assetDetails;

                //const mintIndexValue = this.store.getValuesFromIndexedSet(IndexNames.MINT, name) as Set<string>;
                //.map<MintingData>(md => JSON.parse(md))
                const mintIndexValue = mintingData?.get(name) 
                                            ?? Array.from(this.store.getValuesFromIndexedSet(IndexNames.MINT, name) 
                                            ?? new Set<string>())
                                        .map<MintingData>(md => JSON.parse(md));
                const firstMintingData = Array.from(mintIndexValue).sort((a, b) => a.created_slot - b.created_slot)[0]

                // mintingData from the index should never be undefined.
                // however, metadata can.
                const existingHandle = handles?.get(name) ?? (this.store.getHashFromIndex(IndexNames.HANDLE, name) as StoredHandle) ?? undefined;

                if (!firstMintingData) {
                    const indexedMintingData = this.store.getValuesFromIndexedSet(IndexNames.MINT, name) ?? new Set<string>();
                    const utxoHandleNames = utxo.handles.flatMap(([, names]) => names);
                    const mintingMapKeys = mintingData ? Array.from(mintingData.keys()) : [];
                    const mintingContext = {
                        handleName: name,
                        utxoId: utxo.id,
                        txId: utxo.tx_id,
                        slot: utxo.slot,
                        blockHash: utxo.blockHash,
                        mintedAssetNames,
                        utxoHandleNames,
                        indexedMintCount: indexedMintingData.size,
                        mintingMapKeysCount: mintingMapKeys.length,
                        mintingMapKeysPreview: mintingMapKeys.slice(0, 10)
                    };
                    throw new Error(`No minting data found for ${name} while processing ${utxo.id} | mintingContext=${JSON.stringify(mintingContext)}`);
                }

                const metadata: { [handleName: string]: HandleOnChainMetadata } | undefined = (firstMintingData.metadata?.[MetadataLabel.NFT] as any)?.[policy];
                const data = metadata && (metadata[isCip67 ? ownerTokenHex : name] as unknown as IHandleMetadata);

                const { address, slot } = utxo
                let handle = structuredClone(existingHandle)
                    ?? this._buildHandle({name, hex: ownerTokenHex, policy, resolved_addresses: {ada: address}, updated_slot_number: slot, created_slot_number: firstMintingData.created_slot}, data);
                
                // if (['ap@adaprotocol', 'b-263-54'].some(n => n == handle.name))
                //     debugLog('PROCESSED SCANNED INFO START', slotNumber, {...handle, utxo})

                const isMintTx = assetDetails.isCip67 
                    ? (assetDetails.assetLabel === AssetNameLabel.LBL_222 || assetDetails.assetLabel === AssetNameLabel.LBL_000)
                        ? mintedAssetNames.includes(handle.hex) 
                        : false 
                    : mintedAssetNames.includes(handle.hex)

                switch (assetDetails.assetLabel) {
                    case null:
                    case AssetNameLabel.NONE:
                    case AssetNameLabel.LBL_222:
                        // if (!existingHandle && !isMintTx) {
                        //     Logger.log({ message: `Handle was updated but there is no existing handle in storage with name: ${name}`, category: LogCategory.INFO, event: 'saveHandleUpdate.noHandleFound' });
                        // }

                        if (utxo.slot < handle.updated_slot_number && isMintTx) {
                            handle.created_slot_number = Math.min(handle.created_slot_number, utxo.slot, existingHandle?.created_slot_number ?? Number.POSITIVE_INFINITY);
                        }
                        if (utxo.slot >= handle.updated_slot_number) {
                            // check if existing handle has a utxo. If it does, we may have a double mint
                            if (isMintTx && existingHandle?.utxo && existingHandle?.utxo != utxo.id) {
                                handle.amount = (handle.amount ?? 1) + 1;
                                if (handle.name != 'mydexaccounts') // The one double mint we had when half of Cardano nodes disconnected/restarted at 2023-01-22T00:09:00Z. Both the doublemint and what caused it on our side have been remedied
                                    Logger.log({ message: `POSSIBLE DOUBLE MINT! Name: ${name} | Old UTxO ${existingHandle?.utxo} | Old Slot: ${existingHandle.created_slot_number} | New UTxO: ${utxo.id} | New Slot: ${utxo.slot}`, category: LogCategory.NOTIFY, event: 'saveHandleUpdate.utxoAlreadyExists'});
                            }
                            handle.updated_slot_number = utxo.slot;
                            handle.script = utxo.script;
                            handle.datum = isDatumEndpointEnabled() && utxo.datum ? utxo.datum : undefined;
                            handle.has_datum = !!utxo.datum;
                            handle.lovelace = utxo.lovelace;
                            handle.utxo = utxo.id;
                            handle.resolved_addresses!.ada = utxo.address;
                            handle = new UpdatedOwnerHandle(handle);
                        }
                        break;
                    case AssetNameLabel.LBL_100:
                    case AssetNameLabel.LBL_000:
                    {
                        if (utxo.slot >= handle.updated_slot_number) {
                            if (!utxo.datum) {
                                Logger.log({ message: `No datum for reference token ${handle.name}`, category: LogCategory.ERROR, event: 'processScannedHandleInfo.referenceToken.noDatum' });
                                return;
                            }

                            const { projectAttributes } = this.buildPersonalizationData(handle, utxo.datum); // <- handle is mutated

                            handle.updated_slot_number = utxo.slot;
                            handle.reference_utxo = utxo.id;
                            handle.resolved_addresses = {
                                ...projectAttributes?.resolved_addresses,
                                ada: existingHandle?.resolved_addresses?.ada ?? ''
                            }

                            // VIRTUAL_SUBHANDLE
                            if (assetDetails.assetLabel == AssetNameLabel.LBL_000) {
                                handle.virtual = projectAttributes?.virtual ? { expires_time: projectAttributes.virtual.expires_time, public_mint: !!projectAttributes.virtual.public_mint } : undefined
                                handle.utxo = utxo.id;
                                handle.resolved_addresses!.ada = bech32FromHex(projectAttributes!.resolved_addresses!.ada.replace('0x', ''), isTestnet);
                                handle.handle_type = HandleType.VIRTUAL_SUBHANDLE;
                            }
                        }
                        break;
                    }
                    case AssetNameLabel.LBL_001:
                        if (utxo.slot >= handle.updated_slot_number) {
                            if (!existingHandle) {
                                // There should always be an existing root handle for a subhandle
                                // Logger.log({ message: `Cannot save subhandle settings for ${name} because root handle does not exist`, event: 'this.saveSubHandleSettingsChange', category: LogCategory.INFO });
                                // return;  
                            }
                    
                            if (!utxo.datum) {
                                Logger.log({ message: `No datum for SubHandle token ${handle.name}`,  category: LogCategory.ERROR, event: 'processScannedHandleInfo.subHandle.noDatum'});
                                return;
                            }

                            // TODO: change to utxo_id to utxo and update handle.me to requst /subhandle-settings/utxo
                            handle.subhandle_settings = {
                                ...(this.parseSubHandleSettingsDatum(utxo.datum)),
                                utxo_id: utxo.id
                            }
                            handle.updated_slot_number = utxo.slot;
                            if (!handle.resolved_addresses) {
                                handle.resolved_addresses = { ada: '' };
                            }
                        }
                        break;
                    default:
                        Logger.log({ message: `Unknown asset: ${handle.name}`, category: LogCategory.ERROR, event: 'processScannedHandleInfo.unknownAssetName' });
                }
                
                const holder = buildHolderInfo(handle.resolved_addresses.ada)
                
                handle.holder = holder.address
                handle.holder_type = holder.type

                this.updateHolder(handle, holders);
                
                if (existingHandle && existingHandle.holder !== handle.holder) {
                    this._removeHandleFromHolder(existingHandle.holder, name, holders)
                }
                
                handles?.set(handle.name, handle);
                this.save(handle, existingHandle);

                // if (['ap@adaprotocol', 'b-263-54'].some(n => n == handle.name))
                //     debugLog('PROCESSED SCANNED INFO END', slotNumber, handle) 
            }  
        }
    }

    public save(handle: StoredHandle | RewoundHandle | UpdatedOwnerHandle, oldHandle?: StoredHandle) {
        const {
            name,
            rarity,
            og_number,
            characters,
            numeric_modifiers,
            length,
            resolved_addresses: { ada },
            updated_slot_number
        } = handle;

        // if (['ap@adaprotocol', 'b-263-54'].some(n => n == handle.name))
        //     debugLog('SAVE CALLED FOR', handle.updated_slot_number, handle)

        const payment_key_hash = getPaymentKeyHash(ada)!;
        const old_payment_key_hash = getPaymentKeyHash(oldHandle?.resolved_addresses.ada!)!;
        const ogFlag = og_number > 0;
        handle.payment_key_hash = payment_key_hash;
        handle.drep = buildDrep(ada, handle.id_hash?.replace('0x', ''));

        // This could return null if it is a pre-Shelley address (not bech32)
        const decodedAddress = decodeAddress(handle.holder);
        if (decodedAddress) {
            const hashOfStakeKeyHash = handle.id_hash ? handle.id_hash.replace('0x', '').slice(34) : crypto.createHash('md5').update(decodedAddress, 'hex').digest('hex')
            this.store.addValueToIndexedSet(IndexNames.HASH_OF_STAKE_KEY_HASH, hashOfStakeKeyHash, handle.name);
        }

        // Set the main index (SAVES THE HANDLE)
        this.store.setHashOnIndex(IndexNames.HANDLE, name, handle);

        // set all one-to-many indexes
        this.store.addValueToIndexedSet(IndexNames.RARITY, rarity, name);
        this.store.addValueToIndexedSet(IndexNames.CHARACTER, characters, name);
        this.store.addValueToIndexedSet(IndexNames.NUMERIC_MODIFIER, numeric_modifiers, name);
        this.store.addValueToIndexedSet(IndexNames.LENGTH, length, name);
        this.store.addValueToIndexedSet(IndexNames.HANDLE_TYPE, handle.handle_type, name);

        if (name.includes('@')) {
            const rootHandle = name.split('@')[1];
            this.store.addValueToIndexedSet(IndexNames.SUBHANDLE, rootHandle, name);
        }

        const personalized = (() => {
            if (handle.image_hash != handle.standard_image_hash) return true;
            const pz = handle.personalization;
            return !!pz?.designer || !!pz?.portal || !!pz?.socials
        })();

        // remove the old - these can change over time
        this.store.removeValueFromIndexedSet(IndexNames.OG, Number(!ogFlag), name);
        this.store.removeValueFromIndexedSet(IndexNames.PERSONALIZED, Number(!personalized), name);
        this.store.removeValueFromIndexedSet(IndexNames.ADDRESS, oldHandle?.resolved_addresses.ada!, name); 
        this.store.removeValueFromIndexedSet(IndexNames.PAYMENT_KEY_HASH, old_payment_key_hash, name);
        this.store.removeValuesFromOrderedSet(IndexNames.SLOT, updated_slot_number);
        
        // add the new
        this.store.addValueToIndexedSet(IndexNames.PERSONALIZED, Number(personalized), name);
        this.store.addValueToIndexedSet(IndexNames.OG, Number(ogFlag), name);
        this.store.addValueToIndexedSet(IndexNames.ADDRESS, ada, name);
        this.store.addValueToIndexedSet(IndexNames.PAYMENT_KEY_HASH, payment_key_hash, name);
        this.store.addValueToOrderedSet(IndexNames.SLOT, updated_slot_number, name);
    }

    public getDefaultHandle(holderHandles: Set<string>): StoredHandle | undefined {
        // If we know that the address is from a known owner, e.g. jpg.store, then just return the first handle
        // This is to avoid thousands of handles being iterated through for known owners with massive amounts of handles
        const handles = [...holderHandles];

        // This is a performance workaround. It effecttively filters out marketplaces where default doesn't matter
        // Marketplaces make up about 25% of Handle holders, so every paginated result is slowed down by them
        if (handles.length > 1000) return this.store.getHashFromIndex(IndexNames.HANDLE, handles[0]) as StoredHandle;

        const storedHandles = (this.store.pipeline(() => {
            holderHandles.forEach((name) => {
                this.store.getHashFromIndex(IndexNames.HANDLE, name)
            });
        }) as (StoredHandle | undefined)[]);
        const existingStoredHandles = storedHandles.filter((handle): handle is StoredHandle => !!handle);
        if (!existingStoredHandles.length) return;

        // OG if no default set
        const ogHandle = this._sortOGHandle(existingStoredHandles);
        if (ogHandle) return ogHandle;
    
        // filter shortest length from handles
        const sortedHandlesByLength = this._sortedByLength(existingStoredHandles);
        if (sortedHandlesByLength.length == 1) return sortedHandlesByLength[0];
    
        // earliest created slot if same length
        const sortedHandlesBySlot = this._sortByCreatedSlotNumber(sortedHandlesByLength);
        if (sortedHandlesBySlot.length == 1) return sortedHandlesBySlot[0];
    
        //Alphabetical if minted same time
        return this._sortAlphabetically(sortedHandlesBySlot);
    }

    public async getPersonalization(handle: StoredHandle | null | undefined): Promise<IPersonalization | undefined> {
        let personalization = handle?.personalization;
        if (handle?.reference_utxo) {
            const refUtxo = this.getUTxO(handle?.reference_utxo)
            Logger.local(`'REFUTXO', ${refUtxo}`)
            const { projectAttributes } = this.buildPersonalizationData(handle, refUtxo?.datum!);
            Logger.local(`'PROJECTATTRIBUTES', ', ${projectAttributes}`)
            personalization = await this._buildPersonalization({ 
                personalizationDatum: projectAttributes!, 
                personalization: handle.personalization ?? { validated_by: '', trial: true, nsfw: true } 
            });
        }
        Logger.local(`'REFERENCE', ', ${handle?.reference_utxo}`)
        Logger.local(`'PERSONALIZATION', ', ${personalization}`)
        return personalization
    }
    
    public async getStartingPoint(utxoFunctions: UTxOFunctions, failed = false): Promise<Point | null> {
        return this.store.getStartingPoint(utxoFunctions , failed);
    }

    public getUTxO(utxoId: string): UTxOWithTxInfo | null {
        return this.store.getHashFromIndex(IndexNames.UTXO, utxoId) as UTxOWithTxInfo | null;
    }

    private _buildHandle(handle: Partial<StoredHandle>, data?: IHandleMetadata): StoredHandle {
        const {name, hex, policy} = handle;
        if (!name || !hex || !policy) {
            throw new Error(`_buildHandle: "name", "hex", and "policy" are required properties. Given: ${JSON.stringify({name, hex, policy})}`);
        }
        if (!hex.endsWith(Buffer.from(name).toString('hex'))) {
            throw new Error('_buildHandle: invalid hex for Handle name');
        }
        const address = handle.resolved_addresses?.ada;
        const slotNumber = handle.updated_slot_number ?? (handle.created_slot_number ?? 0);

        // calculated
        handle.length = name.length;
        handle.rarity = getRarity(name);
        handle.characters = buildCharacters(name);
        handle.numeric_modifiers = buildNumericModifiers(name);
        handle.created_slot_number = (handle.created_slot_number ?? slotNumber);
        handle.updated_slot_number = (handle.updated_slot_number ?? slotNumber);
        handle.payment_key_hash = address ? (getPaymentKeyHash(address))! : '';
        handle.handle_type = handle.handle_type ?? (name.includes('@') ? HandleType.NFT_SUBHANDLE : HandleType.HANDLE);
        handle.image = data?.image ?? (handle.image ?? '');
        handle.standard_image = handle.standard_image ?? handle.image ?? data?.image ?? '';
        handle.version = Number(((data as any)?.core ?? data)?.version ?? (handle.version ?? 0));
        handle.sub_characters = name.includes('@') ? buildCharacters(name.split('@')[0]) : undefined;
        handle.sub_length = name.includes('@') ? name.split('@')[0].length : undefined;
        handle.sub_numeric_modifiers = name.includes('@') ? buildNumericModifiers(name.split('@')[0]) : undefined;
        handle.sub_rarity = name.includes('@') ? getRarity(name.split('@')[0]) : undefined;
        handle.datum = isDatumEndpointEnabled() ? handle.datum ?? undefined : undefined;
        handle.has_datum = !!handle.datum;
        
        // defaults
        handle.amount = handle.amount ?? 1;
        handle.og_number = Number(handle.og_number ?? MINTED_OG_LIST[handle.name!] ?? 0);
        handle.standard_image_hash = handle.standard_image_hash ?? handle.image_hash ?? '';
        handle.image_hash = handle.image_hash ?? '';
        handle.holder = handle.holder ?? '';
        handle.holder_type = handle.holder_type ?? '';
        handle.utxo = handle.utxo ?? '';
        handle.lovelace = Number(handle.lovelace ?? 0);
        handle.has_datum = handle.has_datum ?? false;
        handle.svg_version = handle.svg_version ?? '0';
        return handle as StoredHandle;
    }

    /**
     * @description Mutates handle - adding personalization data
     */
    public buildPersonalizationData = (handle: StoredHandle, datum: string): { nftAttributes: IHandleMetadata | null; projectAttributes: IPzDatumConvertedUsingSchema | null; } => {
        const decodedDatum = decodeCborToJson({ cborString: datum, schema: handleDatumSchema });
        const datumObject = typeof decodedDatum === 'string' ? JSON.parse(decodedDatum) : decodedDatum;
        const { constructor_0 } = datumObject;

        const getHandleType = (hex: string): HandleType => {
            if (hex.startsWith(AssetNameLabel.LBL_000)) {
                return HandleType.VIRTUAL_SUBHANDLE;
            }

            if (hex.startsWith(AssetNameLabel.LBL_222) && handle.name.includes('@')) {
                return HandleType.NFT_SUBHANDLE;
            }

            return HandleType.HANDLE;
        };

        const requiredMetadata: IHandleMetadata = {
            name: '',
            image: '',
            mediaType: '',
            og: 0,
            og_number: 0,
            rarity: '',
            length: 0,
            characters: '',
            numeric_modifiers: '',
            version: 0,
            handle_type: getHandleType(handle.hex)
        };

        const requiredProperties: IPzDatum = {
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
        };

        const getMissingKeys = (object: any, requiredObject: any): string[] =>
            Object.keys(requiredObject).reduce<string[]>((memo, key) => {
                if (!Object.keys(object).includes(key)) {
                    memo.push(key);
                }
                return memo;
            }, []);

        if (constructor_0 && Array.isArray(constructor_0) && constructor_0.length === 3) {
            const nftAttributes: IHandleMetadata = constructor_0[0];
            const projectAttributes: IPzDatumConvertedUsingSchema = constructor_0[2];
            const missingMetadata = getMissingKeys(nftAttributes, requiredMetadata);
            if (missingMetadata.length > 0) {
                //Logger.log({ category: LogCategory.INFO, message: `${handle} missing metadata keys: ${missingMetadata.join(', ')}`, event: 'buildValidDatum.missingMetadata' });
            }

            const missingDatum = getMissingKeys(projectAttributes, requiredProperties);
            if (missingDatum.length > 0) {
                //Logger.log({ category: LogCategory.INFO, message: `${handle} missing datum keys: ${missingDatum.join(', ')}`, event: 'buildValidDatum.missingDatum' });
            }

            handle.og_number = nftAttributes?.og_number ?? 0;
            handle.image_hash = projectAttributes?.image_hash ?? ''
            handle.standard_image_hash = projectAttributes?.standard_image_hash ?? ''
            handle.image = nftAttributes?.image ?? ''
            handle.version = nftAttributes?.version ?? handle.version;
            handle.standard_image = projectAttributes?.standard_image ?? ''
            handle.bg_image = projectAttributes?.bg_image
            handle.bg_asset = projectAttributes?.bg_asset
            handle.pfp_image = projectAttributes?.pfp_image
            handle.pfp_asset = projectAttributes?.pfp_asset
            handle.svg_version = projectAttributes?.svg_version ?? ''
            handle.default = projectAttributes?.default == true
            handle.last_update_address = projectAttributes?.last_update_address
            handle.original_address = projectAttributes?.original_address
            handle.id_hash = projectAttributes?.id_hash
            handle.pz_enabled = projectAttributes?.pz_enabled
            handle.last_edited_time = projectAttributes?.last_edited_time

            return {
                nftAttributes,
                projectAttributes
            };
        }

        Logger.log({ category: LogCategory.ERROR, message: `${handle.name} invalid metadata: ${JSON.stringify(datumObject)}`, event: 'buildValidDatum.invalidMetadata' });

        return {
            nftAttributes: null,
            projectAttributes: null
        };
    };

    private _removeHandleFromHolder(holderAddress: string, handleName: string, holders?: Map<string, HolderHandleNames>) {
        if (holderAddress == null) return;
        holders?.get(holderAddress)?.delete(handleName)
        this.store.removeValueFromIndexedSet(IndexNames.HOLDER, holderAddress, handleName);
        this.store.removeValueFromIndexedSet(IndexNames.DEFAULT_HANDLE, holderAddress, handleName);

        const remainingHandles = holders ? holders.get(holderAddress) : this.store.getValuesFromIndexedSet(IndexNames.HOLDER, holderAddress)
        if (remainingHandles?.size) {
            this.store.addValueToOrderedSet(IndexNames.HOLDER_COUNT, remainingHandles.size, holderAddress);
        } else {
            holders?.delete(holderAddress);
            this.store.removeValuesFromOrderedSet(IndexNames.HOLDER_COUNT, holderAddress);
            this.store.removeKeyFromIndex(IndexNames.HOLDER, holderAddress);
        }
        
        const oldDecodedAddress = decodeAddress(holderAddress);
        if (oldDecodedAddress) {
            // if there is an old stake key hash, remove it from the index
            const oldHashOfStakeKeyHash = crypto.createHash('md5').update(oldDecodedAddress, 'hex').digest('hex')
            this.store.removeValueFromIndexedSet(IndexNames.HASH_OF_STAKE_KEY_HASH, oldHashOfStakeKeyHash, handleName);     
        }
    }

    private _sortOGHandle = (handles: StoredHandle[]): StoredHandle | null => {
        // filter by OG
        const ogHandles = handles.filter((handle) => handle.og_number);
        if (ogHandles.length > 0) {
            // sort by the OG number
            ogHandles.sort((a, b) => a.og_number - b.og_number);
            return ogHandles[0];
        }

        return null;
    };

    private _sortedByLength = (handles: StoredHandle[]): StoredHandle[] => {
        const groupedHandles = handles.reduce<Record<string, StoredHandle[]>>((acc, handle) => {
            const length = handle.name.length;
            if (!acc[length]) {
                acc[length] = [];
            }
            acc[length].push(handle);
            return acc;
        }, {});

        // sort grouped handles by updated_slot_number key
        const groupedHandleKeys = Object.keys(groupedHandles);
        groupedHandleKeys.sort((a, b) => parseInt(a) - parseInt(b));
        const [firstKey] = groupedHandleKeys;
        return groupedHandles[firstKey] ?? [];
    };

    private _sortByCreatedSlotNumber = (handles: StoredHandle[]): StoredHandle[] => {
        // group handles by updated_slot_number
        const groupedHandles = handles.reduce<Record<string, StoredHandle[]>>((acc, handle) => {
            const createdSlotNumber = handle.created_slot_number;
            if (!acc[createdSlotNumber]) {
                acc[createdSlotNumber] = [];
            }
            acc[createdSlotNumber].push(handle);
            return acc;
        }, {});

        // sort grouped handles by updated_slot_number key
        const groupedHandleKeys = Object.keys(groupedHandles);
        groupedHandleKeys.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
        const [firstKey] = groupedHandleKeys;
        return groupedHandles[firstKey] ?? [];
    };

    private _sortAlphabetically = (handles: StoredHandle[]): StoredHandle | undefined => {
        const sortedHandles = [...handles];
        sortedHandles.sort((a, b) => a.name.localeCompare(b.name));
        return sortedHandles[0];
    };

    private _getDataFromIPFSLink = async ({ link, schema }: { link?: string; schema?: any }): Promise<any | undefined> => {
        if (!link?.startsWith('ipfs://') || blackListedIpfsCids.includes(link)) return;

        const cid = link.split('ipfs://')[1];
        return await decodeCborFromIPFSFile(`${cid}`, schema);
    };

    private _buildPersonalization = async ({ personalizationDatum, personalization }: BuildPersonalizationInput): Promise<IPersonalization> => {

        if (!personalizationDatum) {
            return personalization
        }

        const { portal, designer, socials, validated_by, trial, nsfw } = personalizationDatum;

        // start timer for ipfs calls
        // const ipfsTimer = Date.now();

        const ipfsPortal = await this._getDataFromIPFSLink({ link: portal, schema: portalSchema });
        const ipfsDesigner = await this._getDataFromIPFSLink({ link: designer, schema: designerSchema });
        const ipfsSocials = await this._getDataFromIPFSLink({ link: socials, schema: socialsSchema });

        // stop timer for ipfs calls
        // const endIpfsTimer = Date.now() - ipfsTimer;
        // Logger.log({
        //     message: `IPFS calls took ${endIpfsTimer}ms`,
        //     category: LogCategory.INFO,
        //     event: 'buildPersonalization.ipfsTime'
        // });

        const updatedPersonalization: IPersonalization = {
            ...personalization,
            validated_by,
            trial,
            nsfw
        };

        if (ipfsDesigner) {
            updatedPersonalization.designer = ipfsDesigner;
        }

        if (ipfsPortal) {
            updatedPersonalization.portal = ipfsPortal;
        }

        if (ipfsSocials) {
            updatedPersonalization.socials = ipfsSocials;
        }

        // add vendor settings
        // if (ipfsVendor) {
        //     updatedPersonalization.vendor = ipfsVendor;
        // }

        return updatedPersonalization;
    };

    public parseSubHandleSettingsDatum(datum: string) {
        try {
            const decodedSettings = decodeCborToJson({ cborString: datum, schema: subHandleSettingsDatumSchema });

            const buildTypeSettings = (typeSettings: any): ISubHandleTypeSettings => {
                return {
                    public_minting_enabled: typeSettings[0],
                    pz_enabled: typeSettings[1],
                    tier_pricing: typeSettings[2],
                    default_styles: typeSettings[3],
                    save_original_address: typeSettings[4]
                };
            };

            const settings: ISubHandleSettings = {
                nft: buildTypeSettings(decodedSettings[0]),
                virtual: buildTypeSettings(decodedSettings[1]),
                buy_down_price: decodedSettings[2],
                buy_down_paid: decodedSettings[3],
                buy_down_percent: decodedSettings[4],
                agreed_terms: decodedSettings[5],
                migrate_sig_required: decodedSettings[6],
                payment_address: decodedSettings[7]
            };

            return settings
        }
        catch (error: any) {
            Logger.log({ message: `Error decoding SubHandle owner settings datum: ${error.message}`, category: LogCategory.ERROR, event: 'handleRepository.parseSubHandleSettingsDatum' });
            return {};
        }
    }
    // Used for unit testing
    Internal = {
        buildPersonalization: this._buildPersonalization.bind(this),
        buildHandle: this._buildHandle.bind(this),
        sortOGHandle: this._sortOGHandle.bind(this),
        sortedByLength: this._sortedByLength.bind(this),
        sortByCreatedSlotNumber: this._sortByCreatedSlotNumber.bind(this),
        sortAlphabetically: this._sortAlphabetically.bind(this),
        removeHandleFromHolder: this._removeHandleFromHolder.bind(this)
    }
}
