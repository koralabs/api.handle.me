import { AssetNameLabel, HANDLE_POLICIES, IHandleFileContent, Network, NETWORK, checkNameLabel } from '@koralabs/kora-labs-common';
import { blockfrostApiCall } from './helpers';

interface BlockfrostPolicyAsset {
    asset: string;
    quantity: string;
}

export interface SnapshotVerification {
    verifiedAgainstChain: true;
    snapshotHandleCount: number;
    chainHandleCount: number;
    network: string;
    verifiedAtUtc: string;
}

export type VerifiedHandleFileContent = IHandleFileContent & {
    verification?: SnapshotVerification;
};

const isOwnerBearingHandleAsset = (assetName: string) => {
    if (!assetName) return false;
    const { isCip67, assetLabel } = checkNameLabel(assetName);
    return !isCip67 || assetLabel === AssetNameLabel.LBL_222 || assetLabel === AssetNameLabel.LBL_000;
};

const fetchPolicyOwnerHandleCount = async (policyId: string) => {
    let count = 0;
    let page = 1;

    while (true) {
        const response = await blockfrostApiCall(`assets/policy/${policyId}?count=100&page=${page}&order=asc`);
        if (response.status === 404) break;
        if (!response.ok) {
            throw new Error(`Blockfrost assets/policy/${policyId} failed with ${response.status} ${response.statusText}`);
        }

        const assets = (await response.json()) as BlockfrostPolicyAsset[];
        count += assets.filter((asset) => Number(asset.quantity) > 0 && isOwnerBearingHandleAsset(asset.asset.slice(policyId.length))).length;

        if (assets.length < 100) break;
        page += 1;
    }

    return count;
};

export const getChainOwnerHandleCount = async () => {
    if (!process.env.BLOCKFROST_API_KEY?.trim()) {
        throw new Error('BLOCKFROST_API_KEY is required for chain-verified snapshot generation');
    }

    const network = (NETWORK.toLowerCase() || 'preview') as Network;
    let count = 0;

    for (const policyId of Object.keys(HANDLE_POLICIES[network])) {
        count += await fetchPolicyOwnerHandleCount(policyId);
    }

    return count;
};

export const buildSnapshotVerification = async (snapshotHandleCount: number): Promise<SnapshotVerification> => {
    const chainHandleCount = await getChainOwnerHandleCount();

    if (snapshotHandleCount !== chainHandleCount) {
        throw new Error(`Snapshot handle count mismatch: snapshot=${snapshotHandleCount}, chain=${chainHandleCount}`);
    }

    return {
        verifiedAgainstChain: true,
        snapshotHandleCount,
        chainHandleCount,
        network: NETWORK.toLowerCase() || 'preview',
        verifiedAtUtc: new Date().toISOString()
    };
};

export const isChainVerifiedSnapshot = (snapshot: VerifiedHandleFileContent) => {
    return snapshot.verification?.verifiedAgainstChain === true
        && snapshot.verification.snapshotHandleCount === snapshot.verification.chainHandleCount
        && snapshot.verification.network === (NETWORK.toLowerCase() || 'preview');
};
