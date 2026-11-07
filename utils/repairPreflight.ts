import { randomUUID } from 'node:crypto';
import { AssetNameLabel, type StoredHandle } from '@koralabs/kora-labs-common';
import { getHandleNameFromAssetName } from '../services/ogmios/utils';

export interface RepairTarget { name: string; policy: string; hex: string; storedHex?: string }
export interface RepairOutput { id: string; address: string; handles: [string, string[]][] }
interface Lease {
    acquire(owner: string): boolean;
    renew(owner: string): boolean;
    release(owner: string): void;
}

/** Read-only validation only: never apply this result without a fenced commit and a new chain check. */
export async function repairPreflight(
    targets: RepairTarget[],
    lease: Lease,
    getHandle: (name: string) => StoredHandle | null,
    getStoredOutput: (id: string) => RepairOutput | null,
    readCanonical: (targets: RepairTarget[]) => Promise<RepairOutput[]>,
    recoveryOutputs: RepairOutput[] = []
) {
    if (!targets.length || new Set(targets.map(t => t.name)).size !== targets.length) throw new Error('Repair targets must be nonempty and unique');
    const owner = randomUUID();
    if (!lease.acquire(owner)) throw new Error('Scanner lease is held');
    const assertLease = () => { if (!lease.renew(owner)) throw new Error('Scanner lease lost'); };
    try {
        assertLease();
        const stored = targets.map(t => getHandle(t.name));
        if (stored.some((h, i) => !h || h.name !== targets[i].name || h.policy !== targets[i].policy || h.hex !== (targets[i].storedHex ?? targets[i].hex) || !h.utxo)) {
            throw new Error('Stored target identity changed or is missing');
        }
        const sourceIds = [...new Set(stored.map(h => h!.utxo!))];
        const sources = sourceIds.map(id => getStoredOutput(id));
        if (sources.some((u, i) => !u || u.id !== sourceIds[i])) throw new Error('Stored source output is missing');
        const first = await readCanonical(targets);
        assertLease();
        const second = await readCanonical(targets);
        assertLease();
        if (JSON.stringify(first) !== JSON.stringify(second)) throw new Error('Canonical state changed during preflight');
        if (JSON.stringify(stored) !== JSON.stringify(targets.map(t => getHandle(t.name))) || JSON.stringify(sources) !== JSON.stringify(sourceIds.map(id => getStoredOutput(id)))) throw new Error('Stored state changed during preflight');
        for (let i = 0; i < targets.length; i++) {
            const source = sources.find(output => output?.id === stored[i]!.utxo)!;
            if (!source.handles.some(([policy, assets]) => policy === targets[i].policy && assets.includes(targets[i].hex))) throw new Error('Stored target is absent from its source output');
        }
        const targetByAsset = new Map(targets.map(t => [`${t.policy}:${t.hex}`, t]));
        const verifyOutputs = (outputs: RepairOutput[], kind: 'Source' | 'Canonical') => {
            const found = new Map<string, RepairOutput[]>();
            const outputIds = new Set<string>();
            const isKnownDestination = (output: RepairOutput) => [...recoveryOutputs, ...second].some(recorded => recorded.id === output.id && recorded.address === output.address && JSON.stringify(recorded.handles) === JSON.stringify(output.handles));
            for (const output of outputs) {
                if (!output.id || !output.address || outputIds.has(output.id)) throw new Error(`Invalid or duplicate ${kind.toLowerCase()} output`);
                outputIds.add(output.id);
                for (const [policy, assets] of output.handles) for (const hex of assets) {
                    const asset = getHandleNameFromAssetName(hex);
                    if (asset.isCip67 && ![AssetNameLabel.LBL_222, AssetNameLabel.LBL_000].includes(asset.assetLabel as AssetNameLabel)) continue;
                    const key = `${policy}:${hex}`;
                    const target = targetByAsset.get(key);
                    if (!target || target.name !== asset.name) throw new Error(`${kind} output contains an unplanned handle`);
                    const previous = found.get(key) ?? [];
                    if (previous.length && (kind !== 'Source' || (!isKnownDestination(output) && previous.some(prior => !isKnownDestination(prior))))) throw new Error(`Owner token has multiple ${kind.toLowerCase()} outputs`);
                    found.set(key, [...previous, output]);
                }
            }
            if (found.size !== targets.length) throw new Error(`Owner token is missing from ${kind.toLowerCase()} outputs`);
        };
        verifyOutputs(sources as RepairOutput[], 'Source');
        verifyOutputs(second, 'Canonical');
        assertLease();
        return { stored: stored as StoredHandle[], sources: sources as RepairOutput[], outputs: second };
    } finally {
        lease.release(owner);
    }
}
