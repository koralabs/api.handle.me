import { Transaction } from '@cardano-ogmios/schema';
import { buildOgmiosTransaction } from '../services/ogmios/utils';
import { blockfrostApiCall, fetchTxList } from '../utils/helpers';

// - Get blocks fom Blockfrost
const b: { hash: string; slot: number } =  await (await blockfrostApiCall(`blocks/919f2d703f8d7b55580fdd7c75111cd5930a57c0497d123fc1039e92a00da80a`)).json();

const block = { id: b.hash, slot: b.slot, transactions: [] as Transaction[] };

const txList = await fetchTxList(b.hash);

for (const t of txList) {
    // - Convert to format that processBlock expects
    const tx = buildOgmiosTransaction(t);
    block.transactions.push(tx);
}

console.log(
    'BLOCK',
    JSON.stringify(block, (_, value) => (typeof value == 'bigint' ? Number(value.toString()) : value), 4)
);

process.exit(0);

