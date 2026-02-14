import { Transaction } from '@cardano-ogmios/schema';
import { AssetNameLabel, asyncForEach, buildHolderInfo, IndexNames, LockedLambdaReason, LogCategory, Logger, MintingData, StoredHandle, UTxOFunctionName, UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import { BlockfrostBlock, KoiosAssetUTxO, KoiosTxInfo } from '../interfaces/provider.interface';
import { HandlesRepository } from '../repositories/handlesRepository';
import { getHandleNameFromAssetName } from '../services/ogmios/utils';
import { RedisHandlesStore } from '../stores/redis';
import { blockfrostApiCall, buildUTxOsFromKoiosTxs, defaultKoiosSettings, fetchKoios, fetchPaginatedResults, fetchTxList } from '../utils/helpers';

const startTime = Date.now();
const store = new RedisHandlesStore(); // I hate this
const handlesRepo = new HandlesRepository(store);
let initialized = false;
const ensureInitialized = async () => {
    if (initialized) return;
    await handlesRepo.initialize();
    initialized = true;
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

const getBatchedUTxOs = async (txHashes: string[]) => {
    const batchedTxHashes = getKoiosBatches(txHashes, '_tx_hashes');
    const utxos: UTxOWithTxInfo[] = [];
    await asyncForEach(batchedTxHashes, async (txHashes) => {
        const txs = (await fetchKoios(`tx_info`, 'POST', JSON.stringify({ _tx_hashes: txHashes, ...defaultKoiosSettings }))) as KoiosTxInfo[] | null;
        const builtUTxOs = buildUTxOsFromKoiosTxs(txs ?? []);
        utxos.push(...builtUTxOs);
    });
    return utxos;
};

const getBatchedTxHashes = async (blockHashes: string[]) => {
    const batchedBlockHashes = getKoiosBatches(blockHashes, '_block_hashes');
    const txHashes: string[] = [];
    await asyncForEach(batchedBlockHashes, async (blockHashes) => {
        const txs = (await fetchKoios(`block_txs`, 'POST', JSON.stringify({ _block_hashes: blockHashes, ...defaultKoiosSettings }))) as { tx_hash: string }[] | null;
        txHashes.push(...(txs?.map((tx) => tx.tx_hash) ?? []));
    });
    return txHashes;
};

const processRollback = async ({ currentSlot, rollbackOffset = 20 }: { currentSlot: number; rollbackOffset: number }) => {
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
    console.log('UTXO_IDS', utxoIds);
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
    const [providerIds, latestIds] = [new Set(providerUTxOs.map((u) => u.id)), new Set(latestUTxOsForAffectedHandles.map((u) => u.id))];
    const latestProviderUTxOsForAffectedHandles = [...providerIds.intersection(latestIds)].map((id) => {
        return [...providerUTxOs, ...latestUTxOsForAffectedHandles].find((u) => u.id === id)!;
    });

    // then find the differences between that and the utxos from our store to find any discrepancies
    const [latestProviderIds, apiIds] = [new Set(latestProviderUTxOsForAffectedHandles.map((u) => u.id)), new Set(utxos.map((u) => u.id))];
    const differences = [...latestProviderIds.symmetricDifference(apiIds)].map((id) => {
        return [...latestProviderUTxOsForAffectedHandles, ...utxos].find((u) => u.id === id);
    });

    console.log('DIFFERENCES', differences);

    if (differences.length) {
        const rollbackStartSlot = Math.min(...differences.map((u) => u?.slot ?? Infinity));
        if (!Number.isFinite(rollbackStartSlot)) return;

        console.log('ROLLBACK_START_SLOT', rollbackStartSlot);

        const providerRollbackUTxOs = providerUTxOs.filter((utxo) => utxo.slot >= rollbackStartSlot);

        const firstMissingHeight = Math.min(...differences.map((u) => u?.blockNum ?? Infinity));
        const distanceFromTip = latestBlock.height - firstMissingHeight;
        Logger.local(`Rollback detected from slot ${rollbackStartSlot}${distanceFromTip === null ? '' : ` (${distanceFromTip} blocks from tip)`}`);

        const apiRollbackUtxos = utxos.filter((utxo): utxo is UTxOWithTxInfo => !!utxo && utxo.slot >= rollbackStartSlot);

        // This should be a notify since we are very rarely expecting in this range
        // and may need to adjust the number 20 above accordingly
        if (distanceFromTip! > 20) Logger.log({ category: LogCategory.NOTIFY, message: `Rollback at ${distanceFromTip} blocks detected! Block: ${firstMissingHeight}`, event: 'RollbackLambda' });
        // If there are any missing delete/replay

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

        store.pipeline(() => {
            for (const utxo of latestUTxOsForAffectedHandles) {
                handlesRepo.updateHandleIndexes(utxo, mintValueIndex, storedHandlesMap);
            }
        });
    }
};

const checkRollback = async () => {
    const { currentSlot = 0, lastMaxRollbackCheck = 0 } = handlesRepo.getMetrics();
    try {
        handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.ROLLBACK_20, lockLambdasTimestamp: startTime });
        // 20 confirmation range once a minute
        // Get "20 ago block" (Blockfrost supports get by height/number)
        await processRollback({ currentSlot, rollbackOffset: 20 });

        if (Date.now() - lastMaxRollbackCheck > 60 * 60 * 1000) {
            // Get "2160 ago block" (Blockfrost supports get by height/number)
            handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.ROLLBACK_2160, lockLambdasTimestamp: startTime });
            await processRollback({ currentSlot, rollbackOffset: 2160 });
            // Update last2160check
            handlesRepo.setMetrics({ lastMaxRollbackCheck: Date.now() });
        }
    } finally {
        handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.UNLOCKED });
    }
};

