import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { GlideClient } from '@valkey/valkey-glide';
import harness from '../tests/valkey-harness.cjs';
import { applyField, commitField, undoField } from './experimentalRepairJournal.mjs';

// Explicitly isolated: no environment-derived host or port, and never flush the database.
const prefix = `{experimental-journal:${randomUUID()}}`;
const keys = ['repair', 'scanner', 'journal', 'data', 'gate', 'readers', 'gate-journal', 'pending'].map(part => `${prefix}:${part}`);
const gateScript = readFileSync('stores/redis/experimentalReaderGate.lua', 'utf8');
const gate = (connection, operation, token, journal = '') => connection.customCommand(['EVAL', gateScript, '6', keys[4], keys[5], keys[6], keys[7], keys[0], keys[1], operation, token, journal, 's1']);
let client, peer;
const run = (connection, script, args) => connection.customCommand(['EVAL', script, '8', ...keys, ...args]);
const apply = () => run(client, applyField, ['r1', 's1', 'target', 'new']);
const undo = () => run(client, undoField, ['r1', 's1']);
before(async () => {
    if (process.env.API_TEST_VALKEY_RECEIPT) throw new Error('This test requires its own isolated fixture');
    await harness.start();
    const options = harness.connectionOptions({ addresses: [{ host: '127.0.0.1', port: 6381 }], useTLS: false });
    client = await GlideClient.createClient(options);
    peer = await GlideClient.createClient(options);
    await client.set(keys[0], 'r1');
    await client.set(keys[1], 's1');
    await gate(client, 'close', 'r1', 'repair-journal');
});
after(async () => {
    if (client) { await client.del(keys); client.close(); }
    peer?.close();
    harness.stop();
});

// A repair must not mutate data while an admitted reader can still emit a response.
// Removing either gate check allows a mutation before the reader has drained.
test('requires a held reader gate and no admitted readers', async () => {
    await client.hset(keys[3], { target: 'old' });
    await peer.del([keys[4], keys[6]]);
    await assert.rejects(apply(), /GATE_NOT_HELD/);
    assert.equal(await gate(peer, 'admit', 'reader'), 1);
    assert.equal(await gate(client, 'close', 'r1', 'repair-journal'), 1);
    assert.equal(await gate(peer, 'admit', 'late-reader'), 0);
    await assert.rejects(apply(), /READERS_ACTIVE/);
    assert.equal(await client.hget(keys[3], 'target'), 'old');
    assert.equal(await client.exists([keys[2]]), 0);
    assert.equal(await gate(peer, 'release', 'reader'), 1);
});

// A restart can undo an applied write without disturbing another hash field.
// Omitting the recorded preimage restores the wrong value and fails this test.
test('interrupted repair recovers its field while preserving unrelated writes', async () => {
    await client.hset(keys[3], { target: 'old', unrelated: 'before' });
    assert.equal(await apply(), 1);
    assert.equal(await peer.hget(keys[3], 'target'), 'new');
    assert.equal(await gate(client, 'open', 'r1', 'repair-journal'), 0);
    assert.equal(await peer.hget(keys[2], 'before'), 'old');
    await peer.hset(keys[3], { unrelated: 'after' });
    assert.equal(await run(peer, undoField, ['r1', 's1']), 1);
    assert.equal(await client.hget(keys[3], 'target'), 'old');
    assert.equal(await client.hget(keys[3], 'unrelated'), 'after');
    assert.equal(await client.exists([keys[2]]), 0);
});

// A detected fork after a partial field write can undo that field while keeping the
// reader gate closed and leaving the scanner cursor untouched. This exercises only
// the primitive; no canonical ancestry detection or complete index rollback is implied.
// Omitting undo leaves the repair postimage on the orphaned branch.
test('single-field fork recovery preserves the cursor and keeps readers blocked', async () => {
    const cursorKey = `${prefix}:cursor`;
    await client.set(cursorKey, 'orphaned-anchor');
    try {
        await client.hset(keys[3], { target: 'old' });
        await apply();
        assert.equal(await gate(peer, 'admit', 'new-reader'), 0);
        assert.equal(await run(peer, undoField, ['r1', 's1']), 1);
        assert.equal(await client.hget(keys[3], 'target'), 'old');
        assert.equal(await client.get(cursorKey), 'orphaned-anchor');
        assert.equal(await gate(peer, 'admit', 'still-blocked'), 0);
    } finally {
        await client.del([cursorKey]);
    }
});

