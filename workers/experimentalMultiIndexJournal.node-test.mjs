import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import express from 'express';
import { experimentalReaderMiddleware } from './experimentalReaderMiddleware.mjs';
import { after, before, test } from 'node:test';
import { GlideClient } from '@valkey/valkey-glide';
import harness from '../tests/valkey-harness.cjs';
import { readerGate, apply, undo } from './experimentalMultiIndexJournal.mjs';

const prefix = `{multi-journal:${randomUUID()}}`;
const keys = ['repair', 'scanner', 'gate', 'readers', 'journal', 'hash', 'holder', 'address', 'payment', 'utxo', 'pending', 'metrics'].map(x => `${prefix}:${x}`);
const owners = ['repair-owner', 'scanner-owner', 'transaction-id'];
const mutation = [...owners, 'owner', 'new', 'holder-member', '0', 'address-member', '1', 'payment-member', '0', 'utxo-member', '42'];
let client, peer;
const run = (c, script, args, ks = keys) => c.customCommand(['EVAL', script, String(ks.length), ...ks, ...args]);
const gate = (op, ...args) => run(client, readerGate, [op, ...args]);
const leases = async () => { await client.customCommand(['SET', keys[0], owners[0], 'PX', '120000']); await client.customCommand(['SET', keys[1], owners[1], 'PX', '120000']); };
const reset = async () => { await client.del(keys); await leases(); await client.hset(keys[11], { currentSlot: '100', currentBlockHash: 'block-100' }); };
const seed = async () => {
    await client.hset(keys[5], { owner: 'old', untouched: 'original' });
    await client.customCommand(['SADD', keys[6], 'holder-member', 'other']);
    await client.customCommand(['SADD', keys[7], 'other']);
    await client.customCommand(['SADD', keys[8], 'payment-member', 'other']);
    await client.customCommand(['ZADD', keys[9], '7', 'utxo-member', '9', 'other']);
};
const close = () => gate('close', ...owners);
const open = () => gate('open', ...owners);
const state = async () => [await client.hget(keys[5], 'owner'),
    ...await Promise.all([6, 7, 8].map(i => client.customCommand(['SISMEMBER', keys[i], mutation[(i - 6) * 2 + 5]]))),
    await client.customCommand(['ZSCORE', keys[9], 'utxo-member'])];

before(async () => {
    if (process.env.API_TEST_VALKEY_RECEIPT) throw new Error('Requires an exclusively owned fixture');
    await harness.start();
    const opts = harness.connectionOptions({ addresses: [{ host: '127.0.0.1', port: 6381 }], useTLS: false });
    client = await GlideClient.createClient(opts); peer = await GlideClient.createClient(opts);
});
after(async () => {
    if (client) { await client.del(keys); client.close(); }
    peer?.close(); harness.stop();
});

// Readers admitted before closure must drain, and none can enter until recovery
// and fenced reopening. Removing the drain or journal checks breaks this test.
test('fenced reader admission and multi-index recovery preserve unrelated members', async () => {
    await reset(); await seed();
    assert.equal(await gate('admit', 'reader-1'), 1);
    assert.equal(await close(), 1);
    assert.equal(await gate('admit', 'reader-2'), 0);
    await assert.rejects(run(client, apply, mutation), /READERS_ACTIVE/);
    assert.equal(await gate('release', 'reader-1'), 1);
    assert.equal(await run(client, apply, mutation), 1);
    assert.deepEqual(await state(), ['new', false, true, false, 42]);
    assert.equal(await open(), 0);
    await peer.hset(keys[5], { untouched: 'changed' });
    await peer.customCommand(['SADD', keys[6], 'new-unrelated']);
    await peer.customCommand(['ZADD', keys[9], '11', 'new-unrelated']);
    assert.equal(await run(client, undo, owners), 1);
    assert.deepEqual(await state(), ['old', true, false, true, 7]);
    assert.equal(await client.hget(keys[5], 'untouched'), 'changed');
    assert.equal(await client.customCommand(['SISMEMBER', keys[6], 'new-unrelated']), true);
    assert.equal(await client.customCommand(['ZSCORE', keys[9], 'new-unrelated']), 11);
    assert.equal(await open(), 1);
    assert.equal(await gate('admit', 'reader-2'), 1);
    assert.equal(await gate('release', 'reader-2'), 1);
});

