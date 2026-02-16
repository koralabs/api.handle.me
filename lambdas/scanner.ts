import { AssetNameLabel, asyncForEach, buildHolderInfo, IndexNames, LockedLambdaReason, LogCategory, Logger, MintingData, NETWORK, StoredHandle, UTxOFunctionName, UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import { BlockfrostBlock, KoiosAssetUTxO, KoiosTxInfo } from '../interfaces/provider.interface';
import { HandlesRepository } from '../repositories/handlesRepository';
import { getHandleNameFromAssetName } from '../services/ogmios/utils';
import { RedisHandlesStore } from '../stores/redis';
import { blockfrostApiCall, buildUTxOsFromKoiosTxs, defaultKoiosSettings, fetchKoios, fetchPaginatedResults } from '../utils/helpers';

const store = new RedisHandlesStore(); // I hate this
const handlesRepo = new HandlesRepository(store);
let initialized = false;

const SCANNER_LEASE_KEY = 'scanner:lease';
const SCANNER_RECOVERY_KEY = 'scanner:recovery';
const SCANNER_LEASE_TTL_MS = 60_000;
const SCANNER_LEASE_HEARTBEAT_MS = 20_000;
const KOIOS_TX_INFO_MAX_RPS = 15;
const KOIOS_TX_INFO_MIN_INTERVAL_MS = Math.ceil(1000 / KOIOS_TX_INFO_MAX_RPS);
const KOIOS_TX_INFO_MAX_RETRIES = 2;
const KOIOS_TX_INFO_RETRY_BASE_DELAY_MS = 500;
const ROLLBACK_20_SLOT_WINDOW = 400; // 20 blocks * ~20 seconds per block
const RECOVERY_REASON_ROLLBACK = 'rollback';
const RECOVERY_REASON_REINDEX = 'reindex';
process.env.ENABLE_OGMIOS_SCANNING = 'false';
const LOCK_REASON_SNAPSHOT = 'SNAPSHOT' as LockedLambdaReason;

const staleLockTimeouts: Partial<Record<LockedLambdaReason, number>> = {
    [LockedLambdaReason.SCANNING]: 5 * 60 * 1000,
    [LockedLambdaReason.ROLLBACK_20]: 5 * 60 * 1000,
    [LockedLambdaReason.ROLLBACK_2160]: 10 * 60 * 1000,
    [LockedLambdaReason.REINDEX]: 10 * 60 * 1000,
    [LOCK_REASON_SNAPSHOT]: 6 * 60 * 1000
};

const ensureInitialized = async () => {
    if (initialized) return;
    await handlesRepo.initialize();
    initialized = true;
};

const acquireScannerLease = (owner: string): boolean => {
    const result = store.redisClientCall('set', SCANNER_LEASE_KEY, owner, {
        conditionalSet: 'onlyIfDoesNotExist',
        expiry: { type: 'PX', count: SCANNER_LEASE_TTL_MS }
    });
    return result === 'OK';
};

const renewScannerLease = (owner: string): boolean => {
    const currentOwner = store.redisClientCall('get', SCANNER_LEASE_KEY);
    if (currentOwner !== owner) return false;
    const updated = store.redisClientCall('pexpire', SCANNER_LEASE_KEY, SCANNER_LEASE_TTL_MS);
    return !!updated;
};

const releaseScannerLease = (owner: string): void => {
    const currentOwner = store.redisClientCall('get', SCANNER_LEASE_KEY);
    if (currentOwner === owner) {
        store.redisClientCall('del', [SCANNER_LEASE_KEY]);
    }
};

const setRecoveryFlag = (reason: string): void => {
    store.redisClientCall('set', SCANNER_RECOVERY_KEY, reason);
};

const getRecoveryFlag = (): string | undefined => {
    return store.redisClientCall('get', SCANNER_RECOVERY_KEY);
};

const clearRecoveryFlag = (): void => {
    store.redisClientCall('del', [SCANNER_RECOVERY_KEY]);
};

const isLockStale = (reason: LockedLambdaReason, lockTimestamp?: number): boolean => {
    if (!lockTimestamp) return false;
    const timeout = staleLockTimeouts[reason];
    if (!timeout) return false;
    return Date.now() - lockTimestamp > timeout;
};

const getKoiosBatches = (list: string[], keyName: string) => {
    const batchedList: string[][] = [];
    let batchesIndex = 0;
    let listArray: string[] = [];
    while (batchesIndex < list.length) {
        listArray.push(list[batchesIndex]);
        if (JSON.stringify({ [keyName]: listArray, ...defaultKoiosSettings }).length >= 4900) {
            // Max possible ",[policy,handle]" length is 96
            batchedList.push(listArray);
            listArray = [];
        }
        batchesIndex++;
        // last check if last handle
        if (batchesIndex == list.length && listArray.length) {
            batchedList.push(listArray);
        }
    }
    return batchedList;
};

const delayMs = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const getTxInfoBody = (hashBatch: string[]) => JSON.stringify({ _tx_hashes: hashBatch, ...defaultKoiosSettings });

const getKoiosTxInfoDebugCurl = (body: string) => {
    const host = NETWORK.toLowerCase() === 'mainnet' ? 'api' : NETWORK.toLowerCase();
    return `curl -v --http1.1 'https://${host}.koios.rest/api/v1/tx_info' -H 'Content-Type: application/json' -H 'Authorization: Bearer <YOUR_KOIOS_BEARER_TOKEN>' --data-binary '${body}'`;
};

const isRetriableKoiosTxInfoError = (error: any): boolean => {
    const message = `${error?.message ?? ''} ${error?.cause?.message ?? ''}`.toLowerCase();
    const koiosResponseMessage = `${error?.koiosResponse?.message ?? error?.koiosResponse?.error ?? ''}`.toLowerCase();
    const code = `${error?.code ?? ''}`.toLowerCase();
    const koiosCode = `${error?.koiosResponse?.code ?? ''}`.toLowerCase();
    const causeCode = `${error?.cause?.code ?? ''}`.toLowerCase();
    const status = Number(error?.status ?? error?.statusCode ?? error?.status_code ?? error?.koiosResponse?.status ?? error?.koiosResponse?.status_code);

    if ([429, 502, 503, 504].includes(status)) return true;
    if (koiosCode === 'pgrst003') return true;
    if (code === 'und_err_socket' || causeCode === 'und_err_socket') return true;
    if (message.includes('terminated')) return true;
    if (message.includes('socket')) return true;
    if (message.includes('econnreset')) return true;
    if (message.includes('fetch failed')) return true;
    if (message.includes('gateway timeout')) return true;
    if (message.includes('too many requests')) return true;
    if (message.includes('payload too large')) return true;
    if (message.includes('timed out acquiring connection from connection pool')) return true;
    if (koiosResponseMessage.includes('gateway timeout')) return true;
    if (koiosResponseMessage.includes('too many requests')) return true;
    if (koiosResponseMessage.includes('payload too large')) return true;
    if (koiosResponseMessage.includes('timed out acquiring connection from connection pool')) return true;

    return false;
};

const fetchTxInfoBatchWithRetryAndSplit = async (hashBatch: string[], attempt = 0): Promise<KoiosTxInfo[]> => {
    const body = getTxInfoBody(hashBatch);
    try {
        const txInfo = (await fetchKoios(`tx_info`, 'POST', body)) as KoiosTxInfo[] | null | { [key: string]: any };
        if (!txInfo) return [];
        if (!Array.isArray(txInfo)) {
            const error: any = new Error(`Unexpected tx_info response type`);
            error.koiosResponse = txInfo;
            throw error;
        }
        return txInfo;
    } catch (error: any) {
        const retriable = isRetriableKoiosTxInfoError(error);
        Logger.local({
            message: `tx_info request failed. retriable=${retriable} attempt=${attempt + 1}/${KOIOS_TX_INFO_MAX_RETRIES + 1} hashCount=${hashBatch.length} bodyLength=${body.length} firstHash=${hashBatch[0] ?? ''} lastHash=${hashBatch[hashBatch.length - 1] ?? ''} code=${error?.code ?? ''} causeCode=${error?.cause?.code ?? ''} error=${error?.message ?? error} cause=${error?.cause?.message ?? ''} curl="${getKoiosTxInfoDebugCurl(body)}"`,
            category: LogCategory.WARN,
            event: 'scannerLambda.koiosTxInfo.requestFailed'
        });

        if (!retriable) throw error;

        if (attempt < KOIOS_TX_INFO_MAX_RETRIES) {
            const backoff = KOIOS_TX_INFO_RETRY_BASE_DELAY_MS * (attempt + 1);
            await delayMs(backoff);
            return fetchTxInfoBatchWithRetryAndSplit(hashBatch, attempt + 1);
        }

        if (hashBatch.length <= 1) throw error;

        const midpoint = Math.ceil(hashBatch.length / 2);
        const leftBatch = hashBatch.slice(0, midpoint);
        const rightBatch = hashBatch.slice(midpoint);
        Logger.local({
            message: `Splitting tx_info batch after retries. originalCount=${hashBatch.length} leftCount=${leftBatch.length} rightCount=${rightBatch.length}`,
            category: LogCategory.WARN,
            event: 'scannerLambda.koiosTxInfo.splitBatch'
        });

        const [leftTxInfo, rightTxInfo] = [await fetchTxInfoBatchWithRetryAndSplit(leftBatch), await fetchTxInfoBatchWithRetryAndSplit(rightBatch)];
        return [...leftTxInfo, ...rightTxInfo];
    }
};

const getBatchedTxInfo = async (txHashes: string[]) => {
    const batchedTxHashes = getKoiosBatches(txHashes, '_tx_hashes');
    const txs: KoiosTxInfo[] = [];
    await asyncForEach(batchedTxHashes, async (hashBatch) => {
        const txInfo = await fetchTxInfoBatchWithRetryAndSplit(hashBatch);
        txs.push(...(txInfo ?? []));
    }, KOIOS_TX_INFO_MIN_INTERVAL_MS);
    return txs;
};

const getBatchedUTxOs = async (txHashes: string[], txs?: KoiosTxInfo[]) => {
    const txInfo = txs ?? await getBatchedTxInfo(txHashes);
    const utxos: UTxOWithTxInfo[] = [];
    utxos.push(...buildUTxOsFromKoiosTxs(txInfo));
    return utxos;
};

const getBatchedTxHashes = async (blockHashes: string[]) => {
    const batchedBlockHashes = getKoiosBatches(blockHashes, '_block_hashes');
    const txHashes: string[] = [];
    await asyncForEach(batchedBlockHashes, async (blockHashes) => {
        const txs = (await fetchKoios(`block_txs`, 'POST', JSON.stringify({ _block_hashes: blockHashes }))) as { tx_hash: string }[] | null;
        txHashes.push(...(txs?.map((tx) => tx.tx_hash) ?? []));
    });
    return txHashes;
};

const filterUTxOToHandleNames = (utxo: UTxOWithTxInfo, handleNames: Set<string>): UTxOWithTxInfo | undefined => {
    const filterAssets = (assets?: [string, string[]][]) =>
        assets?.map(([policy, names]) => {
            const filteredNames = names.filter((assetName) => assetName && handleNames.has(getHandleNameFromAssetName(assetName).name));
            return [policy, filteredNames] as [string, string[]];
        }).filter(([, names]) => names.length > 0);

    const filteredHandles = filterAssets(utxo.handles);
    if (!filteredHandles?.length) return undefined;

    return {
        ...utxo,
        handles: filteredHandles,
        mint: filterAssets(utxo.mint) ?? []
    };
};

const processRollback = async ({ currentSlot, rollbackOffset = 20, suppressNotify = false }: { currentSlot: number; rollbackOffset: number; suppressNotify?: boolean }) => {
    Logger.local(`Running rollback check - ${rollbackOffset}`);
    const latestBlockResponse = await blockfrostApiCall('blocks/latest');
    if (!latestBlockResponse.ok) {
        throw new Error('Not good!');
    }

    const latestBlock = await latestBlockResponse.json();
    const blockHeight = latestBlock.height - rollbackOffset;

    // Get all blocks/txs/UTxOs from Bf/Ko
    const blockList: BlockfrostBlock[] = await fetchPaginatedResults(`blocks/${blockHeight}/next`);
    const [firstBlock] = blockList;
    if (!firstBlock) return;

    const providerBlocks = blockList.filter((b) => b.slot <= currentSlot).sort((a, b) => a.slot - b.slot);
    if (!providerBlocks.length) return;

    // Get all of the UTxOs from db after that slot
    // Using the firstBlock.slot, we might get a UTxO that does not have Handles.
    const utxoIds = store.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, 0, { start: firstBlock.slot }) as string[];
    const utxos = store.pipeline(() => {
        utxoIds.forEach((utxoId) => handlesRepo.getUTxO(utxoId));
    }) as UTxOWithTxInfo[];

    const providerTxHashes = await getBatchedTxHashes(providerBlocks.map((b) => b.hash));
    const providerUTxOs: UTxOWithTxInfo[] = await getBatchedUTxOs(providerTxHashes);
    // sort provider UTxOs by slot ascending
    providerUTxOs.sort((a, b) => a.slot - b.slot);

    const handleNames: Set<string> = new Set();
    for (const utxo of [...providerUTxOs, ...utxos]) {
        for (const assets of utxo?.handles ?? []) {
            assets[1].forEach((assetName) => {
                const { name } = getHandleNameFromAssetName(assetName);
                handleNames.add(name);
            });
        }
    }
    
    const handles = [...handleNames];

    const storedHandles = store
        .pipeline(() => {
            handles.forEach((handleName) => {
                handlesRepo.getHandle(handleName);
            });
        })
        .filter(Boolean) as StoredHandle[];

    const batchedHandles: [string, string][][] = [];
    let storedHandlesIndex = 0;
    let assetNames: [string, string][] = [];
    while (storedHandlesIndex < storedHandles.length) {
        // TODO: deal with virtual subHandles
        const storedHandle = storedHandles[storedHandlesIndex];
        const { isCip67 } = getHandleNameFromAssetName(storedHandle.hex);

        assetNames.push([storedHandles[storedHandlesIndex].policy, storedHandles[storedHandlesIndex].hex]);

        if (isCip67) {
            const hexWithoutLabel = storedHandles[storedHandlesIndex].hex.slice(8);
            assetNames.push([storedHandles[storedHandlesIndex].policy, `${AssetNameLabel.LBL_100}${hexWithoutLabel}`]);
            assetNames.push([storedHandles[storedHandlesIndex].policy, `${AssetNameLabel.LBL_001}${hexWithoutLabel}`]);
        }

        if (JSON.stringify({ _asset_list: assetNames, _extended: true }).length >= 4700) {
            // Max possible ",[policy,handle]" length is 96
            batchedHandles.push(assetNames);
            assetNames = [];
        }
        storedHandlesIndex++;
        // last check if last handle
        if (storedHandlesIndex == storedHandles.length && assetNames.length) {
            batchedHandles.push(assetNames);
        }
    }

    const handleTxHashes: string[] = [];
    // This is a separate set of UTxOs representing the current Handle values (potentially different from above UTxOs)
    await asyncForEach(batchedHandles, async (handleNames) => {
        const body = JSON.stringify({ _asset_list: handleNames, _extended: true });
        const koiosUtxos = (await fetchKoios(`asset_utxos`, 'POST', body)) as KoiosAssetUTxO[] | null;
        if (koiosUtxos !== null) {
            // go through each asset and grab the data we need to test, tx_hash, tx_index, address
            for (const utxo of koiosUtxos) {
                handleTxHashes.push(utxo.tx_hash);
            }
        } else {
            // Handle not found in provider, we need to remove it from our store.
            // this can happen if a mint was rolled back and didn't return
            // Mostly possible with DEMI and Manually added Handles because handle.me uses Blockfrost
        }
    });

    const latestUTxOsForAffectedHandles = await getBatchedUTxOs(handleTxHashes);

    // find the intersection of providerUTxOs and latestUTxOsForAffectedHandles to get the latest UTxOs for the affected handles
    const latestIds = latestUTxOsForAffectedHandles.filter((u) => u.slot >= firstBlock.slot && u.slot <= currentSlot).map((u) => u.id);
    const latestProviderUTxOsForAffectedHandles = providerUTxOs.filter(p => latestIds.includes(p.id));

    // then find the differences between that and the utxos from our store to find any discrepancies
    const [latestProviderIds, apiIds] = [new Set(latestProviderUTxOsForAffectedHandles.map((u) => u.id)), new Set(utxos.map((u) => u.id))];
    const differences = [...latestProviderIds.symmetricDifference(apiIds)].map((id) => {
        return [...latestProviderUTxOsForAffectedHandles, ...utxos].find((u) => u.id === id);
    });

    if (differences.length) {
        const rollbackStartSlot = Math.min(...differences.map((u) => u?.slot ?? Infinity));
        if (!Number.isFinite(rollbackStartSlot)) return;

        const providerRollbackUTxOs = providerUTxOs.filter((utxo) => utxo.slot >= rollbackStartSlot);

        const firstMissingHeight = Math.min(...differences.map((u) => u?.blockNum ?? Infinity));
        const distanceFromTip = latestBlock.height - firstMissingHeight;
        Logger.log(`Rollback detected from slot ${rollbackStartSlot}${distanceFromTip === null ? '' : ` (${distanceFromTip} blocks from tip)`}`);

        const apiRollbackUtxos = utxos.filter((utxo): utxo is UTxOWithTxInfo => !!utxo && utxo.slot >= rollbackStartSlot);

        // This should be a notify since we are very rarely expecting in this range
        // and may need to adjust the number 20 above accordingly
        if (!suppressNotify && distanceFromTip! > 20) Logger.log({ category: LogCategory.NOTIFY, message: `Rollback at ${distanceFromTip} blocks detected! Block: ${firstMissingHeight}`, event: 'RollbackLambda' });
        // If there are any missing delete/replay
        setRecoveryFlag(RECOVERY_REASON_ROLLBACK);
        let rollbackComplete = false;
        try {
            // build the minting data for all handles in this range
            const handlesMintingData = store.pipeline(() => {
                handles.forEach((handleName) => handlesRepo.getHandleMintingData(handleName));
            }) as Set<string>[];

            // gets Handles and remove mints that happened in this range
            store.pipeline(() => {
                handles.forEach((handleName, index) => {
                    const mintingDataSet = handlesMintingData[index];
                    if (mintingDataSet) {
                        mintingDataSet.forEach((md) => {
                            const mintingData = JSON.parse(md) as MintingData;
                            if (mintingData.created_slot >= rollbackStartSlot) {
                                store.removeValueFromIndexedSet(IndexNames.MINT, handleName, md);
                            }
                        });
                    }
                });
            });

            const stakeAddresses = storedHandles.map((h) => buildHolderInfo(h.resolved_addresses.ada).address);

            // get a full list of holders so we can pass it into the updateHolder function later
            const holderHandles = store.pipeline(() => {
                stakeAddresses.forEach((address) => store.getValuesFromIndexedSet(IndexNames.HOLDER, address));
            }) as Set<string>[]; // array of sets of handle names for each holder address

            const holdersMap = new Map<string, Set<string>>();
            stakeAddresses.forEach((address, index) => {
                holdersMap.set(address, holderHandles[index]);
            });

            // update handle holders
            store.pipeline(() => {
                storedHandles.forEach((handle) => {
                    handlesRepo.updateHolder(handle, holdersMap);
                });
            });

            // delete all UTxOs after that slot and replay them all
            const utxoIdsToRemove = apiRollbackUtxos.map((utxo) => utxo.id);
            if (utxoIdsToRemove.length) {
                handlesRepo.removeUTxOs(utxoIdsToRemove);
            }

            // repopulate utxo store and minting data from Bf/Ko
            handlesRepo.addUTxOsWithMintData(providerRollbackUTxOs);

            const storedHandlesMap = new Map<string, StoredHandle>(storedHandles.map((h) => [h.name, h]));

            const retrievedMintingData = store.pipeline(() => {
                handles.forEach((handleName) => {
                    handlesRepo.getHandleMintingData(handleName);
                });
            }) as Set<string>[];

            const mintValueIndex: Map<string, MintingData[]> = new Map();
            retrievedMintingData.forEach((md, i) => {
                const handleName = handles[i];
                mintValueIndex.set(
                    handleName,
                    Array.from(md).map((md) => JSON.parse(md))
                );
            });

            const rollbackHandleSet = new Set(handles);
            store.pipeline(() => {
                for (const utxo of latestUTxOsForAffectedHandles) {
                    const filteredUTxO = filterUTxOToHandleNames(utxo, rollbackHandleSet);
                    if (!filteredUTxO) continue;
                    handlesRepo.updateHandleIndexes(filteredUTxO, mintValueIndex, storedHandlesMap);
                }
            });

            rollbackComplete = true;
        } finally {
            if (rollbackComplete) clearRecoveryFlag();
        }
    }
};

