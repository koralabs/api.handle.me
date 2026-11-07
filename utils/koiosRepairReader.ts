import { HANDLE_POLICIES, NETWORK, type Network, type UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import type { KoiosDatumInfo, KoiosTxInfo } from '../interfaces/provider.interface';
import { buildUTxOsFromKoiosTxs, defaultKoiosSettings, fetchKoios } from './helpers';
import type { RepairTarget } from './repairPreflight';

export interface RepairCursor { hash: string; slot: number }
type KoiosQuery = typeof fetchKoios;
interface Asset { policy_id: string; asset_name: string; quantity: string }
interface AssetRow { tx_hash: string; tx_index: number; address: string; value: string; asset_list: Asset[] }

/** Reconstruct owner outputs at the cursor while a stable Koios tip descends from it. */
export function createKoiosRepairReader(getCursor: () => RepairCursor, query: KoiosQuery = fetchKoios) {
    let anchor: RepairCursor | undefined;
    const cursor = () => {
        const value = getCursor();
        if (!value.hash || !Number.isSafeInteger(value.slot) || value.slot <= 0) throw new Error('Invalid scanner cursor');
        if (anchor && (anchor.hash !== value.hash || anchor.slot !== value.slot)) throw new Error('Scanner cursor changed during repair');
        anchor ??= { ...value };
        return value;
    };
    const tip = async (): Promise<RepairCursor> => {
        const rows = await query('tip');
        if (!Array.isArray(rows) || rows.length !== 1 || typeof rows[0]?.hash !== 'string' || !rows[0].hash || !Number.isSafeInteger(rows[0]?.abs_slot) || rows[0].abs_slot <= 0) throw new Error('Invalid Koios tip');
        return { hash: rows[0].hash, slot: rows[0].abs_slot };
    };
    const anchoredTip = async (): Promise<RepairCursor> => {
        const expected = cursor();
        const observed = await tip();
        if (observed.hash === expected.hash && observed.slot === expected.slot) return observed;
        let hash = observed.hash;
        let upperSlot = observed.slot + 1;
        for (let depth = 0; depth <= 64; depth++) {
            const rows = await query('block_info', 'POST', JSON.stringify({ _block_hashes: [hash] }));
            if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.hash !== hash || !Number.isSafeInteger(rows[0]?.abs_slot) || rows[0].abs_slot >= upperSlot || rows[0].abs_slot < expected.slot) break;
            const block = rows[0];
            if (hash === expected.hash && block.abs_slot === expected.slot) { cursor(); return observed; }
            if (block.abs_slot <= expected.slot || typeof block.parent_hash !== 'string' || !block.parent_hash) break;
            hash = block.parent_hash;
            upperSlot = block.abs_slot;
        }
        throw new Error('Koios tip does not descend from scanner cursor; chain moved or rolled back');
    };
    return async (targets: RepairTarget[]): Promise<UTxOWithTxInfo[]> => {
        const observedTip = await anchoredTip();
        const rows: AssetRow[] = await query('asset_utxos', 'POST', JSON.stringify({ _asset_list: targets.map(t => [t.policy, t.hex]), _extended: true }));
        if (!Array.isArray(rows)) throw new Error('Invalid Koios asset_utxos response');
        const ids = new Set<string>();
        const found = new Set<string>();
        for (const row of rows) {
            if (!row || typeof row.tx_hash !== 'string' || !row.tx_hash || !Number.isSafeInteger(row.tx_index) || row.tx_index < 0 || typeof row.address !== 'string' || !row.address || typeof row.value !== 'string' || !/^\d+$/.test(row.value) || !Number.isSafeInteger(Number(row.value)) || !Array.isArray(row.asset_list)) throw new Error('Invalid Koios asset output');
            const id = `${row.tx_hash}#${row.tx_index}`;
            if (ids.has(id)) throw new Error('Duplicate Koios asset output');
            ids.add(id);
            let matched = false;
            for (const target of targets) {
                const matches = row.asset_list.filter(a => a.policy_id === target.policy && a.asset_name === target.hex);
                if (matches.length) {
                    const key = `${target.policy}:${target.hex}`;
                    if (matches.length !== 1 || matches[0].quantity !== '1' || found.has(key)) throw new Error('Owner token is duplicated or has invalid quantity');
                    found.add(key);
                    matched = true;
                }
            }
            if (!matched) throw new Error('Koios returned an unrequested output');
        }
        if (found.size !== targets.length) throw new Error('Owner token is missing from Koios outputs');
        const hashes = [...new Set(rows.map(row => row.tx_hash))];
        const txs: KoiosTxInfo[] = await query('tx_info', 'POST', JSON.stringify({ _tx_hashes: hashes, ...defaultKoiosSettings }));
        if (!Array.isArray(txs) || txs.length !== hashes.length || new Set(txs.map(tx => tx.tx_hash)).size !== hashes.length || txs.some(tx => !hashes.includes(tx.tx_hash))) throw new Error('Koios transaction coverage is incomplete');
        const validateTx = (tx: KoiosTxInfo) => {
            if (!tx.block_hash || !Number.isSafeInteger(tx.absolute_slot) || tx.absolute_slot <= 0 || tx.absolute_slot > observedTip.slot || !Array.isArray(tx.outputs) || !Array.isArray(tx.inputs) || !Array.isArray(tx.assets_minted)) throw new Error('Invalid Koios transaction');
        };
        for (const tx of txs) validateTx(tx);
        const outputs = rows.map(row => {
            const tx = txs.find(item => item.tx_hash === row.tx_hash)!;
            const matches = tx.outputs.filter(output => output.tx_hash === row.tx_hash && output.tx_index === row.tx_index);
            if (matches.length !== 1 || !Array.isArray(matches[0].asset_list)) throw new Error('Koios transaction output is missing or duplicated');
            const output = matches[0];
            if (output.payment_addr?.bech32 !== row.address || output.value !== row.value) throw new Error('Koios UTxO and transaction address or value disagree');
            const handleAssets = (assets: Asset[]) => assets.filter(asset => HANDLE_POLICIES.contains(NETWORK as Network, asset.policy_id))
                .map(asset => `${asset.policy_id}:${asset.asset_name}:${asset.quantity}`).sort();
            if (JSON.stringify(handleAssets(row.asset_list)) !== JSON.stringify(handleAssets(output.asset_list))) throw new Error('Koios UTxO and transaction assets disagree');
            for (const target of targets) {
                const fromUtxo = row.asset_list.filter(a => a.policy_id === target.policy && a.asset_name === target.hex);
                const fromTx = output.asset_list.filter(a => a.policy_id === target.policy && a.asset_name === target.hex);
                if (fromUtxo.length !== fromTx.length || fromTx.some(a => a.quantity !== '1')) throw new Error('Koios UTxO and transaction owner tokens disagree');
            }
            return output;
        });
        const txByHash = new Map(txs.map(tx => [tx.tx_hash, tx]));
        const historicalIds = new Set<string>();
        for (const target of targets) {
            const row = rows.find(item => item.asset_list.some(a => a.policy_id === target.policy && a.asset_name === target.hex))!;
            let currentTx = txByHash.get(row.tx_hash)!;
            let currentIndex = row.tx_index;
            const visited = new Set<string>();
            while (currentTx.absolute_slot > anchor!.slot) {
                const currentId = `${currentTx.tx_hash}#${currentIndex}`;
                if (visited.has(currentId)) throw new Error('Cycle in Koios owner-token ancestry');
                visited.add(currentId);
                if (currentTx.assets_minted.some(asset => asset.policy_id === target.policy && asset.asset_name === target.hex)) throw new Error('Owner token was minted or burned after the scanner cursor');
                const inputs = currentTx.inputs;
                if (!inputs.length || inputs.some(input => !input.tx_hash || !Number.isSafeInteger(input.tx_index) || input.tx_index < 0) || new Set(inputs.map(input => `${input.tx_hash}#${input.tx_index}`)).size !== inputs.length) throw new Error('Invalid Koios transaction inputs');
                const missing = [...new Set(inputs.map(input => input.tx_hash).filter(hash => !txByHash.has(hash)))];
                for (let i = 0; i < missing.length; i += 50) {
                    const batch = missing.slice(i, i + 50);
                    const parents: KoiosTxInfo[] = await query('tx_info', 'POST', JSON.stringify({ _tx_hashes: batch, ...defaultKoiosSettings }));
                    if (!Array.isArray(parents) || parents.length !== batch.length || new Set(parents.map(tx => tx.tx_hash)).size !== batch.length || parents.some(tx => !batch.includes(tx.tx_hash))) throw new Error('Koios parent transaction coverage is incomplete');
                    for (const parent of parents) { validateTx(parent); txByHash.set(parent.tx_hash, parent); }
                }
                const ownerInputs = inputs.filter(input => {
                    const parent = txByHash.get(input.tx_hash)!;
                    if (parent.absolute_slot > currentTx.absolute_slot) throw new Error('Invalid Koios owner-token ancestry order');
                    const candidates = parent.outputs.filter(output => output.tx_hash === input.tx_hash && output.tx_index === input.tx_index);
                    if (candidates.length !== 1 || !Array.isArray(candidates[0].asset_list)) throw new Error('Koios input output is missing or duplicated');
                    const assets = candidates[0].asset_list.filter(asset => asset.policy_id === target.policy && asset.asset_name === target.hex);
                    if (assets.length > 1 || assets.some(asset => asset.quantity !== '1')) throw new Error('Invalid Koios owner-token input quantity');
                    return assets.length === 1;
                });
                if (ownerInputs.length !== 1) throw new Error('Owner token has no unique input at the scanner cursor');
                currentTx = txByHash.get(ownerInputs[0].tx_hash)!;
                currentIndex = ownerInputs[0].tx_index;
            }
            historicalIds.add(`${currentTx.tx_hash}#${currentIndex}`);
        }
        const historicalOutputs = [...historicalIds].map(id => {
            const [hash, index] = id.split('#');
            return txByHash.get(hash)!.outputs.find(output => output.tx_index === Number(index) && output.tx_hash === hash)!;
        });
        const datumHashes = [...new Set(historicalOutputs.filter(output => output.datum_hash && !output.inline_datum?.bytes).map(output => output.datum_hash!))];
        const datums: KoiosDatumInfo[] = datumHashes.length ? await query('datum_info', 'POST', JSON.stringify({ _datum_hashes: datumHashes })) : [];
        if (!Array.isArray(datums) || datums.length !== datumHashes.length || new Set(datums.map(d => d.datum_hash)).size !== datumHashes.length || datums.some(d => !datumHashes.includes(d.datum_hash) || typeof d.bytes !== 'string' || !d.bytes)) throw new Error('Koios datum coverage is incomplete');
        const built = buildUTxOsFromKoiosTxs([...txByHash.values()], new Map(datums.map(d => [d.datum_hash, d.bytes]))).filter(output => historicalIds.has(output.id));
        if (built.length !== historicalIds.size || built.some(output => !output.handles.every(([policy]) => HANDLE_POLICIES.contains(NETWORK as Network, policy)))) throw new Error('Unable to reconstruct every Koios owner output');
        const endingTip = await tip();
        cursor();
        if (endingTip.hash !== observedTip.hash || endingTip.slot !== observedTip.slot) throw new Error('Koios tip changed during repair read');
        return built.sort((a, b) => a.id.localeCompare(b.id));
    };
}
