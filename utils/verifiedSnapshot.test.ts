import { NETWORK } from '@koralabs/kora-labs-common';
import { isChainVerifiedSnapshot, VerifiedHandleFileContent } from './verifiedSnapshot';

const CURRENT_NETWORK = NETWORK.toLowerCase() || 'preview';

const makeSnapshot = (verification: Partial<VerifiedHandleFileContent['verification']> = {}): VerifiedHandleFileContent => ({
    verification: {
        verifiedAgainstChain: true,
        snapshotMptRootHash: 'abc123',
        chainMptRootHash: 'abc123',
        network: CURRENT_NETWORK,
        verifiedAtUtc: '2026-07-26T00:00:00.000Z',
        ...verification
    }
} as VerifiedHandleFileContent);

describe('verifiedSnapshot utilities', () => {
    it('accepts snapshots verified against the current chain root and network', () => {
        expect(isChainVerifiedSnapshot(makeSnapshot())).toBe(true);
    });

    it('rejects snapshots without verification metadata', () => {
        expect(isChainVerifiedSnapshot({} as VerifiedHandleFileContent)).toBe(false);
    });

    it('rejects snapshots that were not verified against chain', () => {
        expect(isChainVerifiedSnapshot(makeSnapshot({ verifiedAgainstChain: false }))).toBe(false);
    });

    it('rejects snapshots when the stored snapshot root differs from chain', () => {
        expect(isChainVerifiedSnapshot(makeSnapshot({ chainMptRootHash: 'different-root' }))).toBe(false);
    });

    it('rejects snapshots from a different network', () => {
        expect(isChainVerifiedSnapshot(makeSnapshot({ network: 'mainnet' }))).toBe(CURRENT_NETWORK === 'mainnet');
        expect(isChainVerifiedSnapshot(makeSnapshot({ network: 'definitely-not-current-network' }))).toBe(false);
    });
});
