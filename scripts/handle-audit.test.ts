import { compareBatch } from './handle-audit';

describe('ownership audit', () => {
    // A handle is current only when policy, asset name and the complete output reference agree.
    // Comparing only transaction hashes misses a move between outputs of the same transaction.
    it('reports a different output in the same transaction and ignores matching outputs', () => {
        const handles = [
            { name: 'current', policy: 'p', hex: '61', utxo: 'tx#0', updated_slot_number: 1 },
            { name: 'stale', policy: 'p', hex: '62', utxo: 'tx#0', updated_slot_number: 1 }
        ];
        const rows = [
            { tx_hash: 'tx', tx_index: 0, asset_list: [{ policy_id: 'p', asset_name: '61', quantity: '1' }] },
            { tx_hash: 'tx', tx_index: 1, asset_list: [{ policy_id: 'p', asset_name: '62', quantity: '1' }] }
        ];
        expect(compareBatch(handles, rows)).toEqual([{ name: 'stale', policy: 'p', hex: '62', stored: 'tx#0', canonical: ['tx#1'], status: 'mismatch' }]);
    });

    // Absent, ambiguous and wrong-policy assets are not proof that a handle is correct or burned.
    // Treating a missing match as success would omit both of these unresolved handles.
    it('reports missing and multiple matching outputs as unresolved', () => {
        const handles = [
            { name: 'missing', policy: 'p', hex: '61', utxo: 'old#0', updated_slot_number: 1 },
            { name: 'multiple', policy: 'p', hex: '62', utxo: 'old#0', updated_slot_number: 1 }
        ];
        const rows = [
            { tx_hash: 'x', tx_index: 0, asset_list: [{ policy_id: 'other', asset_name: '61', quantity: '1' }, { policy_id: 'p', asset_name: '62', quantity: '1' }] },
            { tx_hash: 'y', tx_index: 0, asset_list: [{ policy_id: 'p', asset_name: '62', quantity: '1' }] }
        ];
        expect(compareBatch(handles, rows)).toEqual([
            { name: 'missing', policy: 'p', hex: '61', stored: 'old#0', canonical: [], status: 'unresolved' },
            { name: 'multiple', policy: 'p', hex: '62', stored: 'old#0', canonical: ['x#0', 'y#0'], status: 'unresolved' }
        ]);
    });
});
