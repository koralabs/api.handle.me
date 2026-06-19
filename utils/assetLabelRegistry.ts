// WS1 — asset-label registry encoding (api side).
//
// The MPT (Merkle-Patricia-Forestry) value at each handle key is the handle's canonical
// asset-label registry: the sorted set of the CIP-67 label prefixes it currently holds, out of
// the *tracked* labels {001, 002, 003, 004}. The api is the off-chain source of truth for this
// root; the on-chain `demimntmpt` minting-data validator maintains the byte-identical value via
// its `MintLabelAssets` redeemer. If these two encodings ever diverge, the api root stops
// matching the chain and the minting engine deadlocks — so this MUST stay byte-for-byte identical
// to:
//   - decentralized-minting/src/store/labelSet.ts        (the sorted 4-byte-prefix set)
//   - decentralized-minting/src/store/registryValue.ts   (free_names ⊕ labels composition)
//   - decentralized-minting/smart-contract/lib/decentralized_minting/{label_set,registry_value}.ak
// Any change to the encoding here must be mirrored there (and vice-versa). `assetLabelRegistry.test.ts`
// pins shared vectors so drift fails CI rather than corrupting the root silently.
//
// Trie note: the JS MPF treats string values as UTF-8, so the value bytes must be inserted via
// `valueBuffer(hex)` (Buffer.from(hex,'hex')), never the hex string itself.

// ───────────────────────── tracked labels ─────────────────────────
//
// The four per-handle assets that belong in the registry (CIP-67 4-byte prefixes). 001 = sub-handle
// settings; 002/003/004 are reserved (not yet minted) but the api tracks them so they register the
// moment they appear. NOT in the set: 100 (reference), 222 (owner NFT), 000 (virtual sub) — those
// govern the handle's *key* presence, not its registry value. The handle's key stays in the MPT
// until its 222 or 000 is burnt; these labels only add/remove from the value.

export const LBL_001 = '00001070';
export const LBL_002 = '000020e0';
export const LBL_003 = '00003090';
export const LBL_004 = '000041c0';

/** The CIP-67 prefixes whose mint/burn mutate a handle's registry value. */
export const REGISTRY_LABEL_PREFIXES: ReadonlySet<string> = new Set([LBL_001, LBL_002, LBL_003, LBL_004]);

/** Is this 4-byte CIP-67 prefix one the registry tracks? (`getHandleNameFromAssetName().assetLabel`) */
export const isRegistryLabel = (assetLabel: string | null | undefined): boolean =>
    !!assetLabel && REGISTRY_LABEL_PREFIXES.has(assetLabel.toLowerCase());

// ───────────────────────── label set (port of labelSet.ts) ─────────────────────────

const LABEL_WIDTH_HEX = 8; // 4 bytes

const chunks = (set: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < set.length; i += LABEL_WIDTH_HEX) {
        out.push(set.slice(i, i + LABEL_WIDTH_HEX));
    }
    return out;
};

const normalizeLabel = (label: string): string => {
    const l = label.toLowerCase();
    if (l.length !== LABEL_WIDTH_HEX) {
        throw new Error(`label must be ${LABEL_WIDTH_HEX} hex chars (4 bytes): ${label}`);
    }
    return l;
};

/** Does the canonical label set contain `label`? */
export const containsLabel = (set: string, label: string): boolean =>
    chunks(set.toLowerCase()).includes(normalizeLabel(label));

/** Insert `label`, keeping the set sorted ascending. Throws if already present. */
export const insertLabel = (set: string, label: string): string => {
    const l = normalizeLabel(label);
    const cs = chunks(set.toLowerCase());
    if (cs.includes(l)) throw new Error('LABEL_ALREADY_PRESENT');
    cs.push(l);
    // fixed-width hex sorts lexicographically == on-chain byte order
    cs.sort();
    return cs.join('');
};

/** Remove `label`. Throws if absent. */
export const removeLabel = (set: string, label: string): string => {
    const l = normalizeLabel(label);
    const cs = chunks(set.toLowerCase());
    const idx = cs.indexOf(l);
    if (idx < 0) throw new Error('LABEL_ABSENT');
    cs.splice(idx, 1);
    return cs.join('');
};

/**
 * Idempotent presence-set mutators for the indexer. The chain enforces "minted exactly once"
 * (`insertLabel`/`removeLabel` throw on duplicate/absent); the api scan, by contrast, can re-process
 * the same UTxO (re-scan, rollback-replay) and the user can mint the 001 more than once (the spec:
 * "ignore anything more than one"). So the indexer uses these no-throw variants: ensure-present and
 * ensure-absent collapse multiplicity to a boolean, matching the on-chain set either way.
 */
export const ensureLabel = (set: string, label: string): string =>
    containsLabel(set, label) ? set.toLowerCase() : insertLabel(set, label);

export const ensureNoLabel = (set: string, label: string): string =>
    containsLabel(set, label) ? removeLabel(set, label) : set.toLowerCase();

/** The raw value bytes to store in the Trie (UTF-8-safe). */
export const valueBuffer = (set: string): Buffer => Buffer.from(set, 'hex');

// ───────────────────────── registry value (port of registryValue.ts) ─────────────────────────
//
// Composes the label set with a root's FREE private-virtual sub-name set (DSH-402). Today the api
// passes no free names (the orders/free-virtual path is not yet wired into the scan), so `encode`
// returns the bare label set — byte-identical to the on-chain value for any handle without free
// virtuals. When free-virtual tracking lands, supply the names here and the encoding stays correct.

// CBOR header for a Plutus `Data` byte string (major type 2). Names are CIP-67 asset names
// (<= 32 bytes), so a single definite-length chunk always suffices.
const cborByteString = (hex: string): string => {
    const byteLen = hex.length / 2;
    if (!Number.isInteger(byteLen)) {
        throw new Error(`free name is not valid hex (odd length): ${hex}`);
    }
    if (byteLen < 24) return (0x40 | byteLen).toString(16).padStart(2, '0') + hex;
    if (byteLen <= 64) return '58' + byteLen.toString(16).padStart(2, '0') + hex;
    throw new Error(`free name exceeds 64 bytes (Plutus would chunk): ${hex}`);
};

const serialiseData = (freeNames: string[]): string =>
    '9f' + freeNames.map((n) => cborByteString(n.toLowerCase())).join('') + 'ff';

/**
 * Byte-identical to on-chain `registry_value.encode(free_names, labels)`.
 *   free_names == []  -> labels (an empty handle stays "", any pure-label handle is WS1-identical)
 *   free_names != []  -> "ff" ++ serialise_data(free_names) ++ labels
 */
export const encodeRegistryValue = (freeNames: string[], labels: string): string => {
    const l = labels.toLowerCase();
    return freeNames.length === 0 ? l : 'ff' + serialiseData(freeNames) + l;
};

/** The Trie value bytes for a handle whose registry state is (freeNames, labels). */
export const registryValueBuffer = (freeNames: string[], labels: string): Buffer =>
    valueBuffer(encodeRegistryValue(freeNames, labels));
