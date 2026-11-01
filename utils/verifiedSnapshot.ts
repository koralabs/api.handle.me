import { IHandleFileContent, NETWORK } from '@koralabs/kora-labs-common';

export interface SnapshotVerification {
    verifiedAgainstChain: boolean;
    snapshotMptRootHash: string;
    chainMptRootHash: string;
    network: string;
    verifiedAtUtc: string;
}

export type VerifiedHandleFileContent = IHandleFileContent & {
    verification?: SnapshotVerification;
    // Ledger of every canonical block the scanner has processed (including handle-free blocks),
    // captured at snapshot time. Reimported into the scanned-blocks ZSET so processRollback's
    // missed-block drift check behaves correctly immediately after an S3 reimport instead of
    // treating every canonical block as unseen during bootstrap.
    scannedBlocks?: { slot: number; hash: string }[];
};

const record = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const assetGroups = (value: unknown): boolean => Array.isArray(value) && value.every(group =>
    Array.isArray(group) && group.length === 2 && typeof group[0] === 'string' &&
    Array.isArray(group[1]) && group[1].every((asset: unknown) => typeof asset === 'string'));

/** Validate the entire candidate before any cache mutation. Verification is publisher metadata,
 * not an independent chain or full-payload attestation. */
export function validateSnapshot(value: unknown, schemaVersion: number): asserts value is VerifiedHandleFileContent {
    if (!record(value) || !natural(value.slot) || !hash(value.hash) || value.utxoSchemaVersion !== schemaVersion ||
        !Array.isArray(value.utxos) || !record(value.mintingData) || !isChainVerifiedSnapshot(value as VerifiedHandleFileContent)) {
        throw new Error('Invalid snapshot envelope, schema or verification');
    }
    const ids = new Set<string>();
    for (const utxo of value.utxos) {
        if (!record(utxo) || typeof utxo.id !== 'string' || !utxo.id || ids.has(utxo.id) ||
            !hash(utxo.tx_id) || !hash(utxo.blockHash) || !natural(utxo.index) || !natural(utxo.blockNum) ||
            !natural(utxo.slot) || utxo.slot > value.slot || typeof utxo.address !== 'string' || !utxo.address ||
            !natural(utxo.lovelace) || !assetGroups(utxo.handles) || !assetGroups(utxo.mint) ||
            (utxo.burn !== undefined && !assetGroups(utxo.burn)) ||
            (utxo.datum !== undefined && typeof utxo.datum !== 'string') ||
            (utxo.script !== undefined && (!record(utxo.script) || typeof utxo.script.type !== 'string' || typeof utxo.script.cbor !== 'string'))) {
            throw new Error('Invalid or duplicate snapshot UTxO');
        }
        ids.add(utxo.id);
    }
    for (const entries of Object.values(value.mintingData)) {
        if (!Array.isArray(entries) || !entries.every(md => record(md) && natural(md.created_slot) && md.created_slot <= value.slot && hash(md.txHash))) {
            throw new Error('Invalid snapshot minting data');
        }
    }
    if (value.scannedBlocks !== undefined && (!Array.isArray(value.scannedBlocks) ||
        !value.scannedBlocks.every(block => record(block) && natural(block.slot) && block.slot <= value.slot && hash(block.hash)))) {
        throw new Error('Invalid snapshot scanned blocks');
    }
}

export const isChainVerifiedSnapshot = (snapshot: VerifiedHandleFileContent) => {
    return snapshot?.verification?.verifiedAgainstChain === true
        && /^[a-f0-9]{64}$/i.test(snapshot.verification.snapshotMptRootHash)
        && snapshot.verification.snapshotMptRootHash === snapshot.verification.chainMptRootHash
        && snapshot.verification.network === (NETWORK.toLowerCase() || 'preview');
};
