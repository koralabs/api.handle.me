import { BlockPraos, Metadatum, Transaction } from '@cardano-ogmios/schema';
import { NETWORK } from '@koralabs/kora-labs-common';
import { fetch } from 'cross-fetch';
import { HandlesRepository } from '../repositories/handlesRepository';
import { processBlock } from '../services/processBlock';
import { RedisHandlesStore } from '../stores/redis';

const koiosSettings = {_inputs: false, _withdrawals: false, _certs: false, _scripts: false, _bytecode: false, _governance: false, _metadata: true, _assets: true}
const MAX_TIP_SCAN_SLOTS = 60 * 30 // 30 mins of blocks

const blockfrostApiCall = async (endpointSegment: string) => {
    const headers = {
        project_id: process.env.BLOCKFROST_API_KEY ?? '',
        'Content-Type': 'application/json'
    };

    const url = `https://cardano-${NETWORK.toLowerCase()}.blockfrost.io/api/v0/${endpointSegment}`;
    return await fetch(url, {headers})
};

const fetchKoios = async(path: string, method = 'GET', body?: string) => {
    const url = `https://${NETWORK.toLowerCase() === 'mainnet' ? 'api' : NETWORK.toLowerCase()}.koios.rest/api/v1/${path}`;
    const res = await fetch(url, {
        method,
        headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.KOIOS_API_BEARER_TOKEN}`
        },
        body
    }).then((res) => res.json());

    return res;
}

export const lambdaHandler = async (event: AWSLambda.ALBEvent, context:AWSLambda.Context) => {
    // Get last block from Valkey
    const handlesRepo = new HandlesRepository(new RedisHandlesStore());
    const { lastSlot = Infinity, currentSlot = 0, currentBlockHash } = handlesRepo.getMetrics();
    
    if (lastSlot - currentSlot <= MAX_TIP_SCAN_SLOTS) {
        // - Get blocks fom Blockfrost

        // TODO: At MAX_TIP_SCAN_SLOTS of 30 mins, that should be ~90 blocks. But could exceed Blockfrost page limit of 100 
        const bResp: {hash: string, slot: number, confirmations: number}[] = await (await blockfrostApiCall(`blocks/${currentBlockHash}/next`)).json()
        bResp.sort((a, b) => b.confirmations - a.confirmations);
        for (const b of bResp) {
            const block = {id: b.hash, slot: b.slot, confirmations: b.confirmations, transactions: [] as Transaction[]}
            
            if (block.confirmations < 20) break;

            // TODO: This could theoretically be >100 (Blockfrost page limit). But eutxo says 100 is the current all time high
            const _tx_hashes = await (await blockfrostApiCall(`blocks/${b.hash}/txs`)).json()

            const txList: any[] = await (await fetchKoios(`tx_info`, 'POST', JSON.stringify({_tx_hashes, ...koiosSettings}))).json()
            
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
                    metadata: {hash:'', labels: Object.fromEntries(Object.entries(t.metadata).map(([label, value]) => [label, { json: value as Metadatum }]))}
                }
                //console.log('TX', JSON.stringify(tx, ( _, value) => typeof value == 'bigint' ? Number(value.toString()) : value, 4))
                block.transactions.push(tx);
            }

            // - Call processBlock
            processBlock(block as unknown as BlockPraos, handlesRepo) 

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
