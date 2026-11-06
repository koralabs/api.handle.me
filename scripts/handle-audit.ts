export interface ApiHandle { name: string; hex: string; policy: string; utxo: string; updated_slot_number: number }
interface Asset { policy_id: string; asset_name: string; quantity: string }
export interface AssetUtxo { tx_hash: string; tx_index: number; asset_list: Asset[] }
export interface Finding { name: string; policy: string; hex: string; stored: string; canonical: string[]; status: 'mismatch' | 'unresolved' }

export function compareBatch(handles: ApiHandle[], rows: AssetUtxo[]): Finding[] {
    return handles.flatMap((h) => {
        const canonical = [...new Set(rows.filter((row) => row.asset_list.some((asset) =>
            asset.policy_id === h.policy && asset.asset_name === h.hex && BigInt(asset.quantity) > 0n
        )).map((row) => `${row.tx_hash}#${row.tx_index}`))];
        if (canonical.length === 1 && canonical[0] === h.utxo) return [];
        return [{ name: h.name, policy: h.policy, hex: h.hex, stored: h.utxo, canonical,
            status: canonical.length === 1 ? 'mismatch' as const : 'unresolved' as const }];
    });
}
