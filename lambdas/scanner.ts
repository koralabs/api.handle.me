import { BlockPraos, Metadatum, Transaction } from '@cardano-ogmios/schema';
import { HandlesRepository } from '../repositories/handlesRepository';
import { processBlock } from '../services/processBlock';
import { RedisHandlesStore } from '../stores/redis';
import { defaultKoiosSettings, fetchPaginatedResults } from '../utils/helpers';

const MAX_TIP_SCAN_SLOTS = 60 * 30 // 30 mins of blocks

export const lambdaHandler = async (event: AWSLambda.ALBEvent, context:AWSLambda.Context) => {
    const store = new RedisHandlesStore(); // I hate this
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

            const _tx_hashes = await fetchPaginatedResults(`blocks/${b.hash}/txs`);

            const txList: any[] = await fetchKoios(`tx_info`, 'POST', JSON.stringify({_tx_hashes, ...defaultKoiosSettings}));
            
            for (const t of txList) {
                // - Convert to format that processBlock expects
                const tx: Transaction = {
                    mint: t.assets_minted.reduce((acc: any, a: any) => {
                        (acc[a.policy_id] ??= {})[a.asset_name] = BigInt(a.quantity);
                        return acc;
                    }, {}),
                    id: t.tx_hash,
                    spends: 'inputs',
                    inputs: [],
                    outputs: t.outputs.map((o: any) => { return {
                        address: o.payment_addr.bech32,
                        value: {
                            ada: {lovelace: BigInt(o.value)},
                            ...o.asset_list?.reduce((acc: any, a: any) => {
                                (acc[a.policy_id] ??= {})[a.asset_name] = BigInt(a.quantity);
                                return acc;
                            }, {})
                        },
                        datum: o.inline_datum?.bytes,
                        script: o.reference_script ?? undefined
                    }}),
                    signatories: [],
                    metadata: {hash:'', labels: Object.fromEntries(Object.entries(t.metadata ?? {}).map(([label, value]) => [label, { json: value as Metadatum }]))}
                }
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
};
function fetchKoios(arg0: string, arg1: string, arg2: string): any[] | PromiseLike<any[]> {
    throw new Error('Function not implemented.');
}

