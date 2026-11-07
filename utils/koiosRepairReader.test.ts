import { createKoiosRepairReader } from './koiosRepairReader';

const policy = 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a';
const target = { name: 'repair', policy, hex: Buffer.from('repair').toString('hex') };
const asset = { policy_id: policy, asset_name: target.hex, quantity: '1', decimals: 0, fingerprint: '' };
const address = 'addr_test1qzdzhdzf9ud8k2suzryvcdl78l3tfesnwp962vcuh99k8z834r3hjynmsy2cxpc04a6dkqxcsr29qfl7v9cmrd5mm89qfmc97q';
const output = { tx_hash: 'tx', tx_index: 0, datum_hash: 'datumhash', stake_addr: null, value: '2000000', payment_addr: { bech32: address, cred: '' }, asset_list: [asset], inline_datum: null, reference_script: null };
const tx = { tx_hash: 'tx', block_hash: 'block', block_height: 12, absolute_slot: 90, reference_inputs: [], inputs: [], outputs: [output], assets_minted: [], metadata: {} };
const row = { tx_hash: 'tx', tx_index: 0, address, value: '2000000', asset_list: [asset] };
const tip = { hash: 'anchor', abs_slot: 100 };
const cursor = () => ({ hash: 'anchor', slot: 100 });
const originalFetch = global.fetch;

afterEach(() => { global.fetch = originalFetch; });

