/**
 * backfill-script-types.ts
 *
 * One-shot maintenance: detects and (optionally) repairs handles whose stored
 * `script.type` does not match chain canonical truth. Driven by the
 * valkey-utility lambda — `scripts_with_cbor` for enumeration and
 * `update_script_types` for repair — and koios `tx_info` for detection.
 *
 * Why: prior to api commit a918b06 the koios scanner hardcoded
 * 'PlutusScriptV2' (later observed as bare 'plutus' from at least one
 * ingestion path) for every reference_script regardless of the actual Plutus
 * version. PLUTUS_LANGUAGE_PREFIX falls back to '02' for unknown values, so V3
 * scripts hashed as V2 → /scripts advertised the wrong address. Fix needs to
 * touch every entry where stored prefix ≠ canonical prefix.
 *
 * Usage:
 *   NETWORK=preview AWS_REGION=us-east-1 \
 *     tsx scripts/backfill-script-types.ts --network preview [--input <file>] [--repair] [--dry-run]
 *
 * Without --input, the script invokes the lambda's `scripts_with_cbor` action
 * itself. Without --repair, it only reports mismatches.
 */
import 'dotenv/config';
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fetchKoios } from '../utils/helpers';

// Mirrors services/scripts.service.ts so the comparison stays consistent with
// /scripts hash derivation. Anything outside this table falls back to '02'.
const PLUTUS_LANGUAGE_PREFIX: Record<string, string> = {
    plutusV1: '01',
    plutusV2: '02',
    plutusV3: '03',
    PlutusScriptV1: '01',
    PlutusScriptV2: '02',
    PlutusScriptV3: '03'
};
const FALLBACK_PREFIX = '02';

const KOIOS_TX_INFO_BATCH = 25;
const KOIOS_RPS = 6;
const KOIOS_INTERVAL_MS = Math.ceil(1000 / KOIOS_RPS);
const UPDATE_CHUNK_SIZE = 100;

interface ScriptHandle {
    name: string;
    hex: string;
    policy: string;
    utxo: string;
    type: string;
    cbor: string;
}