const checkRollback = async () => {
    const { currentSlot = 0 } = handlesRepo.getMetrics();
    try {
        handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.ROLLBACK_20, lockLambdasTimestamp: Date.now() });
        // 20 confirmation range once a minute
        // Get "20 ago block" (Blockfrost supports get by height/number)
        await processRollback({ currentSlot, rollbackOffset: 20 });

        // if (Date.now() - (handlesRepo.getMetrics().lastMaxRollbackCheck ?? 0) > 60 * 60 * 1000) {
        //     // Get "2160 ago block" (Blockfrost supports get by height/number)
        //     handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.ROLLBACK_2160, lockLambdasTimestamp: Date.now() });
        //     await processRollback({ currentSlot, rollbackOffset: 2160 });
        //     // Update last2160check
        //     handlesRepo.setMetrics({ lastMaxRollbackCheck: Date.now() });
        // }
    } finally {
        handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.UNLOCKED });
    }
};

const processReindex = async () => {
    setRecoveryFlag(RECOVERY_REASON_REINDEX);
    // Pause the lambdas (cron lock in redis)
    handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.REINDEX, lockLambdasTimestamp: Date.now() });

    Logger.log({ message: `Repopulating indexes from UTxOs to schema version ${store.getIndexSchemaVersion()}`, category: LogCategory.INFO, event: 'getStartingPoint.repopulateIndexesFromUTxOs' });
    try {
        // This function already chunks at a rate of about 20K every 10 seconds. 300K handles should take about 5 minutes
        store.repopulateIndexesFromUTxOs({
            [UTxOFunctionName.ADD_UTXO]: handlesRepo.addUTxO.bind(handlesRepo),
            [UTxOFunctionName.UPDATE_HANDLE_INDEXES]: handlesRepo.updateHandleIndexes.bind(handlesRepo)
        });
        handlesRepo.setMetrics({ indexSchemaVersion: store.getIndexSchemaVersion() });
        clearRecoveryFlag();
    } finally {
        handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.UNLOCKED });
    }
};

