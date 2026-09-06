import { CardanoSyncClient, CardanoTxEvent, CardanoWatchClient } from '@utxorpc/sdk';
import { bech32 } from 'bech32';
import { KoiosTxInfo } from '../../interfaces/provider.interface';

export interface ChainPoint {
    slot: number;
    hash: string;
}

export interface DemeterBlockRef extends ChainPoint {
    height: number;
}

export interface DemeterBlock {
    ref: DemeterBlockRef;
    transactions: KoiosTxInfo[];
}

export class DemeterRollbackError extends Error {
    constructor(public readonly block: DemeterBlockRef) {
        super(`Demeter reported a rollback at slot ${block.slot} (${block.hash})`);
        this.name = 'DemeterRollbackError';
    }
}

export class DemeterDeadlineError extends Error {
    constructor(timeoutMs: number) {
        super(`Demeter WatchTx exceeded its ${timeoutMs}ms deadline`);
        this.name = 'DemeterDeadlineError';
    }
}

const toHex = (value?: Uint8Array): string => value?.length ? Buffer.from(value).toString('hex') : '';
const fromHex = (value: string): Uint8Array<ArrayBuffer> => Uint8Array.from(Buffer.from(value, 'hex'));

const unwrapBigInt = (value?: {
    bigInt?: { case?: 'int' | 'bigUInt' | 'bigNInt'; value?: bigint | Uint8Array };
}): bigint => {
    const number = value?.bigInt;
    if (!number?.case) return 0n;
    if (number.case === 'int') return number.value as bigint;
    const bytes = number.value as Uint8Array;
    const magnitude = bytes.length ? BigInt(`0x${toHex(bytes)}`) : 0n;
    return number.case === 'bigNInt' ? -1n - magnitude : magnitude;
};

const assetQuantity = (asset: any): bigint => unwrapBigInt(asset?.quantity?.value ?? asset?.quantity);

const renderAddress = (address: Uint8Array): string => {
    if (!address.length) throw new Error('Demeter returned an empty Cardano address');
    const type = address[0] >> 4;
    if (type > 7 && type < 14) {
        throw new Error(`Demeter returned unsupported Byron address bytes (${toHex(address).slice(0, 16)}...)`);
    }
    const network = (address[0] & 0x0f) === 1 ? '' : '_test';
    const prefix = type >= 14 ? `stake${network}` : `addr${network}`;
    return bech32.encode(prefix, bech32.toWords(address), 150);
};

const metadatumToJson = (value: any): unknown => {
    const datum = value?.metadatum;
    switch (datum?.case) {
        case 'int': {
            const number = datum.value as bigint;
            return number <= BigInt(Number.MAX_SAFE_INTEGER) && number >= BigInt(Number.MIN_SAFE_INTEGER)
                ? Number(number)
                : number.toString();
        }
        case 'bytes':
            return `0x${toHex(datum.value)}`;
        case 'text':
            return datum.value;
        case 'array':
            return datum.value.items.map(metadatumToJson);
        case 'map':
            return Object.fromEntries(datum.value.pairs.map((pair: any) => [String(metadatumToJson(pair.key)), metadatumToJson(pair.value)]));
        default:
            return null;
    }
};

const mapScript = (script: any): { bytes: string; type: string } | null => {
    switch (script?.script?.case) {
        case undefined:
            return null;
        case 'plutusV1':
        case 'plutusV2':
        case 'plutusV3':
            return { type: script.script.case, bytes: toHex(script.script.value) };
        default:
            throw new Error(`Demeter returned unsupported reference script type ${script.script.case}`);
    }
};

const mapAssets = (groups: any[] = []) => groups.flatMap((group) => group.assets.map((asset: any) => ({
    decimals: 0,
    quantity: assetQuantity(asset).toString(),
    policy_id: toHex(group.policyId),
    asset_name: toHex(asset.name),
    fingerprint: ''
})));