// A gate cannot reopen just because the first journal was recovered while a
// second journal is still pending. Removing the pending-set check exposes it.
test('all journals must be recovered before readers are admitted', async () => {
    await reset(); await seed();
    const otherKeys = [...keys];
    otherKeys[4] = `${prefix}:second-journal`;
    otherKeys[5] = `${prefix}:second-hash`;
    const otherMutation = [...owners, 'owner', 'second-new', 'other', '0', 'other', '0', 'other', '0', 'other', '43'];
    try {
        await client.hset(otherKeys[5], { owner: 'second-old' });
        await close();
        assert.equal(await run(client, apply, mutation), 1);
        assert.equal(await run(client, apply, otherMutation, otherKeys), 1);
        assert.equal(await run(client, undo, owners), 1);
        assert.equal(await open(), 0);
        assert.equal(await gate('admit', 'late'), 0);
        assert.equal(await run(client, undo, owners, otherKeys), 1);
        assert.equal(await client.hget(otherKeys[5], 'owner'), 'second-old');
        assert.equal(await client.customCommand(['ZSCORE', keys[9], 'other']), 9);
        assert.equal(await open(), 1);
    } finally {
        await client.del([otherKeys[4], otherKeys[5]]);
    }
});

// A missing gate key must not admit readers while any other journal remains.
// Omitting the pending-set check allows a reader through this broken-control state.
test('pending journals still exclude readers if the gate key disappears', async () => {
    await reset(); await seed(); await close(); await run(client, apply, mutation);
    await client.del([keys[2]]);
    const otherKeys = [...keys];
    otherKeys[4] = `${prefix}:unrelated-journal`;
    assert.equal(await run(client, readerGate, ['admit', 'late'], otherKeys), 0);
});

// If Lua fails between registering a journal and writing it, there is no undo
// record; the gate must remain closed rather than treat the absent key as safe.
test('interruption before journal creation leaves admission closed', async () => {
    await reset(); await seed(); await close();
    const marker = "redis.call('SADD', KEYS[11], KEYS[5])";
    const injected = apply.replace(marker, `${marker}; error('injected before journal')`);
    assert.notEqual(injected, apply);
    await assert.rejects(run(client, injected, mutation), /injected before journal/);
    assert.equal(await open(), 0);
    assert.equal(await gate('admit', 'late'), 0);
    await assert.rejects(run(client, undo, owners, keys), /JOURNAL_MISSING/);
    assert.deepEqual(await state(), ['old', true, false, true, 7]);
});

// Undo cannot overwrite chain-derived data after the scanner cursor changes.
// Removing the cursor check allows recovery against the wrong chain state.
test('advanced scanner cursor refuses undo and keeps readers out', async () => {
    await reset(); await seed(); await close();
    assert.equal(await run(client, apply, mutation), 1);
    await peer.hset(keys[11], { currentSlot: '101', currentBlockHash: 'block-101' });
    await assert.rejects(run(client, undo, owners), /CURSOR_CONFLICT/);
    assert.deepEqual(await state(), ['new', false, true, false, 42]);
    assert.equal(await open(), 0);
    assert.equal(await gate('admit', 'late'), 0);
    assert.equal(await client.hget(keys[11], 'currentBlockHash'), 'block-101');
});

// An HTTP stream must drain before this multi-index mutation can run. Removing
// reader admission or the drain check would allow the write while the stream is open.
test('HTTP stream gates a multi-index write until response completion', async () => {
    await reset(); await seed();
    let onRelease;
    const released = new Promise(resolve => { onRelease = resolve; });
    const guarded = { customCommand: async args => {
        const result = await peer.customCommand(args);
        if (args[15] === 'release') onRelease();
        return result;
    } };
    const app = express();
    app.use(experimentalReaderMiddleware(guarded, readerGate, keys));
    let stream;
    app.get('/', (_req, res) => { stream = res; res.write('first'); });
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    try {
        const response = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server.address().port, path: '/' }, resolve).on('error', reject));
        await new Promise(resolve => response.once('data', resolve));
        assert.equal(await close(), 1);
        await assert.rejects(run(client, apply, mutation), /READERS_ACTIVE/);
        assert.deepEqual(await state(), ['old', true, false, true, 7]);
        stream.end('last');
        response.resume();
        await released;
        assert.equal(await run(client, apply, mutation), 1);
        assert.equal(await run(client, undo, owners), 1);
        assert.deepEqual(await state(), ['old', true, false, true, 7]);
        assert.equal(await open(), 1);
    } finally {
        stream?.destroy();
        await new Promise(resolve => server.close(resolve));
    }
});

