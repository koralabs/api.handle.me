import 'dotenv/config';
import { isDeepStrictEqual } from 'node:util';
import { CardanoTxEvent, CardanoWatchClient } from '@utxorpc/sdk';
import { HANDLE_POLICIES, Network, NETWORK } from '@koralabs/kora-labs-common';
import { KoiosTxInfo } from '../interfaces/provider.interface';
import { consumeCompleteDemeterBlocks, DemeterBlock, getDemeterConfig } from '../services/demeter/utxorpc.service';
import { blockfrostApiCall, fetchBlockfrostTxHashes, fetchBlockfrostTxInfo } from '../utils/helpers';

interface BlockfrostBlock {
    hash: string;
    height: number;
    slot: number;
}

const confirmations = Number(process.env.PARITY_CONFIRMATIONS ?? 20);
const blockCount = Number(process.env.PARITY_BLOCK_COUNT ?? 100);
const endHeight = process.env.PARITY_END_HEIGHT ? Number(process.env.PARITY_END_HEIGHT) : undefined;
const policies = Object.keys(HANDLE_POLICIES[NETWORK.toLowerCase() as Network] ?? {});
const policySet = new Set(policies);
const fromHex = (value: string) => Uint8Array.from(Buffer.from(value, 'hex'));

if (!Number.isSafeInteger(confirmations) || confirmations < 1) throw new Error('PARITY_CONFIRMATIONS must be a positive integer');
if (!Number.isSafeInteger(blockCount) || blockCount < 1) throw new Error('PARITY_BLOCK_COUNT must be a positive integer');
if (endHeight !== undefined && (!Number.isSafeInteger(endHeight) || endHeight < 1)) throw new Error('PARITY_END_HEIGHT must be a positive integer');
if (!policies.length) throw new Error(`No Handle policies configured for ${NETWORK}`);

const fetchBlock = async (id: string | number): Promise<BlockfrostBlock> => {
    const response = await blockfrostApiCall(`blocks/${id}`);
    if (!response.ok) throw new Error(`Blockfrost blocks/${id}: ${response.status} ${response.statusText}`);
    return response.json() as Promise<BlockfrostBlock>;
};

const watchEvents = async function* (start: BlockfrostBlock, signal: AbortSignal): AsyncIterable<CardanoTxEvent> {
    const { endpoint, apiKey } = getDemeterConfig();
    const client = new CardanoWatchClient({ uri: endpoint, headers: { 'dmtr-api-key': apiKey } });
    const stream = client.inner.watchTx({
        intersect: [{ slot: BigInt(start.slot), hash: fromHex(start.hash), height: BigInt(start.height) }],
        predicate: {
            anyOf: policies.map((policyId) => ({
                match: { chain: { case: 'cardano' as const, value: { movesAsset: { policyId: fromHex(policyId) } } } }
            }))
        }
    }, { signal });

    for await (const response of stream) {
        switch (response.action.case) {
            case 'apply':
            case 'undo': {
                const value = response.action.value;
                if (value.chain.case !== 'cardano' || value.block?.chain.case !== 'cardano') {
                    throw new Error('Demeter returned a non-Cardano WatchTx event');
                }
                yield { action: response.action.case, Tx: value.chain.value, Block: value.block.chain.value };
                break;
            }
            case 'idle':
                yield { action: 'idle', BlockRef: response.action.value };
                break;
            default:
                throw new Error('Demeter returned an unrecognized WatchTx event');
        }
    }
};

const touchesHandlePolicy = (tx: KoiosTxInfo) => [
    ...(tx.assets_minted ?? []),
    ...tx.inputs.flatMap(() => []),
    ...tx.outputs.flatMap((output) => output.asset_list ?? [])
].some((asset) => policySet.has(asset.policy_id));

const sortAssets = (assets: any[] = []) => assets.map((asset) => ({
    policy_id: asset.policy_id,
    asset_name: asset.asset_name,
    quantity: `${asset.quantity}`
})).sort((left, right) => `${left.policy_id}${left.asset_name}`.localeCompare(`${right.policy_id}${right.asset_name}`));

