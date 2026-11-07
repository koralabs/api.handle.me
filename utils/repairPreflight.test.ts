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

// A duplicate or ambiguous chain output and changed repository identity must fail closed.
// Removing either validation admits a plan whose target cannot be safely identified.
it('rejects duplicate outputs and changed stored identity', async () => {
    await expect(repairPreflight([target], lease(), () => stored, () => source, async () => [output, output])).rejects.toThrow('duplicate canonical output');
    await expect(repairPreflight([target], lease(), () => ({ ...stored, hex: 'different' }), () => source, async () => [output])).rejects.toThrow('identity changed');
    await expect(repairPreflight([target], lease(), () => stored, () => null, async () => [output])).rejects.toThrow('source output is missing');
    const sharedSource = { ...source, handles: [[policy, [target.hex, Buffer.from('sibling').toString('hex')]]] as [string, string[]][] };
    await expect(repairPreflight([target], lease(), () => stored, () => sharedSource, async () => [output])).rejects.toThrow('Source output contains an unplanned handle');
});
