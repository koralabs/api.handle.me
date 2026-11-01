import { NETWORK } from '@koralabs/kora-labs-common';
import { isChainVerifiedSnapshot, validateSnapshot, VerifiedHandleFileContent } from './verifiedSnapshot';

const CURRENT_NETWORK = NETWORK.toLowerCase() || 'preview';

const makeSnapshot = (verification: Partial<VerifiedHandleFileContent['verification']> = {}): VerifiedHandleFileContent => ({
    verification: {
        verifiedAgainstChain: true,
        snapshotMptRootHash: 'ab'.repeat(32),
        chainMptRootHash: 'ab'.repeat(32),
        network: CURRENT_NETWORK,
        verifiedAtUtc: '2026-07-26T00:00:00.000Z',
        ...verification
    }
} as VerifiedHandleFileContent);

describe('verifiedSnapshot utilities', () => {
    const candidate = () => ({ ...makeSnapshot(), slot: 20, hash: 'cd'.repeat(32), utxoSchemaVersion: 1,
        utxos: [{ id: 'tx#0', tx_id: 'ef'.repeat(32), index: 0, blockHash: 'ab'.repeat(32), blockNum: 1,
            slot: 10, address: 'addr_test1xyz', lovelace: 1, handles: [], mint: [], metadata: {} }],
        mintingData: { alpha: [{ created_slot: 10, txHash: 'ef'.repeat(32), metadata: {} }] },
        scannedBlocks: [{ slot: 20, hash: 'cd'.repeat(32) }] });

    // Invariant: every DTO is checked, including later entries, before cache admission.
    // Negative control: removing the per-entry validation makes these corrupt candidates pass.
    it('accepts complete DTOs and the explicitly verified empty-set edge case', () => {
        expect(() => validateSnapshot(candidate(), 1)).not.toThrow();
        expect(() => validateSnapshot({ ...candidate(), utxos: [], mintingData: {} }, 1)).not.toThrow();
    });
    it.each([
        (s: any) => { s.utxos.push({ ...s.utxos[0], id: 'late#1', slot: -1 }); },
        (s: any) => { s.utxos.push(s.utxos[0]); },
        (s: any) => { s.utxos[0].handles = [['policy', null]]; },
        (s: any) => { s.mintingData.alpha[0].txHash = ''; },
        (s: any) => { s.scannedBlocks[0].slot = 21; },
        (s: any) => { delete s.verification.snapshotMptRootHash; delete s.verification.chainMptRootHash; },
        (s: any) => { s.verification.snapshotMptRootHash = ''; s.verification.chainMptRootHash = ''; },
        (s: any) => { s.utxoSchemaVersion = 2; }
    ])('rejects invalid complete candidates %#', mutate => {
        const snapshot = candidate();
        mutate(snapshot);
        expect(() => validateSnapshot(snapshot, 1)).toThrow(/Invalid/);
    });
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