const normalizeTx = (tx: KoiosTxInfo) => ({
    tx_hash: tx.tx_hash,
    block_hash: tx.block_hash,
    block_height: tx.block_height,
    absolute_slot: tx.absolute_slot,
    inputs: tx.inputs.map((input) => `${input.tx_hash}#${input.tx_index}`),
    reference_inputs: (tx.reference_inputs ?? []).map((input) => `${input.tx_hash}#${input.tx_index}`),
    outputs: tx.outputs.map((output) => ({
        tx_index: output.tx_index,
        address: output.payment_addr.bech32,
        value: `${output.value}`,
        datum_hash: output.datum_hash ?? null,
        inline_datum: output.inline_datum?.bytes ?? null,
        reference_script: output.reference_script ? {
            type: output.reference_script.type,
            bytes: output.reference_script.bytes
        } : null,
        assets: sortAssets(output.asset_list)
    })),
    assets_minted: sortAssets(tx.assets_minted),
    metadata_721: tx.metadata?.['721'] ?? null
});

const main = async () => {
    const tip = await fetchBlock('latest');
    const end = await fetchBlock(endHeight ?? tip.height - confirmations);
    const boundary = await fetchBlock(end.height - blockCount);
    const expectedBlocks = new Map<number, BlockfrostBlock>();
    for (let height = boundary.height + 1; height < end.height; height++) {
        const block = await fetchBlock(height);
        expectedBlocks.set(height, block);
    }

    const demeterByHeight = new Map<number, DemeterBlock>();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 120_000);
    try {
        await consumeCompleteDemeterBlocks(
            watchEvents(boundary, abort.signal),
            { slot: end.slot, hash: end.hash },
            async (block) => demeterByHeight.set(block.ref.height, block)
        );
    } finally {
        clearTimeout(timer);
        abort.abort();
    }

    const mismatches: string[] = [];
    const payloadDifferences: { txHash: string; demeter: ReturnType<typeof normalizeTx>; legacy: ReturnType<typeof normalizeTx> }[] = [];
    let totalTransactions = 0;
    let matchingTransactions = 0;

    for (const [height, block] of expectedBlocks) {
        const demeterBlock = demeterByHeight.get(height);
        if (!demeterBlock) {
            mismatches.push(`Demeter omitted block ${height} (${block.hash})`);
            continue;
        }
        if (demeterBlock.ref.hash !== block.hash || demeterBlock.ref.slot !== block.slot) {
            mismatches.push(`Block identity mismatch at height ${height}: demeter=${demeterBlock.ref.hash}@${demeterBlock.ref.slot} legacy=${block.hash}@${block.slot}`);
            continue;
        }
        const demeter = demeterBlock.transactions;
        const txRows = await fetchBlockfrostTxHashes([block.hash]);
        totalTransactions += txRows.length;
        const legacy: KoiosTxInfo[] = [];
        for (const row of txRows) {
            const statusResponse = await blockfrostApiCall(`txs/${row.tx_hash}`);
            if (!statusResponse.ok) throw new Error(`Blockfrost txs/${row.tx_hash}: ${statusResponse.status} ${statusResponse.statusText}`);
            const status = await statusResponse.json() as { valid_contract?: boolean };
            if (status.valid_contract === false) continue;
            const tx = await fetchBlockfrostTxInfo(row.tx_hash);
            if (touchesHandlePolicy(tx)) legacy.push(tx);
        }
        matchingTransactions += legacy.length;

        const demeterHashes = demeter.map((tx) => tx.tx_hash);
        const legacyHashes = legacy.map((tx) => tx.tx_hash);
        if (!isDeepStrictEqual(demeterHashes, legacyHashes)) {
            mismatches.push(`Transaction order/set mismatch at block ${height}: demeter=${demeterHashes.join(',')} legacy=${legacyHashes.join(',')}`);
            continue;
        }
        for (let index = 0; index < legacy.length; index++) {
            const demeterTx = normalizeTx(demeter[index]);
            const legacyTx = normalizeTx(legacy[index]);
            if (!isDeepStrictEqual(demeterTx, legacyTx)) {
                mismatches.push(`Payload mismatch for ${legacy[index].tx_hash} at block ${height}`);
                payloadDifferences.push({ txHash: legacy[index].tx_hash, demeter: demeterTx, legacy: legacyTx });
            }
        }
    }

    const report = {
        network: NETWORK,
        boundary: { height: boundary.height, slot: boundary.slot, hash: boundary.hash },
        end: { height: end.height, slot: end.slot, hash: end.hash },
        blocks: expectedBlocks.size,
        totalTransactions,
        matchingTransactions,
        mismatches,
        payloadDifferences
    };
    console.log(JSON.stringify(report, null, 2));
    if (mismatches.length) process.exitCode = 2;
};

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
