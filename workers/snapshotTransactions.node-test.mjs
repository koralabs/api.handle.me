import '../tests/network-guard.cjs';
import assert from 'node:assert/strict';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { GlideClient } from '@valkey/valkey-glide';
import { claimSnapshot, fencedSnapshotCall, guardedRepositoryWrite } from './redisSync.worker.js';

// Invariant: the native integration profile retains AWS denial while real Valkey works.
// Removing transport fencing makes this fail instead of returning TEST_NETWORK_DENIED.
test('native integration still rejects an unfaked AWS client before networking', async () => {
    const aws = new S3Client({ region: 'us-east-1', endpoint: 'https://s3.amazonaws.com', maxAttempts: 1,
        credentials: { accessKeyId: 'test-only-access', secretAccessKey: 'test-only-secret' } });
    try { await assert.rejects(aws.send(new ListBucketsCommand({})), error => error.code === 'TEST_NETWORK_DENIED'); }
    finally { aws.destroy(); }
});

// Isolated local test server only. Never connect to the default/live port.
const port = Number(process.env.REDIS_PORT ?? 6381);
if (port === 6379 || !Number.isInteger(port)) throw new Error('Tests require a nondefault local Valkey port');
let client;
let peer;
const prefix = `{snapshot-test:${randomUUID()}}`;
const keys = new Set();
const key = suffix => { const value = `${prefix}:${suffix}`; keys.add(value); return value; };
const image = async k => (await client.hgetall(k)).map(({ field, value }) => [String(field), String(value)]).sort();
const setup = async () => {
    const fence = { key: key(randomUUID()), owner: randomUUID(), scannerKey: key(randomUUID()), scannerOwner: 'scanner-A' };
    await client.set(fence.scannerKey, fence.scannerOwner);
    const metricsKey = key(randomUUID());
    const progressKey = key(randomUUID());
    await client.hset(metricsKey, { currentSlot: '10', currentBlockHash: 'original' });
    return { fence, metricsKey, progressKey, originalMetrics: { currentSlot: '10', currentBlockHash: 'original' }, originalProgress: {}, requireEmpty: false, pattern: `${prefix}:*`, dataRoots: [metricsKey] };
};
before(async () => {
    const options = { addresses: [{ host: '127.0.0.1', port }], useTLS: false };
    client = await GlideClient.createClient(options);
    peer = await GlideClient.createClient(options);
});
after(async () => {
    if (client) { if (keys.size) await client.del([...keys]); client.close(); }
    peer?.close();
});

// A guarded repository write must abort even when the repair gate closes and
// reopens between its check and transaction. Removing WATCH permits the write.
test('guarded writer rejects a gate change across its transaction boundary', async () => {
    const gate = key('writer-gate');
    const journal = key('writer-journal');
    const target = key('writer-target');
    await client.hset(target, { utxo: 'old' });
    const boundary = Object.create(client);
    boundary.exec = async (...args) => {
        await peer.set(gate, 'repair');
        await peer.del([gate]);
        return client.exec(...args);
    };
    await assert.rejects(guardedRepositoryWrite(boundary, [gate, journal], 'hset', [target, { utxo: 'wrong' }]), /gate changed/);
    assert.equal(await client.hget(target, 'utxo'), 'old');
    assert.equal(await guardedRepositoryWrite(client, [gate, journal], 'hset', [target, { utxo: 'new' }]), 0);
    assert.equal(await client.hget(target, 'utxo'), 'new');
});

// Snapshot claims and writes must join repair exclusion, including a close/reopen
// race after the check. Removing the gate watch permits the stale snapshot write.
test('opted-in snapshot admission and writes respect the repair gate', async () => {
    const args = await setup();
    const gate = key('snapshot-repair-gate');
    const journal = key('snapshot-repair-journal');
    const guard = [gate, journal, args.fence.scannerKey, key('readers'), key('repair-fence')];
    await peer.set(gate, 'repair');
    assert.equal(await claimSnapshot(client, args, guard), false);
    await peer.del([gate]);
    assert.equal(await claimSnapshot(client, args, guard), true);
    const boundary = Object.create(client);
    boundary.exec = async (...values) => {
        await peer.set(gate, 'repair');
        await peer.del([gate]);
        return client.exec(...values);
    };
    await assert.rejects(fencedSnapshotCall(boundary, args.fence, 'hset', [args.metricsKey, { currentSlot: 'bad' }], guard), /fence changed/);
    assert.equal(await client.hget(args.metricsKey, 'currentSlot'), '10');
    await peer.set(gate, 'repair');
    await assert.rejects(fencedSnapshotCall(client, args.fence, 'hset', [args.metricsKey, { currentSlot: 'bad' }], guard), /gate closed/);
    assert.equal(await client.hget(args.metricsKey, 'currentSlot'), '10');
});

