import { IHandleFileContent, NETWORK } from '@koralabs/kora-labs-common';

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

export const isChainVerifiedSnapshot = (snapshot: VerifiedHandleFileContent) => {
    return snapshot.verification?.verifiedAgainstChain === true
        && snapshot.verification.snapshotMptRootHash === snapshot.verification.chainMptRootHash
        && snapshot.verification.network === (NETWORK.toLowerCase() || 'preview');
};