const processReindex = async () => {
    // Pause the lambdas (cron lock in redis)
    handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.REINDEX, lockLambdasTimestamp: startTime });

    Logger.log({ message: `Repopulating indexes from UTxOs to schema version ${store.getIndexSchemaVersion()}`, category: LogCategory.INFO, event: 'getStartingPoint.repopulateIndexesFromUTxOs' });
    try {
        // TODO: This should process in chunks of 10k or so then stop the lambda and it should restart and pick up where it left off.
        // This function already chunks at a rate of about 20K every 10 seconds. 300K handles should take about 5 minutes
        store.repopulateIndexesFromUTxOs({
            [UTxOFunctionName.ADD_UTXO]: handlesRepo.addUTxO.bind(handlesRepo),
            [UTxOFunctionName.UPDATE_HANDLE_INDEXES]: handlesRepo.updateHandleIndexes.bind(handlesRepo)
        });
        // Unpause the lambdas and set the new schema version
        handlesRepo.setMetrics({ indexSchemaVersion: store.getIndexSchemaVersion(), lockLambdas: LockedLambdaReason.UNLOCKED });
    } catch (error) {
        handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.UNLOCKED });
        throw error;
    }
};

const scan = async () => {
    Logger.local(`Running scan...`);
    const metrics = handlesRepo.getMetrics();
    // Is scanning fast enough to do this without MAX_TIP_SLOTS? Or a much higher one?
    handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.SCANNING, lockLambdasTimestamp: startTime });
    try {
        const bResp: { hash: string; slot: number; confirmations: number }[] = await fetchPaginatedResults(`blocks/${metrics.currentBlockHash}/next`);
        bResp.sort((a, b) => b.confirmations - a.confirmations);
        for (const b of bResp) {
            const block = { id: b.hash, slot: b.slot, confirmations: b.confirmations, transactions: [] as Transaction[] };

            const txList = await fetchTxList(b.hash);

            const builtUTxOs = buildUTxOsFromKoiosTxs(txList ?? []);

            const handleNames = builtUTxOs.flatMap((u) => u.handles?.flatMap((h) => h[1].map((assetName) => getHandleNameFromAssetName(assetName).name)) ?? []) ?? [];
            Logger.local(`Processing block ${block.id} at slot ${block.slot} with ${builtUTxOs.length} UTxOs containing ${handleNames.join(', ')} handles from ${txList.length} transactions`);

            builtUTxOs.forEach((utxo) => {
                // ********** BURNS ************* //
                const burnHandles: StoredHandle[] = store.pipeline(() => {
                    utxo.burn
                        ?.flatMap((b) => b[1])
                        .forEach((hex) => {
                            handlesRepo.getHandle(getHandleNameFromAssetName(hex).name);
                        });
                });
                store.pipeline(() => {
                    burnHandles.forEach((burned) => {
                        handlesRepo.removeHandle(burned);
                    });
                });
            });

            // ********* UPDATES ************ //
            handlesRepo.addUTxOsWithMintDataAndUpdateIndexes(builtUTxOs);

            // ******** SPENT UTxOs *********** //
            handlesRepo.removeUTxOs(txList.flatMap((tx) => tx.inputs).map((i) => `${i.tx_hash}#${i.tx_index}`));

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
    await ensureInitialized();
    const metrics = handlesRepo.getMetrics();
    if (metrics.lockLambdas) {
        // we probably need some recovery checks/notify here
        Logger.local(`Lambda is locked with: ${metrics.lockLambdas}, skipping`);

        // If it's locked because of scannin for longer than 5 minutes, we have a problem
        if (metrics.lockLambdas === LockedLambdaReason.SCANNING && metrics.lockLambdasTimestamp && Date.now() - metrics.lockLambdasTimestamp > 5 * 60 * 1000) {
            Logger.log({ message: `Scanner lambda has been locked for scanning for over 5 minutes, something is wrong!`, category: LogCategory.NOTIFY, event: 'scannerLambda.lockedTooLong' });
        }

        // If it's locked because of rollback for longer than 5 minutes, we have a problem
        if ([LockedLambdaReason.ROLLBACK_20, LockedLambdaReason.ROLLBACK_2160].includes(metrics.lockLambdas) && metrics.lockLambdasTimestamp && Date.now() - metrics.lockLambdasTimestamp > 5 * 60 * 1000) {
            Logger.log({ message: `Scanner lambda has been locked for rollback for over 5 minutes, something is wrong!`, category: LogCategory.NOTIFY, event: 'scannerLambda.rollbackLockedTooLong' });
        }

        // If it's locked because of reindexing for longer than 10 minutes, we have a problem
        if (metrics.lockLambdas === LockedLambdaReason.REINDEX && metrics.lockLambdasTimestamp && Date.now() - metrics.lockLambdasTimestamp > 10 * 60 * 1000) {
            Logger.log({ message: `Scanner lambda has been locked for reindexing for over 10 minutes, something is wrong!`, category: LogCategory.NOTIFY, event: 'scannerLambda.reindexLockedTooLong' });
        }

        return;
    }

    // ******** REINDEXING CHECK ********* //
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
};

export const Internal = {
    checkRollback,
    processRollback,
    processReindex,
    scan
};