export const convertDemeterTx = (tx: any, block: any): KoiosTxInfo | null => {
    if (tx.successful === false) return null;
    const header = block?.header;
    if (!header?.hash?.length || !header.slot || !header.height) {
        throw new Error('Demeter transaction is missing its block header');
    }
    const txHash = toHex(tx.hash);
    if (!txHash) throw new Error('Demeter transaction is missing its hash');

    return {
        block_hash: toHex(header.hash),
        block_height: Number(header.height),
        absolute_slot: Number(header.slot),
        reference_inputs: (tx.referenceInputs ?? []).map((input: any) => ({
            tx_hash: toHex(input.txHash),
            tx_index: input.outputIndex
        })),
        outputs: (tx.outputs ?? []).map((output: any, index: number) => ({
            tx_hash: txHash,
            tx_index: index,
            datum_hash: output.datum?.hash?.length ? toHex(output.datum.hash) : null,
            stake_addr: null,
            value: unwrapBigInt(output.coin).toString(),
            payment_addr: {
                bech32: renderAddress(output.address),
                cred: ''
            },
            asset_list: mapAssets(output.assets),
            inline_datum: output.datum?.originalCbor?.length
                ? { bytes: toHex(output.datum.originalCbor), value: {} }
                : null,
            reference_script: mapScript(output.script)
        })),
        inputs: (tx.inputs ?? []).map((input: any) => ({
            tx_hash: toHex(input.txHash),
            tx_index: input.outputIndex
        })),
        tx_hash: txHash,
        assets_minted: mapAssets(tx.mint),
        metadata: Object.fromEntries((tx.auxiliary?.metadata ?? []).map((entry: any) => [
            entry.label.toString(),
            metadatumToJson(entry.value)
        ])) as KoiosTxInfo['metadata']
    };
};

const eventRef = (event: CardanoTxEvent): DemeterBlockRef => {
    const header = event.action === 'idle' ? event.BlockRef : event.Block.header;
    if (!header?.hash?.length || !header.slot || !header.height) {
        throw new Error('Demeter event is missing its block reference');
    }
    return {
        slot: Number(header.slot),
        hash: toHex(header.hash),
        height: Number(header.height)
    };
};

const sameBlock = (left: DemeterBlockRef, right: DemeterBlockRef) => left.slot === right.slot && left.hash === right.hash;

export const consumeCompleteDemeterBlocks = async (
    events: AsyncIterable<CardanoTxEvent>,
    targetTip: ChainPoint,
    onBlock: (block: DemeterBlock) => Promise<void>
): Promise<void> => {
    let pending: DemeterBlock | undefined;
    let lastCommittedHeight: number | undefined;
    const seenTxs = new Set<string>();

    for await (const event of events) {
        const ref = eventRef(event);
        if (event.action === 'undo') throw new DemeterRollbackError(ref);

        if (pending && sameBlock(pending.ref, ref)) {
            if (event.action === 'apply') {
                const txHash = toHex(event.Tx.hash);
                if (!seenTxs.has(txHash)) {
                    const tx = convertDemeterTx(event.Tx, event.Block);
                    if (tx) pending.transactions.push(tx);
                    seenTxs.add(txHash);
                }
            }
            continue;
        }

        if (pending) {
            if (ref.height !== pending.ref.height + 1) {
                throw new Error(`Demeter block stream skipped height ${pending.ref.height + 1}; saw ${ref.height}`);
            }
            await onBlock(pending);
            lastCommittedHeight = pending.ref.height;
            pending = undefined;
            seenTxs.clear();
        } else if (lastCommittedHeight !== undefined && ref.height !== lastCommittedHeight + 1) {
            throw new Error(`Demeter block stream skipped height ${lastCommittedHeight + 1}; saw ${ref.height}`);
        }

        if (ref.slot > targetTip.slot || ref.hash === targetTip.hash) return;
        if (ref.slot === targetTip.slot) {
            throw new Error(`Demeter stream reached slot ${ref.slot} on ${ref.hash}, but ReadTip reported ${targetTip.hash}`);
        }

        pending = { ref, transactions: [] };
        if (event.action === 'apply') {
            const txHash = toHex(event.Tx.hash);
            const tx = convertDemeterTx(event.Tx, event.Block);
            if (tx) pending.transactions.push(tx);
            seenTxs.add(txHash);
        }
    }

    throw new Error('Demeter WatchTx stream ended before reaching the ReadTip boundary');
};

