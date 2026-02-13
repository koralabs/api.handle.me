import { Transaction } from '@cardano-ogmios/schema';
import { AssetNameLabel, asyncForEach, buildHolderInfo, IApiMetrics, IndexNames, LockedLambdaReason, LogCategory, Logger, MintingData, StoredHandle, UTxOFunctionName, UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import { BlockfrostBlock, KoiosAssetUTxO, KoiosTxInfo } from '../interfaces/provider.interface';
import { HandlesRepository } from '../repositories/handlesRepository';
import { getHandleNameFromAssetName } from '../services/ogmios/utils';
import { RedisHandlesStore } from '../stores/redis';
import { blockfrostApiCall, buildUTxOsFromKoiosTxs, defaultKoiosSettings, fetchKoios, fetchPaginatedResults, fetchTxList } from '../utils/helpers';

const startTime = Date.now();
const store = new RedisHandlesStore(); // I hate this
const handlesRepo = new HandlesRepository(store);
await handlesRepo.initialize();

const processRollback = async ({ currentSlot, rollbackOffset = 20 }: { currentSlot: number; rollbackOffset: number }) => {
    const latestBlockResponse = await blockfrostApiCall('blocks/latest');
    if (!latestBlockResponse.ok) {
        throw new Error('Not good!');
    }

    const latestBlock = await latestBlockResponse.json();
    const blockHeight = latestBlock.height - rollbackOffset;

    // Get all blocks/txs/UTxOs from Bf/Ko
    const blockList: BlockfrostBlock[] = await fetchPaginatedResults(`blocks/${blockHeight}/next`);
    const [firstBlock] = blockList;
    // Get all of the UTxOs from db after that slot
    const utxoIds = store.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, 0, { start: firstBlock.slot }) as string[];
    const utxos = store.pipeline(() => {
        utxoIds.forEach((utxoId) => handlesRepo.getUTxO(utxoId));
    }) as (UTxOWithTxInfo | null)[];

    const apiBlockHashes = new Set(utxos.filter(Boolean).map((u) => u!.blockHash));
    const providerBlockHashes = new Set(blockList.filter((b) => b.slot <= currentSlot).map((b) => b.hash));
    // Check for  API <--  missing UTxOs --> Bf/Ko

    const missingInApi = [...providerBlockHashes].some((x) => !apiBlockHashes.has(x));
    const missingInProvider = [...apiBlockHashes].some((x) => x && !providerBlockHashes.has(x));

    if (missingInApi || missingInProvider) {
        // This should be a notify since we are very rarely expecting in this range
        // and may need to adjust the number 20 above accordingly
        Logger.log({ message: `2160 Rollback detected! Missing in API: ${missingInApi}, Missing in Provider: ${missingInProvider}`, event: 'RollbackLambda' });
        // If there are any missing delete/replay
        const handles: string[] = [];
        for (const utxo of utxos) {
            for (const assets of utxo?.handles ?? []) {
                assets[1].forEach((assetName) => {
                    const { name } = getHandleNameFromAssetName(assetName);
                    handles.push(name);
                });
            }
        }

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
                        if (mintingData.created_slot >= firstBlock.slot) {
                            store.removeValueFromIndexedSet(IndexNames.MINT, handleName, md);
                        }
                    });
                }
            });
        });

        const storedHandles = store
            .pipeline(() => {
                handles.forEach((handleName) => {
                    handlesRepo.getHandle(handleName);
                });
            })
            .filter(Boolean) as StoredHandle[];
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
        const utxoIdsToRemove = utxos.filter((utxo): utxo is UTxOWithTxInfo => !!utxo && utxo.slot >= firstBlock.slot).map((utxo) => utxo.id);
        if (utxoIdsToRemove.length) {
            handlesRepo.removeUTxOs(utxoIdsToRemove);
        }

        // repopulate utxo store and minting data from Bf/Ko
        for (const block of blockList) {
            const txList = await fetchTxList(block.hash);
            const utxos = buildUTxOsFromKoiosTxs(txList);
            for (const utxo of utxos) {
                // We still need to handle burns
                handlesRepo.addUTxOAndMintData(utxo, false);
            }
        }

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

        const txHashes: string[] = [];
        // This is a separate set of UTxOs representing the current Handle values (potentially different from above UTxOs)
        await asyncForEach(batchedHandles, async (handleNames) => {
            const body = JSON.stringify({ _asset_list: handleNames, _extended: true });
            const koiosUtxos = (await fetchKoios(`asset_utxos`, 'POST', body)) as KoiosAssetUTxO[] | null;
            if (koiosUtxos !== null) {
                // go through each asset and grab the data we need to test, tx_hash, tx_index, address
                for (const utxo of koiosUtxos) {
                    txHashes.push(utxo.tx_hash);
                }
            } else {
                // Handle not found in provider, we need to remove it from our store.
                // this can happen if a mint was rolled back and didn't return
            }
        });

        const batchedTxHashes: string[][] = [];
        let batchesIndex = 0;
        let txHashesArray: string[] = [];
        while (batchesIndex < txHashes.length) {
            txHashesArray.push(txHashes[batchesIndex]);
            if (JSON.stringify({ _tx_hashes: txHashesArray, _metadata: true, _assets: true, _bytecode: true, _scripts: true }).length >= 4900) {
                // Max possible ",[policy,handle]" length is 96
                batchedTxHashes.push(txHashesArray);
                txHashesArray = [];
            }
            batchesIndex++;
            // last check if last handle
            if (batchesIndex == txHashes.length && txHashesArray.length) {
                batchedTxHashes.push(txHashesArray);
            }
        }

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

        await asyncForEach(batchedTxHashes, async (txHashes) => {
            const txs = (await fetchKoios(`tx_info`, 'POST', JSON.stringify({ _tx_hashes: txHashes, ...defaultKoiosSettings }))) as KoiosTxInfo[] | null;
            const builtUTxOs = buildUTxOsFromKoiosTxs(txs ?? []);
            store.pipeline(() => {
                for (const utxo of builtUTxOs) {
                    handlesRepo.updateHandleIndexes(utxo, mintValueIndex, storedHandlesMap);
                }
            });
        });
    }
};