// The adapter must reconstruct actual owner outputs and their datum from rate-limited Koios transport.
// Dropping tx_info conversion or datum lookup makes the address, slot or datum assertions fail.
it('reconstructs an output between matching cursor-tip checks', async () => {
    const paths: string[] = [];
    global.fetch = jest.fn(async (input) => {
        const path = new URL(String(input)).pathname.split('/').pop()!;
        paths.push(path);
        const body = path === 'tip' ? [tip] : path === 'asset_utxos' ? [row] : path === 'tx_info' ? [tx] : [{ datum_hash: 'datumhash', bytes: 'd87980' }];
        return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const read = createKoiosRepairReader(cursor);
    expect(await read([target])).toEqual([expect.objectContaining({ id: 'tx#0', tx_id: 'tx', slot: 90, address, datum: 'd87980', handles: [[policy, [target.hex]]] })]);
    expect(paths).toEqual(['tip', 'asset_utxos', 'tx_info', 'datum_info', 'tip']);
});

// No incomplete, inconsistent or differently anchored observation may become a repair output.
// Removing the corresponding validation makes that invalid fixture resolve instead of reject.
it.each(['missing', 'quantity', 'sibling-disagreement', 'address-disagreement', 'missing-tx', 'missing-datum', 'rollback', 'move-during-read', 'rate-limit'] as const)('rejects %s without returning a repair output', async mode => {
    let tipReads = 0;
    global.fetch = jest.fn(async (input) => {
        const path = new URL(String(input)).pathname.split('/').pop()!;
        if (path === 'tip') {
            tipReads++;
            if (mode === 'rate-limit') return new Response('{}', { status: 429, headers: { 'Retry-After': '0' } });
            const changed = mode === 'rollback' || (mode === 'move-during-read' && tipReads === 2);
            return new Response(JSON.stringify([changed ? { hash: 'fork', abs_slot: 100 } : tip]));
        }
        if (path === 'block_info') return new Response(JSON.stringify([{ hash: 'fork', abs_slot: 100, parent_hash: 'older' }]));
        if (path === 'asset_utxos') {
            const values = mode === 'missing' ? [] : mode === 'quantity' ? [{ ...row, asset_list: [{ ...asset, quantity: '2' }] }] : mode === 'sibling-disagreement' ? [{ ...row, asset_list: [asset, { ...asset, asset_name: Buffer.from('sibling').toString('hex') }] }] : mode === 'address-disagreement' ? [{ ...row, address: 'different' }] : [row];
            return new Response(JSON.stringify(values));
        }
        if (path === 'tx_info') return new Response(JSON.stringify(mode === 'missing-tx' ? [] : [tx]));
        if (path === 'datum_info') return new Response(JSON.stringify(mode === 'missing-datum' ? [] : [{ datum_hash: 'datumhash', bytes: 'd87980' }]));
        throw new Error(`Unexpected endpoint ${path}`);
    }) as typeof fetch;
    const expected = mode === 'missing' ? 'missing' : mode === 'quantity' ? 'quantity' : mode === 'sibling-disagreement' ? 'assets disagree' : mode === 'address-disagreement' ? 'address or value disagree' : mode === 'missing-tx' ? 'coverage' : mode === 'missing-datum' ? 'datum coverage' : mode === 'rate-limit' ? '429' : mode === 'rollback' ? 'does not descend' : 'tip changed';
    await expect(createKoiosRepairReader(cursor)([target])).rejects.toThrow(expected);
});

// Advancing blocks do not invalidate the anchored cursor when parent links prove ancestry and
// the current owner output already existed at that cursor. A broken parent link must fail closed.
it.each([true, false])('accepts an advancing tip only with a valid ancestry path: %s', async valid => {
    global.fetch = jest.fn(async (input, init) => {
        const path = new URL(String(input)).pathname.split('/').pop()!;
        if (path === 'tip') return new Response(JSON.stringify([{ hash: 'later', abs_slot: 101 }]));
        if (path === 'block_info') {
            const hash = JSON.parse(String(init?.body))._block_hashes[0];
            return new Response(JSON.stringify(hash === 'later' ? [{ hash, abs_slot: 101, parent_hash: valid ? 'anchor' : 'other' }] : hash === 'anchor' ? [{ hash, abs_slot: 100, parent_hash: 'older' }] : []));
        }
        return new Response(JSON.stringify(path === 'asset_utxos' ? [row] : path === 'tx_info' ? [tx] : [{ datum_hash: 'datumhash', bytes: 'd87980' }]));
    }) as typeof fetch;
    const result = createKoiosRepairReader(cursor)([target]);
    if (valid) expect(await result).toEqual([expect.objectContaining({ id: 'tx#0', slot: 90 })]);
    else await expect(result).rejects.toThrow('does not descend');
});

// A later spend must resolve the unique owner input at the cursor, never the later output.
// Each malformed ancestry fixture must fail rather than guess which historical owner is valid.
it.each(['valid', 'missing-parent', 'minted', 'ambiguous', 'bad-quantity', 'missing-input'] as const)('reconstructs or rejects spent owner ancestry: %s', async mode => {
    const currentOutput = { ...output, tx_hash: 'after', datum_hash: null };
    const parent = mode === 'bad-quantity' ? { ...tx, outputs: [{ ...output, asset_list: [{ ...asset, quantity: '2' }] }] } : tx;
    const otherParent = { ...tx, tx_hash: 'other', outputs: [{ ...output, tx_hash: 'other' }] };
    const inputs = mode === 'missing-input' ? [] : mode === 'ambiguous' ? [{ tx_hash: 'tx', tx_index: 0 }, { tx_hash: 'other', tx_index: 0 }] : [{ tx_hash: 'tx', tx_index: 0 }];
    const after = { ...tx, tx_hash: 'after', absolute_slot: 101, inputs, outputs: [currentOutput], assets_minted: mode === 'minted' ? [asset] : [] };
    global.fetch = jest.fn(async (input, init) => {
        const path = new URL(String(input)).pathname.split('/').pop()!;
        if (path === 'tip') return new Response(JSON.stringify([{ hash: 'later', abs_slot: 101 }]));
        if (path === 'block_info') {
            const hash = JSON.parse(String(init?.body))._block_hashes[0];
            return new Response(JSON.stringify(hash === 'later' ? [{ hash, abs_slot: 101, parent_hash: 'anchor' }] : [{ hash: 'anchor', abs_slot: 100, parent_hash: 'older' }]));
        }
        if (path === 'asset_utxos') return new Response(JSON.stringify([{ ...row, tx_hash: 'after' }]));
        if (path === 'tx_info') {
            const hashes = JSON.parse(String(init?.body))._tx_hashes as string[];
            return new Response(JSON.stringify(hashes.flatMap<unknown>(hash => hash === 'after' ? [after] : hash === 'tx' && mode !== 'missing-parent' ? [parent] : hash === 'other' ? [otherParent] : [])));
        }
        if (path === 'datum_info') return new Response(JSON.stringify([{ datum_hash: 'datumhash', bytes: 'd87980' }]));
        throw new Error(`Unexpected endpoint ${path}`);
    }) as typeof fetch;
    const read = createKoiosRepairReader(cursor)([target]);
    if (mode === 'valid') expect(await read).toEqual([expect.objectContaining({ id: 'tx#0', slot: 90, datum: 'd87980' })]);
    else await expect(read).rejects.toThrow(mode === 'missing-parent' ? 'parent transaction coverage' : mode === 'minted' ? 'minted or burned' : mode === 'ambiguous' ? 'no unique input' : mode === 'bad-quantity' ? 'input quantity' : 'transaction inputs');
});

// A stable provider tip cannot authorize writes if the scanner cursor itself changed between reads.
// Removing the stored-cursor comparison would accept the second call as a new anchor.
it('refuses reuse after the scanner cursor changes', async () => {
    let current = cursor();
    global.fetch = jest.fn(async (input) => {
        const path = new URL(String(input)).pathname.split('/').pop()!;
        return new Response(JSON.stringify(path === 'tip' ? [tip] : path === 'asset_utxos' ? [row] : path === 'tx_info' ? [tx] : [{ datum_hash: 'datumhash', bytes: 'd87980' }]));
    }) as typeof fetch;
    const read = createKoiosRepairReader(() => current);
    await read([target]);
    current = { hash: 'another', slot: 101 };
    await expect(read([target])).rejects.toThrow('Scanner cursor changed');
});