const normalizeEndpoint = (endpoint: string): string => /^https?:\/\//.test(endpoint) ? endpoint : `https://${endpoint}`;

export const getDemeterConfig = () => {
    const endpoint = process.env.DEMETER_UTXORPC_ENDPOINT?.trim() ?? '';
    const apiKey = process.env.DEMETER_UTXORPC_API_KEY?.trim() ?? '';
    if (!endpoint || !apiKey) throw new Error('Demeter scanning requires DEMETER_UTXORPC_ENDPOINT and DEMETER_UTXORPC_API_KEY');
    return { endpoint: normalizeEndpoint(endpoint), apiKey };
};

export const isDemeterScannerEnabled = () => process.env.SCANNER_CHAIN_SOURCE?.trim().toLowerCase() === 'demeter';

let clients: { endpoint: string; apiKey: string; sync: CardanoSyncClient; watch: CardanoWatchClient } | undefined;

const getClients = () => {
    const { endpoint, apiKey } = getDemeterConfig();
    if (!clients || clients.endpoint !== endpoint || clients.apiKey !== apiKey) {
        const options = { uri: endpoint, headers: { 'dmtr-api-key': apiKey } };
        clients = {
            endpoint,
            apiKey,
            sync: new CardanoSyncClient(options),
            watch: new CardanoWatchClient(options)
        };
    }
    return clients;
};

const rawWatchEvents = async function* (
    start: ChainPoint,
    policies: string[],
    signal: AbortSignal
): AsyncIterable<CardanoTxEvent> {
    const predicate = {
        anyOf: policies.map((policyId) => ({
            match: {
                chain: {
                    case: 'cardano' as const,
                    value: { movesAsset: { policyId: fromHex(policyId) } }
                }
            }
        }))
    };
    const request = {
        intersect: [{ slot: BigInt(start.slot), hash: fromHex(start.hash), height: 0n }],
        predicate
    };
    const stream = getClients().watch.inner.watchTx(request, { signal });

    for await (const response of stream) {
        switch (response.action.case) {
            case 'apply':
            case 'undo': {
                const value = response.action.value;
                if (value.chain.case !== 'cardano' || value.block?.chain.case !== 'cardano') {
                    throw new Error('Demeter returned a non-Cardano WatchTx event');
                }
                yield {
                    action: response.action.case,
                    Tx: value.chain.value,
                    Block: value.block.chain.value
                };
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

export const scanDemeterBlocks = async (
    start: ChainPoint,
    policies: string[],
    timeoutMs: number,
    onBlock: (block: DemeterBlock, targetTip: ChainPoint) => Promise<void>
): Promise<ChainPoint> => {
    if (!policies.length) throw new Error('Demeter scanning requires at least one policy');
    const tip = await getClients().sync.readTip();
    const targetTip = { slot: Number(tip.slot), hash: tip.hash };
    if (targetTip.slot <= start.slot && targetTip.hash === start.hash) return targetTip;

    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    timer.unref?.();
    try {
        await consumeCompleteDemeterBlocks(
            rawWatchEvents(start, policies, abort.signal),
            targetTip,
            (block) => onBlock(block, targetTip)
        );
        return targetTip;
    } catch (error: any) {
        if (abort.signal.aborted) {
            throw new DemeterDeadlineError(timeoutMs);
        }
        throw error;
    } finally {
        clearTimeout(timer);
        abort.abort();
    }
};