const checkRollback = async (metrics: IApiMetrics) => {
    const { currentSlot = 0, lastMaxRollbackCheck = 0 } = metrics;
    try {
        // if it is time to run the 2160 then we don't have to run the 20
        if (Date.now() - lastMaxRollbackCheck > 60 * 60 * 1000) {
            // Get "2160 ago block" (Blockfrost supports get by height/number)
            handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.ROLLBACK_2160, lockLambdasTimestamp: startTime });
            await processRollback({ currentSlot, rollbackOffset: 2160 });
            // Update last2160check
            handlesRepo.setMetrics({ lastMaxRollbackCheck: Date.now() });
        } else {
            // 20 confirmation range once a minute
            // Get "20 ago block" (Blockfrost supports get by height/number)
            handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.ROLLBACK_20, lockLambdasTimestamp: startTime });
            await processRollback({ currentSlot, rollbackOffset: 20 });
        }
    } finally {
        handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.UNLOCKED });
    }
};

const processReindex = async () => {
    // Pause the lambdas (cron lock in redis)
    handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.REINDEX, lockLambdasTimestamp: startTime });

    Logger.log({ message: `Repopulating indexes from UTxOs to schema version ${store.getIndexSchemaVersion()}`, category: LogCategory.INFO, event: 'getStartingPoint.repopulateIndexesFromUTxOs' });
    // TODO: This should process in chunks of 10k or so then stop the lambda and it should restart and pick up where it left off.
    // This function already chunks at a rate of about 20K every 10 seconds. 300K handles should take about 5 minutes
    store.repopulateIndexesFromUTxOs({
        [UTxOFunctionName.ADD_UTXO]: handlesRepo.addUTxO.bind(handlesRepo),
        [UTxOFunctionName.UPDATE_HANDLE_INDEXES]: handlesRepo.updateHandleIndexes.bind(handlesRepo)
    });
    // Unpause the lambdas and set the new schema version
    handlesRepo.setMetrics({ indexSchemaVersion: store.getIndexSchemaVersion(), lockLambdas: LockedLambdaReason.UNLOCKED });
};

const scan = async (currentBlockHash: string) => {
    // Is scanning fast enough to do this without MAX_TIP_SLOTS? Or a much higher one?
    handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.SCANNING, lockLambdasTimestamp: startTime });
    try {
        const bResp: { hash: string; slot: number; confirmations: number }[] = await fetchPaginatedResults(`blocks/${currentBlockHash}/next`);
        bResp.sort((a, b) => b.confirmations - a.confirmations);
        for (const b of bResp) {
            const block = { id: b.hash, slot: b.slot, confirmations: b.confirmations, transactions: [] as Transaction[] };

            const txList = await fetchTxList(b.hash);

            const builtUTxOs = buildUTxOsFromKoiosTxs(txList ?? []);

            const handleNames = builtUTxOs.flatMap((u) => u.handles?.flatMap((h) => h[1].map((assetName) => getHandleNameFromAssetName(assetName).name)) ?? []) ?? [];
            console.log(`Processing block ${block.id} at slot ${block.slot} with ${builtUTxOs.length} UTxOs containing ${handleNames.join(', ')} handles from ${txList.length} transactions`);

            handlesRepo.addMintDataFromUTxOs(builtUTxOs);

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

                // ********* UPDATES ************ //
                handlesRepo.addUTxOAndMintData(utxo, true);
            });

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
    const metrics = handlesRepo.getMetrics();
    if (metrics.lockLambdas) {
        // we probably need some recovery checks/notify here
        console.log(`Lambda is locked with: ${metrics.lockLambdas}, skipping`);

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

    // await checkRollback();

    await scan(metrics.currentBlockHash ?? '');

    return {
        isBase64Encoded: false,
        statusCode: 200,
        body: ''
    };
};