const ensureUTxOsReady = async () => {
    const { currentBlockHash, currentSlot, utxoSchemaVersion = 0 } = handlesRepo.getMetrics();
    const currentUTxOSchemaVersion = Number(store.getUTxOSchemaVersion());
    if (currentUTxOSchemaVersion <= Number(utxoSchemaVersion) && currentBlockHash && currentSlot) return;

    Logger.log({
        message: `UTxOs are repopulating. currentBlockHash=${currentBlockHash ?? ''} currentSlot=${currentSlot ?? ''} storedUTxOSchemaVersion=${utxoSchemaVersion} targetUTxOSchemaVersion=${currentUTxOSchemaVersion}`,
        category: LogCategory.WARN,
        event: 'scannerLambda.repopulateUTxOs'
    });
    await handlesRepo.getStartingPoint({
        [UTxOFunctionName.ADD_UTXO]: handlesRepo.addUTxO.bind(handlesRepo),
        [UTxOFunctionName.UPDATE_HANDLE_INDEXES]: handlesRepo.updateHandleIndexes.bind(handlesRepo)
    });
}

const clearStaleLockIfNeeded = (metrics: ReturnType<HandlesRepository['getMetrics']>) => {
    if (!metrics.lockLambdas || !isLockStale(metrics.lockLambdas, metrics.lockLambdasTimestamp)) return false;

    if (metrics.lockLambdas === LockedLambdaReason.SCANNING) {
        Logger.log({ message: `Scanner lambda has been locked for scanning for over 5 minutes, something is wrong!`, category: LogCategory.NOTIFY, event: 'scannerLambda.lockedTooLong' });
    }

    if ([LockedLambdaReason.ROLLBACK_20, LockedLambdaReason.ROLLBACK_2160].includes(metrics.lockLambdas)) {
        Logger.log({ message: `Scanner lambda has been locked for rollback for over 5 minutes, something is wrong!`, category: LogCategory.NOTIFY, event: 'scannerLambda.rollbackLockedTooLong' });
        setRecoveryFlag(RECOVERY_REASON_ROLLBACK);
    }

    if (metrics.lockLambdas === LockedLambdaReason.REINDEX) {
        Logger.log({ message: `Scanner lambda has been locked for reindexing for over 10 minutes, something is wrong!`, category: LogCategory.NOTIFY, event: 'scannerLambda.reindexLockedTooLong' });
        setRecoveryFlag(RECOVERY_REASON_REINDEX);
    }

    if (metrics.lockLambdas === LOCK_REASON_SNAPSHOT) {
        Logger.log({ message: `Scanner lambda has been locked for snapshotting for over 10 minutes, something is wrong!`, category: LogCategory.NOTIFY, event: 'scannerLambda.snapshotLockedTooLong' });
    }

    handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.UNLOCKED });
    return true;
};

