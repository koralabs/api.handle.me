import type { StoredHandle } from '@koralabs/kora-labs-common';
import { repairPreflight } from './repairPreflight';

const policy = 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a';
const target = { name: 'alpha', policy, hex: Buffer.from('alpha').toString('hex') };
const stored = { ...target, utxo: 'old#0' } as StoredHandle;
const output = { id: 'new#1', address: 'addr', handles: [[policy, [target.hex]]] as [string, string[]][] };
const source = { ...output, id: 'old#0' };
const lease = () => {
    let owner = '';
    return {
        acquire: (token: string) => { if (owner) return false; owner = token; return true; },
        renew: (token: string) => token === owner,
        release: (token: string) => { if (owner === token) owner = ''; }
    };
};

// A stable fresh output is accepted, but a missing owner token cannot produce a repair plan.
// Removing the exact asset coverage check makes the missing-token case incorrectly succeed.
it('accepts a complete stable output and rejects a missing owner token', async () => {
    const lock = lease();
    expect(await repairPreflight([target], lock, () => stored, () => source, async () => [output])).toEqual({ stored: [stored], sources: [source], outputs: [output] });
    await expect(repairPreflight([target], lock, () => stored, () => source, async () => [])).rejects.toThrow('Owner token is missing');
});

// A competing scanner or an intervening repository update must prevent a plan.
// Removing lease admission or the second stored-state read allows unsafe repair to proceed.
it('rejects a held lease and a stored-state change during chain reads', async () => {
    const held = lease();
    expect(held.acquire('other')).toBe(true);
    await expect(repairPreflight([target], held, () => stored, () => source, async () => [output])).rejects.toThrow('Scanner lease is held');
    let reads = 0;
    await expect(repairPreflight([target], lease(), () => ++reads === 1 ? stored : { ...stored, utxo: 'newer#0' }, () => source, async () => [output])).rejects.toThrow('Stored state changed');
});

// A stale stored identity can be planned only when explicitly named and both outputs contain the canonical token.
// Using the canonical hex for the stored-identity check rejects the valid case; ignoring storedHex accepts an intervening change.
it('validates explicitly different stored and canonical identities', async () => {
    const changed = { ...target, storedHex: '6c6567616379' };
    const stale = { ...stored, hex: changed.storedHex };
    expect(await repairPreflight([changed], lease(), () => stale, () => source, async () => [output])).toEqual({ stored: [stale], sources: [source], outputs: [output] });
    await expect(repairPreflight([changed], lease(), () => stored, () => source, async () => [output])).rejects.toThrow('Stored target identity changed');
    await expect(repairPreflight([changed], lease(), () => stale, () => ({ ...source, handles: [[policy, [changed.storedHex]]] }), async () => [output])).rejects.toThrow('Stored target is absent from its source output');
});

// Interrupted repairs may temporarily reference both the journaled destination and an old
// source; arbitrary duplicates or a changed recorded destination must still be rejected.
// Removing the exact recorded-output check admits an unjournaled duplicate.
it('only accepts duplicate source tokens from an exact journaled destination', async () => {
    const second = { name: 'beta', policy, hex: Buffer.from('beta').toString('hex') };
    const assets = [target.hex, second.hex];
    const old = { ...source, handles: [[policy, assets]] as [string, string[]][] };
    const dest = { ...output, handles: [[policy, assets]] as [string, string[]][] };
    const handles = [{ ...stored, utxo: old.id }, { ...second, utxo: dest.id } as StoredHandle];
    const getHandle = (name: string) => handles.find(handle => handle.name === name) ?? null;
    const getOutput = (id: string) => id === old.id ? old : dest;
    const current = { ...dest, id: 'canonical#0' };
    await expect(repairPreflight([target, second], lease(), getHandle, getOutput, async () => [current])).rejects.toThrow('multiple source outputs');
    expect((await repairPreflight([target, second], lease(), getHandle, getOutput, async () => [current], [dest])).sources).toEqual([old, dest]);
    expect((await repairPreflight([target, second], lease(), getHandle, getOutput, async () => [dest])).sources).toEqual([old, dest]);
    await expect(repairPreflight([target, second], lease(), getHandle, getOutput, async () => [current], [{ ...dest, address: 'wrong' }])).rejects.toThrow('multiple source outputs');
    const third = { name: 'gamma', policy, hex: Buffer.from('gamma').toString('hex') };
    const allAssets = [...assets, third.hex];
    const firstOld = { ...old, handles: [[policy, allAssets]] as [string, string[]][] };
    const secondOld = { ...firstOld, id: 'other-old#0' };
    const recordedDest = { ...dest, handles: [[policy, allAssets]] as [string, string[]][] };
    const threeHandles = [{ ...stored, utxo: firstOld.id }, { ...second, utxo: recordedDest.id }, { ...third, utxo: secondOld.id }] as StoredHandle[];
    await expect(repairPreflight([target, second, third], lease(), name => threeHandles.find(handle => handle.name === name) ?? null,
        id => [firstOld, recordedDest, secondOld].find(item => item.id === id) ?? null, async () => [recordedDest], [recordedDest])).rejects.toThrow('multiple source outputs');
});

// Each Handle must point to a source containing its own token, not merely a
// different target's token elsewhere in the source collection.
// Removing the per-Handle source check admits swapped owner references.
it('rejects Handles whose stored source outputs do not contain their own tokens', async () => {
    const beta = { name: 'beta', policy, hex: Buffer.from('beta').toString('hex') };
    const alphaSource = { ...source, handles: [[policy, [target.hex]]] as [string, string[]][] };
    const betaSource = { ...output, handles: [[policy, [beta.hex]]] as [string, string[]][] };
    const rows = [{ ...stored, utxo: betaSource.id }, { ...beta, utxo: alphaSource.id } as StoredHandle];
    await expect(repairPreflight([target, beta], lease(), name => rows.find(row => row.name === name) ?? null,
        id => [alphaSource, betaSource].find(row => row.id === id) ?? null, async () => [alphaSource, betaSource])).rejects.toThrow('Stored target is absent from its source output');
});

// A duplicate or ambiguous chain output and changed repository identity must fail closed.
// Removing either validation admits a plan whose target cannot be safely identified.
it('rejects duplicate outputs and changed stored identity', async () => {
    await expect(repairPreflight([target], lease(), () => stored, () => source, async () => [output, output])).rejects.toThrow('duplicate canonical output');
    await expect(repairPreflight([target], lease(), () => ({ ...stored, hex: 'different' }), () => source, async () => [output])).rejects.toThrow('identity changed');
    await expect(repairPreflight([target], lease(), () => stored, () => null, async () => [output])).rejects.toThrow('source output is missing');
    const sharedSource = { ...source, handles: [[policy, [target.hex, Buffer.from('sibling').toString('hex')]]] as [string, string[]][] };
    await expect(repairPreflight([target], lease(), () => stored, () => sharedSource, async () => [output])).rejects.toThrow('Source output contains an unplanned handle');
});