// Losing either lease must prevent mutation, undo, and reopening. Reusing old
// ownership after a lease loss would otherwise expose or overwrite partial state.
test('lease loss fails closed and a successor can recover with the gate id', async () => {
    await reset(); await seed(); await close(); await run(client, apply, mutation);
    await peer.customCommand(['SET', keys[0], 'successor', 'PX', '120000']);
    await assert.rejects(run(client, undo, owners), /FENCE_LOST/);
    await assert.rejects(open(), /FENCE_LOST/);
    assert.equal(await gate('admit', 'reader'), 0);
    assert.deepEqual(await state(), ['new', false, true, false, 42]);
    assert.equal(await client.get(keys[0]), 'successor');
    assert.equal(await client.get(keys[1]), owners[1]);
    assert.equal(await run(peer, undo, ['successor', owners[1], owners[2]]), 1);
    await assert.rejects(open(), /FENCE_LOST/);
    assert.equal(await run(peer, readerGate, ['open', 'successor', owners[1], owners[2]]), 1);
    assert.deepEqual(await state(), ['old', true, false, true, 7]);
});

// A lost scanner lease independently blocks new repairs and reopening. Removing
// the scanner fence would allow an obsolete scanner to expose or mutate state.
test('scanner lease loss blocks apply and opening', async () => {
    await reset(); await seed(); await close();
    await peer.customCommand(['DEL', keys[1]]);
    await assert.rejects(run(client, apply, mutation), /FENCE_LOST/);
    await assert.rejects(open(), /FENCE_LOST/);
    assert.equal(await gate('admit', 'reader'), 0);
    assert.deepEqual(await state(), ['old', true, false, true, 7]);
});

// A conflict in any one index must stop all recovery, retaining the gate and
// evidence. Removing any postimage check lets this erase another writer's work.
for (const [name, change] of [
    ['hash', () => peer.hset(keys[5], { owner: 'other' })],
    ['holder', () => peer.customCommand(['SADD', keys[6], 'holder-member'])],
    ['address', () => peer.customCommand(['SREM', keys[7], 'address-member'])],
    ['payment', () => peer.customCommand(['SADD', keys[8], 'payment-member'])],
    ['slot', () => peer.customCommand(['ZADD', keys[9], '43', 'utxo-member'])]
]) test(`conflict in ${name} prevents every undo`, async () => {
    await reset(); await seed(); await close(); await run(client, apply, mutation);
    await change(); const before = await state();
    await assert.rejects(run(client, undo, owners), /CONFLICT/);
    assert.deepEqual(await state(), before);
    assert.equal(await client.exists([keys[4]]), 1);
    assert.equal(await open(), 0);
    assert.equal(await gate('admit', 'reader'), 0);
});

// Absent original values must be removed on undo rather than invented; a broken
// absent-value sentinel would leave the new hash field or slot behind.
test('recovery restores absent hash and sorted-set members', async () => {
    await reset(); await close();
    assert.equal(await run(client, apply, mutation), 1);
    assert.equal(await run(client, undo, owners), 1);
    assert.equal(await client.hget(keys[5], 'owner'), null);
    assert.equal(await client.customCommand(['ZSCORE', keys[9], 'utxo-member']), null);
    assert.equal(await client.customCommand(['SISMEMBER', keys[7], 'address-member']), false);
    assert.equal(await open(), 1);
});

// Invalid types and aliased keys must be rejected before the journal or data is
// written; otherwise a bad input can create a partial repair.
test('invalid inputs and overlapping keys do not mutate state', async () => {
    await reset(); await seed(); await close();
    const invalid = [...mutation]; invalid[12] = 'not-a-score';
    await assert.rejects(run(client, apply, invalid), /INVALID_SCORE/);
    const aliases = [...keys]; aliases[9] = keys[6];
    await assert.rejects(run(client, apply, mutation, aliases), /OVERLAPPING_KEYS/);
    assert.equal(await client.exists([keys[4]]), 0);
    assert.deepEqual(await state(), ['old', true, false, true, 7]);
});

