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

export const isChainVerifiedSnapshot = (snapshot: VerifiedHandleFileContent) => {
    return snapshot.verification?.verifiedAgainstChain === true
        && snapshot.verification.snapshotMptRootHash === snapshot.verification.chainMptRootHash
        && snapshot.verification.network === (NETWORK.toLowerCase() || 'preview');
};
