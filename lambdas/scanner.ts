import { Transaction } from '@cardano-ogmios/schema';
import { StoredHandle } from '@koralabs/kora-labs-common';
import { HandlesRepository } from '../repositories/handlesRepository';
import { getHandleNameFromAssetName } from '../services/ogmios/utils';
import { RedisHandlesStore } from '../stores/redis';
import { buildUTxOsFromKoiosTxs, fetchPaginatedResults, fetchTxList } from '../utils/helpers';

const MAX_TIP_SCAN_SLOTS = 60 * 30 // 30 mins of blocks

export const lambdaHandler = async (event: AWSLambda.ALBEvent, context:AWSLambda.Context) => {
    const store = new RedisHandlesStore(); // I hate this
    const handlesRepo = new HandlesRepository(store);
    await handlesRepo.initialize();
    const { lastSlot = Infinity, currentSlot = 0, currentBlockHash, lockLambdas } = handlesRepo.getMetrics();

    if (lockLambdas) {
        // we probably need some recovery checks/notify here
        return
    }
    
    if (Number(store.getIndexSchemaVersion()) > (handlesRepo.getMetrics().indexSchemaVersion ?? 0)) {
        // Pause the lambdas 
        // Trigger reindex lambda
        // unpause the lambdas
        // exit
    }

    // Is scanning fast enough to do this without MAX_TIP_SLOTS? Or a much higher one?
    if (lastSlot - currentSlot <= MAX_TIP_SCAN_SLOTS) {
        const bResp: {hash: string, slot: number, confirmations: number}[] = await fetchPaginatedResults(`blocks/${currentBlockHash}/next`);
        bResp.sort((a, b) => b.confirmations - a.confirmations);
        for (const b of bResp) {
            const block = {id: b.hash, slot: b.slot, confirmations: b.confirmations, transactions: [] as Transaction[]}
            
            if (block.confirmations < 20) break;

            const txList = await fetchTxList(b.hash);
            
            const builtUTxOs = buildUTxOsFromKoiosTxs(txList ?? []);
            handlesRepo.addMintDataFromUTxOs(builtUTxOs);

            builtUTxOs.forEach((utxo) => {
                // ********** BURNS ************* //
                const burnHandles: StoredHandle[] = store.pipeline(() => {
                    utxo.burn?.flatMap(b => b[1]).forEach(hex => {
                        handlesRepo.getHandle(getHandleNameFromAssetName(hex).name);
                    });
                });
                store.pipeline(() => {
                    burnHandles.forEach(burned => {
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
    }
    
    return {
        isBase64Encoded: false,
        statusCode: 200,
        body: ''
    };
}