interface Mismatch {
    name: string;
    storedType: string;
    canonicalType: string;
    txId: string;
    txIndex: number;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const getArg = (flag: string): string | undefined => {
    const idx = process.argv.indexOf(flag);
    return idx > 0 && process.argv[idx + 1] ? process.argv[idx + 1] : undefined;
};

const hasFlag = (flag: string) => process.argv.includes(flag);

const prefixFor = (type: string | undefined) => PLUTUS_LANGUAGE_PREFIX[type ?? ''] ?? FALLBACK_PREFIX;

const invokeLambda = (payload: any): any => {
    const region = process.env.AWS_REGION ?? 'us-east-1';
    const tmpDir = mkdtempSync(path.join(tmpdir(), 'valkey-util-'));
    const outFile = path.join(tmpDir, 'response.json');
    try {
        execFileSync('aws', [
            'lambda', 'invoke',
            '--function-name', 'valkey-utility',
            '--region', region,
            '--cli-binary-format', 'raw-in-base64-out',
            '--payload', JSON.stringify(payload),
            outFile
        ], { stdio: ['ignore', 'ignore', 'pipe'] });
        return JSON.parse(readFileSync(outFile, 'utf8'));
    } finally {
        try { execFileSync('rm', ['-rf', tmpDir]); } catch { /* best effort */ }
    }
};

const fetchScriptHandles = (network: string): ScriptHandle[] => {
    const inputFile = getArg('--input');
    if (inputFile) {
        const parsed = JSON.parse(readFileSync(inputFile, 'utf8'));
        return parsed?.handles ?? [];
    }
    console.error(`Invoking valkey-utility scripts_with_cbor for network=${network}…`);
    const result = invokeLambda({ action: 'scripts_with_cbor', network });
    if (result?.error) {
        console.error(`Lambda returned error: ${result.error}`);
        process.exit(1);
    }
    return result?.handles ?? [];
};

const detectMismatches = async (handles: ScriptHandle[]): Promise<Mismatch[]> => {
    // Group by tx_hash so a single batched tx_info call covers many handles.
    const byTxHash = new Map<string, ScriptHandle[]>();
    for (const handle of handles) {
        const [txId] = `${handle.utxo}`.split('#');
        if (!txId) continue;
        const list = byTxHash.get(txId) ?? [];
        list.push(handle);
        byTxHash.set(txId, list);
    }
    const txHashes = [...byTxHash.keys()];
    console.error(`Resolving canonical types for ${handles.length} handles across ${txHashes.length} unique tx_hashes…`);

    const canonicalTypeByUtxo = new Map<string, string | null>();
    for (let i = 0; i < txHashes.length; i += KOIOS_TX_INFO_BATCH) {
        const batch = txHashes.slice(i, i + KOIOS_TX_INFO_BATCH);
        const body = JSON.stringify({
            _tx_hashes: batch,
            _inputs: false,
            _withdrawals: false,
            _certs: false,
            _governance: false,
            _scripts: true,
            _bytecode: true,
            _metadata: false,
            _assets: false
        });
        let txInfos: any[] = [];
        try {
            txInfos = (await fetchKoios('tx_info', 'POST', body)) ?? [];
        } catch (e: any) {
            console.error(`koios tx_info batch ${i / KOIOS_TX_INFO_BATCH} failed: ${e?.message ?? e}`);
        }
        for (const tx of txInfos) {
            for (const output of tx?.outputs ?? []) {
                const referenceScript = output?.reference_script;
                if (!referenceScript) continue;
                canonicalTypeByUtxo.set(`${tx.tx_hash}#${output.tx_index}`, referenceScript.type ?? null);
            }
        }
        process.stderr.write(`\r  resolved ${Math.min(i + KOIOS_TX_INFO_BATCH, txHashes.length)}/${txHashes.length} tx_hashes`);
        await delay(KOIOS_INTERVAL_MS);
    }
    process.stderr.write('\n');

    const mismatches: Mismatch[] = [];
    let unresolved = 0;
    for (const handle of handles) {
        const [txId, indexStr] = `${handle.utxo}`.split('#');
        const txIndex = Number(indexStr);
        const canonicalType = canonicalTypeByUtxo.get(handle.utxo) ?? null;
        if (canonicalType === null) {
            unresolved += 1;
            continue;
        }
        if (prefixFor(handle.type) !== prefixFor(canonicalType)) {
            mismatches.push({ name: handle.name, storedType: handle.type, canonicalType, txId, txIndex });
        }
    }
    if (unresolved) {
        console.error(`WARN: ${unresolved} handles had no resolvable canonical reference_script (UTxO maybe spent and not in tx_info — won't be repaired)`);
    }
    return mismatches;
};

const reportMismatches = (mismatches: Mismatch[], total: number) => {
    console.error(`\n=== Mismatch summary ===`);
    console.error(`Total handles with script.cbor: ${total}`);
    console.error(`Mismatches (stored prefix ≠ canonical prefix): ${mismatches.length}`);
    if (!mismatches.length) return;
    const byTransition = new Map<string, number>();
    for (const m of mismatches) {
        const key = `${m.storedType || '(empty)'} → ${m.canonicalType}`;
        byTransition.set(key, (byTransition.get(key) ?? 0) + 1);
    }
    console.error(`\nTransitions:`);
    for (const [transition, count] of [...byTransition].sort((a, b) => b[1] - a[1])) {
        console.error(`  ${transition}: ${count}`);
    }
    console.error(`\nFirst 20:`);
    for (const m of mismatches.slice(0, 20)) {
        console.error(`  ${m.name.padEnd(40)} ${m.storedType.padEnd(16)} → ${m.canonicalType}`);
    }
    if (mismatches.length > 20) console.error(`  ...and ${mismatches.length - 20} more`);
};

const repairMismatches = (network: string, mismatches: Mismatch[], dryRun: boolean) => {
    console.error(`\n=== Repairing ${mismatches.length} mismatches in chunks of ${UPDATE_CHUNK_SIZE}${dryRun ? ' (dry-run)' : ''} ===`);
    const totals = { requested: 0, updated: 0, unchanged: 0, missing: 0, invalid: 0 };
    for (let i = 0; i < mismatches.length; i += UPDATE_CHUNK_SIZE) {
        const chunk = mismatches.slice(i, i + UPDATE_CHUNK_SIZE);
        const result = invokeLambda({
            action: 'update_script_types',
            network,
            dryRun,
            updates: chunk.map((m) => ({ name: m.name, type: m.canonicalType }))
        });
        if (result?.error) {
            console.error(`  chunk ${i}: lambda error: ${result.error}`);
            continue;
        }
        totals.requested += result.requested ?? 0;
        totals.updated += result.updated ?? 0;
        totals.unchanged += result.unchanged ?? 0;
        totals.missing += result.missing ?? 0;
        totals.invalid += result.invalid ?? 0;
        process.stderr.write(`\r  chunk ${Math.min(i + UPDATE_CHUNK_SIZE, mismatches.length)}/${mismatches.length} · updated=${totals.updated} unchanged=${totals.unchanged} missing=${totals.missing} invalid=${totals.invalid}`);
    }
    process.stderr.write('\n');
    console.error(`\nRepair complete: ${JSON.stringify(totals)}`);
};

const run = async () => {
    const network = (getArg('--network') ?? process.env.NETWORK ?? 'preview').toLowerCase();
    const repair = hasFlag('--repair');
    const dryRun = hasFlag('--dry-run');
    const outputArg = getArg('--output');

    const handles = fetchScriptHandles(network);
    console.error(`Loaded ${handles.length} handles with script.cbor for network=${network}`);
    if (!handles.length) return;

    const mismatches = await detectMismatches(handles);
    reportMismatches(mismatches, handles.length);

    if (outputArg) {
        writeFileSync(outputArg, JSON.stringify(mismatches, null, 2));
        console.error(`\nWrote mismatch list to ${outputArg}`);
    }

    if (repair && mismatches.length) {
        repairMismatches(network, mismatches, dryRun);
    } else if (repair) {
        console.error('\nNo mismatches; nothing to repair.');
    }
};

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