const scan = async () => {
    Logger.local(`Running scan...`);
    const metrics = handlesRepo.getMetrics();
    // Is scanning fast enough to do this without MAX_TIP_SLOTS? Or a much higher one?
    handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.SCANNING, lockLambdasTimestamp: Date.now() });
    try {
        let bResp: { hash: string; slot: number; confirmations: number }[] = await fetchPaginatedResults(`blocks/${metrics.currentBlockHash}/next`);
        bResp.sort((a, b) => b.confirmations - a.confirmations);
        if (!bResp.length) {
            const latestBlockResponse = await blockfrostApiCall('blocks/latest');
            if (!latestBlockResponse.ok) {
                throw new Error('Unable to fetch latest block while checking scanner head');
            }
            const latestBlock = await latestBlockResponse.json();
            const latestSlot = Number(latestBlock?.slot ?? 0);
            const currentSlot = Number(metrics.currentSlot ?? 0);

            if (latestSlot > currentSlot && metrics.currentBlockHash && currentSlot > 0) {
                const rollbackOffset = latestSlot - currentSlot > ROLLBACK_20_SLOT_WINDOW ? 2160 : 20;
                Logger.local({
                    message: `No forward blocks found from ${metrics.currentBlockHash} while latest slot=${latestSlot} is ahead of current slot=${currentSlot}. Running rollback_${rollbackOffset}.`,
                    category: LogCategory.WARN,
                    event: 'scannerLambda.rollbackOnStaleHead'
                });
                await processRollback({ currentSlot, rollbackOffset, suppressNotify: true });
                return;
            }

            Logger.local(`No new blocks to process from ${metrics.currentBlockHash}`);
            return;
        }
        const txHashes = [...new Set(await getBatchedTxHashes(bResp.map((b) => b.hash)))];
        const txList = await getBatchedTxInfo(txHashes);
        const txInfoByBlockHash = new Map<string, KoiosTxInfo[]>();
        for (const tx of txList) {
            const blockHash = tx?.block_hash;
            if (!blockHash) continue;
            const existing = txInfoByBlockHash.get(blockHash) ?? [];
            existing.push(tx);
            txInfoByBlockHash.set(blockHash, existing);
        }
        for (const b of bResp) {
            const block = { id: b.hash, slot: b.slot, confirmations: b.confirmations };
            const blockTxList = txInfoByBlockHash.get(b.hash) ?? [];
            const builtUTxOs = buildUTxOsFromKoiosTxs(blockTxList);

            const handleNames = builtUTxOs.flatMap((u) => u.handles?.flatMap((h) => h[1].map((assetName) => getHandleNameFromAssetName(assetName).name)) ?? []) ?? [];
            Logger.local(`Processing block ${block.id} at slot ${block.slot} with ${builtUTxOs.length} UTxOs containing ${handleNames.join(', ')} handles from ${blockTxList.length} transactions`);

            builtUTxOs.forEach((utxo) => {
                // ********** BURNS ************* //
                const burnHandles = (store.pipeline(() => {
                    utxo.burn
                        ?.flatMap((b) => b[1])
                        .forEach((hex) => {
                            handlesRepo.getHandle(getHandleNameFromAssetName(hex).name);
                        });
                }) as (StoredHandle | undefined)[]).filter((burned): burned is StoredHandle => !!burned);

                const uniqueBurnHandles = Array.from(new Map(burnHandles.map((handle) => [handle.name, handle])).values());
                store.pipeline(() => {
                    uniqueBurnHandles.forEach((burned) => {
                        handlesRepo.removeHandle(burned);
                    });
                });
            });

            // ********* UPDATES ************ //
            handlesRepo.addUTxOsWithMintDataAndUpdateIndexes(builtUTxOs);

            // ******** SPENT UTxOs *********** //
            const spentUtxoIds = blockTxList.flatMap((tx) => tx.inputs).map((input) => `${input.tx_hash}#${input.tx_index}`);
            if (spentUtxoIds.length) handlesRepo.removeUTxOs(spentUtxoIds);

            handlesRepo.setMetrics({
                currentSlot: block.slot,
                currentBlockHash: block.id,
                tipBlockHash: bResp[bResp.length - 1].hash,
                lastSlot: bResp[bResp.length - 1].slot
            });
        }
    } catch (error: any) {
        Logger.log({ message: `Error in scanner lambda: ${error.message}`, category: LogCategory.ERROR, event: 'scannerLambda.error' });
        throw error;
    } finally {
        handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.UNLOCKED });
    }
};

