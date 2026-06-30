import {
    containsLabel,
    encodeRegistryValue,
    ensureLabel,
    ensureNoLabel,
    insertLabel,
    isRegistryLabel,
    LBL_001,
    LBL_002,
    LBL_003,
    LBL_004,
    REGISTRY_LABEL_PREFIXES,
    registryValueBuffer,
    removeLabel,
    valueBuffer
} from './assetLabelRegistry';

// These vectors are CONFIRMED byte-identical to the on-chain `registry_value.encode` /
// `label_set` and are copied verbatim from decentralized-minting/tests/registryValue.test.ts
// (which itself was pinned against aiken v1.0.29 `builtin.serialise_data`). If the api's port
// diverges from the engine/contract by a single byte, these assertions fail here — which is the
// SAME failure the chain would otherwise surface as a rejected `mpt.update` / a deadlocked engine.

describe('assetLabelRegistry — tracked labels', () => {
    it('pins the four CIP-67 prefixes (001/002/003/004)', () => {
        expect(LBL_001).toBe('00001070');
        expect(LBL_002).toBe('000020e0');
        expect(LBL_003).toBe('00003090');
        expect(LBL_004).toBe('000041c0');
        expect([...REGISTRY_LABEL_PREFIXES].sort()).toEqual([LBL_001, LBL_002, LBL_003, LBL_004].sort());
    });

    it('isRegistryLabel: tracks 001-004, ignores 100/222/000/null', () => {
        expect(isRegistryLabel(LBL_001)).toBe(true);
        expect(isRegistryLabel(LBL_004)).toBe(true);
        expect(isRegistryLabel('000643b0')).toBe(false); // 100
        expect(isRegistryLabel('000de140')).toBe(false); // 222
        expect(isRegistryLabel('00000000')).toBe(false); // 000
        expect(isRegistryLabel(null)).toBe(false);
        expect(isRegistryLabel(undefined)).toBe(false);
    });
});

describe('assetLabelRegistry — label set (sorted 4-byte prefixes)', () => {
    it('inserts sorted ascending regardless of insert order', () => {
        expect(insertLabel('', LBL_002)).toBe(LBL_002);
        expect(insertLabel(LBL_002, LBL_001)).toBe(LBL_001 + LBL_002);
        // out-of-order inserts still produce canonical order
        let s = '';
        for (const l of [LBL_004, LBL_001, LBL_003, LBL_002]) s = insertLabel(s, l);
        expect(s).toBe(LBL_001 + LBL_002 + LBL_003 + LBL_004);
    });

    it('insert throws on duplicate; remove throws on absent', () => {
        expect(() => insertLabel(LBL_001, LBL_001)).toThrow();
        expect(() => removeLabel('', LBL_001)).toThrow();
    });

    it('removeLabel preserves order of the rest', () => {
        expect(removeLabel(LBL_001 + LBL_002 + LBL_003, LBL_002)).toBe(LBL_001 + LBL_003);
    });

    it('containsLabel detects membership', () => {
        expect(containsLabel(LBL_001 + LBL_003, LBL_003)).toBe(true);
        expect(containsLabel(LBL_001 + LBL_003, LBL_002)).toBe(false);
    });

    it('ensureLabel / ensureNoLabel are idempotent (collapse multiplicity to a boolean)', () => {
        // "ignore anything more than one" — adding the 001 three times == once
        let s = ensureLabel('', LBL_001);
        s = ensureLabel(s, LBL_001);
        s = ensureLabel(s, LBL_001);
        expect(s).toBe(LBL_001);
        // ensure-absent is a no-op when already absent, and removes when present
        expect(ensureNoLabel('', LBL_001)).toBe('');
        expect(ensureNoLabel(LBL_001 + LBL_002, LBL_001)).toBe(LBL_002);
    });

    it('valueBuffer encodes hex as raw bytes (UTF-8-safe trie value)', () => {
        expect(valueBuffer(LBL_001)).toEqual(Buffer.from('00001070', 'hex'));
        expect(valueBuffer('')).toEqual(Buffer.alloc(0));
    });
});

describe('encodeRegistryValue / registryValueBuffer — the bare label set', () => {
    it('empty set -> "" (an unlabeled handle keeps the empty value)', () => {
        expect(encodeRegistryValue('')).toBe('');
        expect(valueBuffer(encodeRegistryValue(''))).toEqual(Buffer.alloc(0));
    });

    it('labels -> the lowercased label set (byte-identical to the on-chain value)', () => {
        expect(encodeRegistryValue('00001070000020e0')).toBe('00001070000020e0');
        expect(encodeRegistryValue(LBL_001.toUpperCase())).toBe(LBL_001);
    });

    it('registryValueBuffer encodes the label set as raw value bytes', () => {
        expect(registryValueBuffer('')).toEqual(Buffer.alloc(0));
        expect(registryValueBuffer(LBL_001)).toEqual(valueBuffer(LBL_001));
        expect(registryValueBuffer(LBL_001 + LBL_002)).toEqual(valueBuffer(LBL_001 + LBL_002));
    });
});