// Runtime errors do not roll back Lua writes. Inject an error after the first
// data write: the journal and gate must survive and automatic undo must refuse.
test('runtime error after partial mutation stays closed for manual recovery', async () => {
    await reset(); await seed(); await close();
    const injected = apply.replace("redis.call('HSET', KEYS[6], ARGV[4], ARGV[5])", "redis.call('HSET', KEYS[6], ARGV[4], ARGV[5]); error('injected failure')");
    assert.notEqual(injected, apply);
    await assert.rejects(run(client, injected, mutation), /injected failure/);
    assert.deepEqual(await state(), ['new', true, false, true, 7]);
    await assert.rejects(run(client, undo, owners), /CONFLICT/);
    assert.equal(await open(), 0);
    assert.equal(await gate('admit', 'reader'), 0);
});

// Under the experimental exclusive-writer assumption, recovery may accept each
// field at either its recorded preimage or postimage after a partial Lua failure.
// Without partial mode the unchanged set/slot entries reject recovery.
test('partial-mode recovery restores a partially executed multi-index write', async () => {
    await reset(); await seed(); await close();
    const injected = apply.replace("redis.call('HSET', KEYS[6], ARGV[4], ARGV[5])", "redis.call('HSET', KEYS[6], ARGV[4], ARGV[5]); error('injected failure')");
    await assert.rejects(run(client, injected, mutation), /injected failure/);
    await peer.hset(keys[5], { untouched: 'changed' });
    await peer.customCommand(['SADD', keys[6], 'new-unrelated']);
    assert.equal(await run(client, undo, [...owners, 'partial']), 1);
    assert.deepEqual(await state(), ['old', true, false, true, 7]);
    assert.equal(await client.hget(keys[5], 'untouched'), 'changed');
    assert.equal(await client.customCommand(['SISMEMBER', keys[6], 'new-unrelated']), true);
    assert.equal(await gate('admit', 'reader'), 0);
    assert.equal(await open(), 1);
});

// A crash-like Lua error at different mutation boundaries leaves enough evidence
// for partial recovery under the experimental exclusive-writer assumption.
// Without preimage-aware recovery, at least the journal-only case fails.
for (const [phase, marker] of [
    ['journal', "redis.call('SET', KEYS[5], journal)"],
    ['sets', "if ARGV[13] == 'absent' then redis.call('ZREM', KEYS[10], ARGV[12]) else redis.call('ZADD', KEYS[10], ARGV[13], ARGV[12]) end"]
]) test(`partial recovery after ${phase} boundary`, async () => {
    await reset(); await seed(); await close();
    const injected = apply.replace(marker, `${marker}; error('injected failure')`);
    assert.notEqual(injected, apply);
    await assert.rejects(run(client, injected, mutation), /injected failure/);
    assert.equal(await gate('admit', 'reader'), 0);
    assert.equal(await run(client, undo, [...owners, 'partial']), 1);
    assert.deepEqual(await state(), ['old', true, false, true, 7]);
    assert.equal(await open(), 1);
});

// Partial mode still rejects a third, unexpected value and preserves the journal.
// Removing the hash pre/post comparison would overwrite the competing value.
test('partial-mode recovery refuses an unexpected hash value', async () => {
    await reset(); await seed(); await close(); await run(client, apply, mutation);
    await peer.hset(keys[5], { owner: 'unexpected' });
    const before = await state();
    await assert.rejects(run(client, undo, [...owners, 'partial']), /CONFLICT/);
    assert.deepEqual(await state(), before);
    assert.equal(await client.exists([keys[4]]), 1);
    assert.equal(await open(), 0);
});

// Pause the verified container after application, then resume it and recover via
// a different connection. This is a real server interruption, not a stub. The
// negative control is a closed gate/journal blocking admission during recovery.
test('server interruption leaves a recoverable closed gate', async () => {
    await reset(); await seed(); await close(); await run(client, apply, mutation);
    const { containerId } = harness.verify();
    const docker = action => execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', action, containerId], { stdio: 'ignore' });
    docker('pause');
    let pending;
    try {
        pending = run(peer, readerGate, ['admit', 'interrupted-reader']);
        const outcome = await Promise.race([pending.then(() => 'responded'), new Promise(resolve => setTimeout(() => resolve('paused'), 100))]);
        assert.equal(outcome, 'paused');
    } finally { docker('unpause'); }
    assert.equal(await pending, 0);
    assert.equal(await run(peer, undo, owners), 1);
    assert.deepEqual(await state(), ['old', true, false, true, 7]);
    assert.equal(await open(), 1);
});