// A completed field can only be finalized by the current owner while its postimage matches.
// Removing the conflict check discards recovery evidence after a competing write.
test('commit retains recovery evidence on a conflict or lost lease', async () => {
    await apply();
    await peer.hset(keys[3], { target: 'other-writer' });
    await assert.rejects(run(client, commitField, ['r1', 's1']), /conflict/);
    assert.equal(await gate(client, 'open', 'r1', 'repair-journal'), 0);
    assert.equal(await client.hget(keys[2], 'before'), 'old');
    await peer.hset(keys[3], { target: 'new' });
    await peer.set(keys[1], 's2');
    await assert.rejects(run(client, commitField, ['r1', 's1']), /FENCE_LOST/);
    assert.equal(await client.exists([keys[2]]), 1);
    await peer.set(keys[1], 's1');
    assert.equal(await run(client, commitField, ['r1', 's1']), 1);
    assert.equal(await client.hget(keys[3], 'target'), 'new');
    assert.equal(await client.exists([keys[2]]), 0);
    // Reset only the isolated data for the remaining cases.
    await client.hset(keys[3], { target: 'old' });
});

// A damaged pending-set key must not make finalization erase the only undo record.
// Without prevalidation, Lua runs DEL before the failing SREM and loses the journal.
test('invalid pending-set type preserves the journal during finalization', async () => {
    await apply();
    await client.del([keys[7]]);
    await client.set(keys[7], 'wrong-type');
    await assert.rejects(run(client, commitField, ['r1', 's1']), /pending/);
    assert.equal(await client.hget(keys[2], 'before'), 'old');
    assert.equal(await client.hget(keys[3], 'target'), 'new');
    await client.del([keys[7]]);
    await client.sadd(keys[7], [keys[2]]);
    await undo();
});

// A concurrent change to the target field is never overwritten by undo.
// Removing the postimage comparison causes the conflicting value to be lost.
test('conflicting target change retains both current data and journal', async () => {
    await apply();
    await peer.hset(keys[3], { target: 'other-writer' });
    await assert.rejects(undo(), /conflict/);
    assert.equal(await client.hget(keys[3], 'target'), 'other-writer');
    assert.equal(await client.hget(keys[2], 'before'), 'old');
    await peer.hset(keys[3], { target: 'new' });
    await undo();
});

// Both operations reject a replaced scanner or repair owner without modifying data.
// Removing either fence check lets the stale owner mutate the field.
test('lease loss prevents apply and recovery; absent preimage is restored as absent', async () => {
    await client.hdel(keys[3], ['target']);
    await peer.set(keys[1], 's2');
    await assert.rejects(apply(), /FENCE_LOST/);
    assert.equal(await client.hget(keys[3], 'target'), null);
    assert.equal(await client.exists([keys[2]]), 0);
    await peer.set(keys[1], 's1');
    await apply();
    await peer.set(keys[0], 'r2');
    await assert.rejects(undo(), /FENCE_LOST/);
    assert.equal(await client.hget(keys[3], 'target'), 'new');
    assert.equal(await client.exists([keys[2]]), 1);
    await peer.set(keys[0], 'r1');
    await undo();
    assert.equal(await client.hget(keys[3], 'target'), null);
});

// Characterize the known ABA limitation: a later writer that changes and restores the
// postimage is invisible to this primitive. This is evidence against production use.
test('does not detect a target changed and restored by another writer', async () => {
    await client.hset(keys[3], { target: 'old' });
    await apply();
    await peer.hset(keys[3], { target: 'intervening' });
    await peer.hset(keys[3], { target: 'new' });
    assert.equal(await undo(), 1);
    assert.equal(await client.hget(keys[3], 'target'), 'old');
});

// Invalid input is refused before a journal or data mutation.
// Removing type validation would leave a journal after the later HSET errors.
test('wrong-type data is rejected before recording a journal', async () => {
    await client.del([keys[3]]);
    await client.set(keys[3], 'not a hash');
    await assert.rejects(apply(), /WRONG_DATA_TYPE/);
    assert.equal(await client.get(keys[3]), 'not a hash');
    assert.equal(await client.exists([keys[2]]), 0);
});
