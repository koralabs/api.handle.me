import { Trie } from '@aiken-lang/merkle-patricia-forestry';
import { decodeCborToJson } from '@koralabs/kora-labs-common/utils/cbor';
import { HANDLE_POLICIES, IHandleFileContent, LogCategory, Logger, Network, NETWORK } from '@koralabs/kora-labs-common';
import { blockfrostApiCall } from './helpers';

interface BlockfrostAssetTransaction {
    tx_hash: string;
}

interface BlockfrostTxUtxosResponse {
    outputs: {
        output_index: number;
        amount: {
            unit: string;
            quantity: string;
        }[];
        inline_datum?: string | null;
        data_hash?: string | null;
    }[];
}

interface BlockfrostDatumCborResponse {
    cbor: string;
}

export interface SnapshotVerification {
    verifiedAgainstChain: true;
    snapshotMptRootHash: string;
    chainMptRootHash: string;
    network: string;
    verifiedAtUtc: string;
}

export type VerifiedHandleFileContent = IHandleFileContent & {
    verification?: SnapshotVerification;
};

const MINTING_DATA_HANDLE_NAME = 'handle_root@handle_settings';
const EMPTY_MPT_ROOT_HASH = Buffer.alloc(32).toString('hex');

const getLegacyHandlePolicyId = () => {
    const network = (NETWORK.toLowerCase() || 'preview') as Network;
    const [legacyPolicyId] = Object.entries(HANDLE_POLICIES[network]).find(([, details]) => !details.isDeMi) ?? [];

    if (!legacyPolicyId) {
        throw new Error(`Legacy handle policy not configured for ${network}`);
    }

    return legacyPolicyId;
};

const getMintingDataAssetId = () => `${getLegacyHandlePolicyId()}${Buffer.from(MINTING_DATA_HANDLE_NAME, 'utf8').toString('hex')}`;

const fetchCurrentMintingDataDatumCbor = async () => {
    const assetId = getMintingDataAssetId();
    const assetTransactionsResponse = await blockfrostApiCall(`assets/${assetId}/transactions?order=desc&count=1`);
    if (!assetTransactionsResponse.ok) {
        throw new Error(`Blockfrost assets/${assetId}/transactions failed with ${assetTransactionsResponse.status} ${assetTransactionsResponse.statusText}`);
    }

    const [latestTransaction] = (await assetTransactionsResponse.json()) as BlockfrostAssetTransaction[];
    if (!latestTransaction?.tx_hash) {
        throw new Error(`Minting data UTxO not found for asset ${assetId}`);
    }

    const txUtxosResponse = await blockfrostApiCall(`txs/${latestTransaction.tx_hash}/utxos`);
    if (!txUtxosResponse.ok) {
        throw new Error(`Blockfrost txs/${latestTransaction.tx_hash}/utxos failed with ${txUtxosResponse.status} ${txUtxosResponse.statusText}`);
    }

    const txUtxos = (await txUtxosResponse.json()) as BlockfrostTxUtxosResponse;
    const output = txUtxos.outputs.find((candidate) => candidate.amount.some((amount) => amount.unit === assetId && amount.quantity !== '0'));
    if (!output) {
        throw new Error(`Minting data UTxO not found in transaction ${latestTransaction.tx_hash}`);
    }

    if (output.inline_datum?.trim()) {
        return output.inline_datum;
    }

    if (!output.data_hash) {
        throw new Error(`Minting data datum not found in transaction ${latestTransaction.tx_hash}`);
    }

    const datumResponse = await blockfrostApiCall(`scripts/datum/${output.data_hash}/cbor`);
    if (!datumResponse.ok) {
        throw new Error(`Blockfrost scripts/datum/${output.data_hash}/cbor failed with ${datumResponse.status} ${datumResponse.statusText}`);
    }

    const datum = (await datumResponse.json()) as BlockfrostDatumCborResponse;
    if (!datum.cbor?.trim()) {
        throw new Error(`Minting data datum cbor missing for ${output.data_hash}`);
    }

    return datum.cbor;
};

export const getChainMintingDataRootHash = async () => {
    if (!process.env.BLOCKFROST_API_KEY?.trim()) {
        throw new Error('BLOCKFROST_API_KEY is required for chain-verified snapshot generation');
    }

    const datumCbor = await fetchCurrentMintingDataDatumCbor();
    const decoded = decodeCborToJson({ cborString: datumCbor, schema: {} }) as { constructor_0?: [string] };
    const mptRootHash = `${decoded.constructor_0?.[0] ?? ''}`.replace(/^0x/i, '').toLowerCase();

    if (!/^[0-9a-f]{64}$/.test(mptRootHash)) {
        throw new Error(`Invalid minting data root hash in datum: ${JSON.stringify(decoded)}`);
    }

    return mptRootHash;
};

export const buildHandleSetMptRootHash = async (handleNames: string[]) => {
    const normalizedHandleNames = [...new Set(handleNames.map((handle) => `${handle}`.trim()).filter(Boolean))].sort();
    const trie = new Trie();
    for (const handleName of normalizedHandleNames) {
        await trie.insert(handleName, '');
    }

    return trie.hash?.toString('hex') ?? EMPTY_MPT_ROOT_HASH;
};

export const buildSnapshotVerification = async (handleNames: string[]): Promise<SnapshotVerification> => {
    const snapshotMptRootHash = await buildHandleSetMptRootHash(handleNames);
    const chainMptRootHash = await getChainMintingDataRootHash();

    if (snapshotMptRootHash !== chainMptRootHash) {
        Logger.log({
            message: `Snapshot MPT root mismatch: snapshot=${snapshotMptRootHash}, chain=${chainMptRootHash}`,
            category: LogCategory.WARN,
            event: 'snapshotVerification.mptRootMismatch'
        });
        throw new Error(`Snapshot MPT root mismatch: snapshot=${snapshotMptRootHash}, chain=${chainMptRootHash}`);
    }

    return {
        verifiedAgainstChain: true,
        snapshotMptRootHash,
        chainMptRootHash,
        network: NETWORK.toLowerCase() || 'preview',
        verifiedAtUtc: new Date().toISOString()
    };
};

export const isChainVerifiedSnapshot = (snapshot: VerifiedHandleFileContent) => {
    return snapshot.verification?.verifiedAgainstChain === true
        && snapshot.verification.snapshotMptRootHash === snapshot.verification.chainMptRootHash
        && snapshot.verification.network === (NETWORK.toLowerCase() || 'preview');
};