// Invariant: original metrics/progress are compared before ownership is admitted.
// Removing the hash comparison makes the first rejection assertion fail.
test('admission preserves concurrent original-image changes and unchanged control keys', async () => {
    const args = await setup();
    await peer.hset(args.metricsKey, { currentSlot: '11' });
    const before = await image(args.metricsKey);
    assert.equal(await claimSnapshot(client, args), false);
    assert.deepEqual(await image(args.metricsKey), before);
    assert.equal(await client.get(args.fence.key), null);
    assert.equal(await client.get(args.fence.scannerKey), 'scanner-A');
    args.originalMetrics.currentSlot = '11';
    assert.equal(await claimSnapshot(client, args), true);
});

// Invariant: absence of metrics alone is not absence of original data.
// Removing requireEmpty scanning admits the corrupt fresh404 case.
test('genesis admission refuses orphan data, but allows a genuinely empty original', async () => {
    const args = await setup();
    await client.del([args.metricsKey]);
    args.originalMetrics = {};
    args.requireEmpty = true;
    const dataRoot = key(randomUUID());
    const dataKey = key(`${dataRoot.slice(prefix.length + 1)}:member`);
    args.dataRoots.push(dataRoot);
    await client.set(dataKey, 'original');
    assert.equal(await claimSnapshot(client, args), false);
    assert.equal(await client.get(dataKey), 'original');
    await client.del([dataKey]);
    assert.equal(await claimSnapshot(client, args), true);
});

// Invariant: stale workers cannot write or erase successor ownership.
// Removing the owner comparison overwrites original metrics here.
test('fenced writes stop after ownership changes, including between read and transaction', async () => {
    const args = await setup();
    assert.equal(await claimSnapshot(client, args), true);
    await fencedSnapshotCall(client, args.fence, 'hset', [args.metricsKey, { currentSlot: '12' }]);
    assert.deepEqual(await image(args.metricsKey), [['currentBlockHash', 'original'], ['currentSlot', '12']]);
    await peer.set(args.fence.key, 'successor');
    const before = await image(args.metricsKey);
    await assert.rejects(fencedSnapshotCall(client, args.fence, 'hset', [args.metricsKey, { currentSlot: 'bad' }]), /fence lost/);
    assert.deepEqual(await image(args.metricsKey), before);
    assert.equal(await client.get(args.fence.key), 'successor');
    await peer.set(args.fence.key, args.fence.owner);
    const boundary = Object.create(client);
    boundary.exec = async (...values) => {
        await peer.set(args.fence.key, 'new-owner-during-exec');
        return client.exec(...values);
    };
    boundary.watch = (...v) => client.watch(...v);
    boundary.get = (...v) => client.get(...v);
    boundary.unwatch = () => client.unwatch();
    await assert.rejects(fencedSnapshotCall(boundary, args.fence, 'hset', [args.metricsKey, { currentSlot: 'bad' }]), /fence changed/);
    assert.deepEqual(await image(args.metricsKey), before);
    assert.equal(await client.get(args.fence.key), 'new-owner-during-exec');
});

