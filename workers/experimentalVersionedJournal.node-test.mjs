import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { GlideClient } from '@valkey/valkey-glide';
import harness from '../tests/valkey-harness.cjs';
import { apply, write, undo } from './experimentalVersionedJournal.mjs';

const prefix = `{versioned-journal:${randomUUID()}}`;
const keys = ['repair', 'scanner', 'journal', 'data', 'version'].map(part => `${prefix}:${part}`);
let client, peer;
const run = (c, script, ks, args) => c.customCommand(['EVAL', script, String(ks.length), ...ks, ...args]);
before(async () => {
    if (process.env.API_TEST_VALKEY_RECEIPT) throw new Error('This test requires its own isolated fixture');
    await harness.start();
    const opts = harness.connectionOptions({ addresses: [{ host: '127.0.0.1', port: 6381 }], useTLS: false });
    client = await GlideClient.createClient(opts);
    peer = await GlideClient.createClient(opts);
    await client.set(keys[0], 'repair-owner');
    await client.set(keys[1], 'scanner-owner');
});
after(async () => {
    if (client) { await client.del(keys); client.close(); }
    peer?.close();
    harness.stop();
});

// Control, journal, data and version keys must never alias each other.
// Without the overlap checks a caller can corrupt the data or ownership keys.
test('rejects aliased data, version and control keys before mutation', async () => {
    const invalid = [...keys];
    invalid[4] = keys[3];
    await assert.rejects(run(client, apply, invalid, ['repair-owner', 'scanner-owner', 'owner', 'new']), /OVERLAPPING_KEYS/);
    await assert.rejects(run(client, write, [keys[3], keys[3]], ['owner', 'new']), /OVERLAPPING_KEYS/);
    assert.equal(await client.exists([keys[2], keys[3], keys[4]]), 0);
    assert.equal(await client.get(keys[0]), 'repair-owner');
    assert.equal(await client.get(keys[1]), 'scanner-owner');
});

// A cooperating writer changing and restoring the same value must still prevent undo.
// Removing the version comparison lets undo erase the intervening writer's result.
test('versioned recovery rejects a change followed by restoration', async () => {
    await client.hset(keys[3], { owner: 'old', unrelated: 'preserved' });
    assert.equal(await run(client, apply, keys, ['repair-owner', 'scanner-owner', 'owner', 'new']), 1);
    assert.equal(await run(peer, write, [keys[3], keys[4]], ['owner', 'other']), 1);
    assert.equal(await run(peer, write, [keys[3], keys[4]], ['owner', 'new']), 1);
    await assert.rejects(run(client, undo, keys, ['repair-owner', 'scanner-owner']), /conflict/);
    assert.equal(await client.hget(keys[3], 'owner'), 'new');
    assert.equal(await client.hget(keys[3], 'unrelated'), 'preserved');
    assert.equal(await client.hget(keys[2], 'before'), 'old');
});

// Direct writes that bypass versioning remain invisible; this proves the experiment
// cannot be used until every writer of the affected field cooperates.
test('unversioned writers bypass conflict detection', async () => {
    await client.del([keys[2], keys[3], keys[4]]);
    await client.hset(keys[3], { owner: 'old' });
    await run(client, apply, keys, ['repair-owner', 'scanner-owner', 'owner', 'new']);
    await peer.hset(keys[3], { owner: 'other' });
    await peer.hset(keys[3], { owner: 'new' });
    assert.equal(await run(client, undo, keys, ['repair-owner', 'scanner-owner']), 1);
    assert.equal(await client.hget(keys[3], 'owner'), 'old');
});

// When no writer touched the target, recovery restores the old field without changing others.
// Removing the original preimage yields the wrong value after undo.
test('recovery restores an uncontended field and keeps unrelated changes', async () => {
    await client.del([keys[2], keys[3], keys[4]]);
    await client.hset(keys[3], { owner: 'old', unrelated: 'before' });
    await run(client, apply, keys, ['repair-owner', 'scanner-owner', 'owner', 'new']);
    await run(peer, write, [keys[3], keys[4]], ['unrelated', 'after']);
    await peer.set(keys[1], 'successor');
    await assert.rejects(run(client, undo, keys, ['repair-owner', 'scanner-owner']), /FENCE_LOST/);
    assert.equal(await client.hget(keys[3], 'owner'), 'new');
    await peer.set(keys[1], 'scanner-owner');
    assert.equal(await run(client, undo, keys, ['repair-owner', 'scanner-owner']), 1);
    assert.equal(await client.hget(keys[3], 'owner'), 'old');
    assert.equal(await client.hget(keys[3], 'unrelated'), 'after');
    assert.equal(await client.exists([keys[2]]), 0);
});
