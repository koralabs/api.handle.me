import { BlockPraos, Transaction } from '@cardano-ogmios/schema';
import { HandlesRepository } from '../repositories/handlesRepository';
import { buildOgmiosTransaction } from '../services/ogmios/utils';
import { processBlock } from '../services/processBlock';
import { RedisHandlesStore } from '../stores/redis';
import { fetchPaginatedResults, fetchTxList } from '../utils/helpers';

const MAX_TIP_SCAN_SLOTS = 60 * 30 // 30 mins of blocks

export const lambdaHandler = async (event: AWSLambda.ALBEvent, context:AWSLambda.Context) => {
    const store = new RedisHandlesStore(); // I hate this
    await store.initialize();
    const handlesRepo = new HandlesRepository(store);
    const { lastSlot = Infinity, currentSlot = 0, currentBlockHash, lockLambdas } = handlesRepo.getMetrics();

    if (lockLambdas) {
        // we probably need some recovery checks/notify here
        return
    };
    
    if (Number(store.getIndexSchemaVersion()) > (handlesRepo.getMetrics().indexSchemaVersion ?? 0)) {
        // Pause the scanner 
        // Trigger reindex lambda
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
            
            for (const t of txList) {
                // - Convert to format that processBlock expects
                const tx = buildOgmiosTransaction(t);
                //console.log('TX', JSON.stringify(tx, ( _, value) => typeof value == 'bigint' ? Number(value.toString()) : value, 4))
                block.transactions.push(tx);
            }

            // - Call processBlock
            processBlock(block as unknown as BlockPraos, handlesRepo);

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