// A fenced transaction must move both handles and indexes together, or none of them if the
// scanner lease changes at EXEC. The unrelated shared-output owner must remain untouched.
// Removing WATCH on scannerKey makes the injected successor commit the stale batch.
test('shared-output candidate batch is fenced against lease loss during commit', async () => {
    const args = await setup();
    assert.equal(await claimSnapshot(client, args), true);
    const alpha = key('alpha'); const beta = key('beta'); const other = key('other');
    const oldA = key('old-a'); const oldB = key('old-b'); const current = key('current');
    const oldHolder = key('old-holder'); const newHolder = key('new-holder'); const slots = key('slots');
    await client.hset(alpha, { utxo: 'old-a#0', holder: 'old', slot: '10' });
    await client.hset(beta, { utxo: 'old-b#0', holder: 'old', slot: '10' });
    await client.hset(other, { utxo: 'new#0', holder: 'new', slot: '20' });
    await client.set(oldA, 'old-a'); await client.set(oldB, 'old-b');
    await client.set(current, JSON.stringify(['alpha', 'beta', 'other']));
    await client.sadd(oldHolder, ['alpha', 'beta']); await client.sadd(newHolder, ['other']);
    await client.zadd(slots, [{ element: 'alpha', score: 10 }, { element: 'beta', score: 10 }, { element: 'other', score: 20 }]);
    const snapshot = async () => ({ alpha: await image(alpha), beta: await image(beta), other: await image(other),
        oldA: await client.get(oldA), oldB: await client.get(oldB), current: await client.get(current),
        oldHolder: [...await client.smembers(oldHolder)].map(String).sort(), newHolder: [...await client.smembers(newHolder)].map(String).sort(),
        slots: await client.zrangeWithScores(slots, { start: 0, end: -1 }), metrics: await image(args.metricsKey) });
    const before = await snapshot();
    const commands = [
        ['hset', [alpha, { utxo: 'new#0', holder: 'new', slot: '20' }]],
        ['hset', [beta, { utxo: 'new#0', holder: 'new', slot: '20' }]],
        ['srem', [oldHolder, ['alpha', 'beta']]], ['sadd', [newHolder, ['alpha', 'beta']]],
        ['zadd', [slots, [{ element: 'alpha', score: 20 }, { element: 'beta', score: 20 }]]],
        ['del', [[oldA, oldB]]]
    ];
    const boundary = Object.create(client);
    boundary.watch = (...v) => client.watch(...v);
    boundary.get = (...v) => client.get(...v);
    boundary.unwatch = () => client.unwatch();
    boundary.exec = async (...v) => { await peer.set(args.fence.scannerKey, 'successor'); return client.exec(...v); };
    await assert.rejects(fencedSnapshotCall(boundary, args.fence, 'batch', [commands]), /fence changed/);
    assert.deepEqual(await snapshot(), before);
    assert.equal(await client.get(args.fence.scannerKey), 'successor');
    await peer.set(args.fence.scannerKey, args.fence.scannerOwner);
    await fencedSnapshotCall(client, args.fence, 'batch', [commands]);
    assert.deepEqual(await image(alpha), [['holder', 'new'], ['slot', '20'], ['utxo', 'new#0']]);
    assert.deepEqual(await image(beta), [['holder', 'new'], ['slot', '20'], ['utxo', 'new#0']]);
    assert.deepEqual(await image(other), before.other);
    assert.equal(await client.get(oldA), null); assert.equal(await client.get(oldB), null);
    assert.equal(await client.get(current), before.current);
    assert.deepEqual([...await client.smembers(oldHolder)], []);
    assert.deepEqual([...await client.smembers(newHolder)].map(String).sort(), ['alpha', 'beta', 'other']);
    assert.deepEqual((await client.zrangeWithScores(slots, { start: 0, end: -1 })).map(x => [String(x.element), x.score]), [['alpha', 20], ['beta', 20], ['other', 20]]);
    assert.deepEqual(await image(args.metricsKey), before.metrics);
});

// Characterization: this fence protects participating calls, not arbitrary writers.
// If the system later enforces exclusive writes, this direct write must be rejected and this test retargeted.
test('snapshot lease does not itself block an unfenced writer', async () => {
    const args = await setup();
    assert.equal(await claimSnapshot(client, args), true);
    await peer.hset(args.metricsKey, { currentSlot: '99' });
    assert.deepEqual(await image(args.metricsKey), [['currentBlockHash', 'original'], ['currentSlot', '99']]);
    assert.equal(await client.get(args.fence.key), args.fence.owner);
});

// Invariant: a legacy importer reserves the absent scanner lease atomically with admission.
// Removing the scanner SET admits a concurrent scanner and fails this exact token assertion.
test('standalone import reserves an absent scanner lease rather than borrowing a later owner', async () => {
    const args = await setup();
    await client.del([args.fence.scannerKey]);
    args.scannerOriginal = null;
    args.fence.scannerOwner = args.fence.owner;
    args.fence.ownsScannerLease = true;
    assert.equal(await claimSnapshot(client, args), true);
    assert.equal(await client.get(args.fence.scannerKey), args.fence.owner);
    assert.equal(await client.set(args.fence.scannerKey, 'competitor', { conditionalSet: 'onlyIfDoesNotExist' }), null);
    await fencedSnapshotCall(client, args.fence, 'hset', [args.metricsKey, { currentSlot: '13' }]);
    assert.deepEqual(await image(args.metricsKey), [['currentBlockHash', 'original'], ['currentSlot', '13']]);
});

// Invariant: a new scanner lease invalidates the snapshot writer.
// Removing scanner ownership from the fence lets this write through.
test('scanner replacement preserves metrics and its own control lease', async () => {
    const args = await setup();
    assert.equal(await claimSnapshot(client, args), true);
    await peer.set(args.fence.scannerKey, 'scanner-B');
    await assert.rejects(fencedSnapshotCall(client, args.fence, 'del', [[args.metricsKey]]), /fence lost/);
    assert.deepEqual(await image(args.metricsKey), [['currentBlockHash', 'original'], ['currentSlot', '10']]);
    assert.equal(await client.get(args.fence.scannerKey), 'scanner-B');
});
