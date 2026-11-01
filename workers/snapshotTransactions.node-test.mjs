import '../tests/network-guard.cjs';
import assert from 'node:assert/strict';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { GlideClient } from '@valkey/valkey-glide';
import { claimSnapshot, fencedSnapshotCall } from './redisSync.worker.js';

// Invariant: the native integration profile retains AWS denial while real Valkey works.
// Removing transport fencing makes this fail instead of returning TEST_NETWORK_DENIED.
test('native integration still rejects an unfaked AWS client before networking', async () => {
    const aws = new S3Client({ region: 'us-east-1', endpoint: 'https://s3.amazonaws.com', maxAttempts: 1,
        credentials: { accessKeyId: 'test-only-access', secretAccessKey: 'test-only-secret' } });
    try { await assert.rejects(aws.send(new ListBucketsCommand({})), error => error.code === 'TEST_NETWORK_DENIED'); }
    finally { aws.destroy(); }
});

// Isolated local test server only. Never connect to the default/live port.
const port = Number(process.env.REDIS_PORT ?? 6380);
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