export const lambdaHandler = async (event: AWSLambda.ALBEvent, context: AWSLambda.Context) => {
    store.initialize();
    const leaseOwner = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    if (!acquireScannerLease(leaseOwner)) {
        Logger.local('Scanner lease is active in another invocation, skipping');
        return;
    }

    let heartbeat: NodeJS.Timeout | undefined;
    try {
        heartbeat = setInterval(() => {
            try {
                if (!renewScannerLease(leaseOwner)) {
                    Logger.local('Scanner lease renewal failed, another invocation may take over soon');
                }
            } catch (error: any) {
                Logger.log({ message: `Scanner lease heartbeat failed: ${error.message}`, category: LogCategory.ERROR, event: 'scannerLambda.leaseHeartbeat' });
            }
        }, SCANNER_LEASE_HEARTBEAT_MS);
        heartbeat.unref?.();

        await ensureInitialized();
        const metrics = handlesRepo.getMetrics();
        if (metrics.lockLambdas) {
            Logger.local(`Lambda is locked with: ${metrics.lockLambdas}, skipping`);
            if (!clearStaleLockIfNeeded(metrics)) return;
        }

        const recoveryFlag = getRecoveryFlag();
        if (recoveryFlag) {
            Logger.log({ message: `Recovery flag '${recoveryFlag}' detected. Running index repair before scan.`, category: LogCategory.NOTIFY, event: 'scannerLambda.recoveryFlag' });
            await processReindex();
            return;
        }

        // ******** REINDEXING CHECK ********* //
        await ensureUTxOsReady();
        if (Number(store.getIndexSchemaVersion()) > (handlesRepo.getMetrics().indexSchemaVersion ?? 0)) {
            await processReindex();
            return;
        }

        await scan();
        await checkRollback();

        return {
            isBase64Encoded: false,
            statusCode: 200,
            body: ''
        };
    } finally {
        if (heartbeat) clearInterval(heartbeat);
        try {
            releaseScannerLease(leaseOwner);
        } catch (error: any) {
            Logger.log({ message: `Failed to release scanner lease: ${error.message}`, category: LogCategory.ERROR, event: 'scannerLambda.leaseRelease' });
        }
    }
};

export const Internal = {
    checkRollback,
    processRollback,
    processReindex,
    scan
};
