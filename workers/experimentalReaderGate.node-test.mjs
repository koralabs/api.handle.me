import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import express from 'express';
import { experimentalReaderMiddleware } from './experimentalReaderMiddleware.mjs';
import { applyField, undoField } from './experimentalRepairJournal.mjs';
import { after, before, test } from 'node:test';
import { GlideClient } from '@valkey/valkey-glide';
import harness from '../tests/valkey-harness.cjs';

const script = readFileSync('stores/redis/experimentalReaderGate.lua', 'utf8');
const prefix = `{experimental-reader-gate:${randomUUID()}}`;
const keys = ['gate', 'readers', 'journal', 'pending', 'repair-lease', 'scanner-lease'].map(part => `${prefix}:${part}`);
let writer, reader;
const call = (client, operation, token, journal = '') => client.customCommand(['EVAL', script, '6', ...keys, operation, token, journal, 'scanner']);

before(async () => {
    if (process.env.API_TEST_VALKEY_RECEIPT) throw new Error('This test requires its own isolated fixture');
    await harness.start();
    const options = harness.connectionOptions({ addresses: [{ host: '127.0.0.1', port: 6381 }], useTLS: false });
    writer = await GlideClient.createClient(options);
    reader = await GlideClient.createClient(options);
    await writer.set(keys[4], 'writer');
    await writer.set(keys[5], 'scanner');
});
after(async () => {
    if (writer) { await writer.del(keys); writer.close(); }
    reader?.close();
    harness.stop();
});

// Admitted streams block a writer until each one closes, while new streams remain blocked.
// Without the SCARD or admission checks the writer proceeds too soon or a late reader enters.
test('reader drain and admission remain fenced across independent clients', async () => {
    assert.equal(await call(reader, 'admit', 'reader-a'), 1);
    assert.equal(await call(reader, 'admit', 'reader-b'), 1);
    assert.equal(await call(writer, 'close', 'writer', 'journal'), 1);
    assert.equal(await call(reader, 'admit', 'late-reader'), 0);
    assert.equal(await call(writer, 'drained', 'writer'), 0);
    assert.equal(await call(writer, 'open', 'writer', 'journal'), 0);
    assert.equal(await call(reader, 'release', 'reader-a'), 1);
    assert.equal(await call(writer, 'drained', 'writer'), 0);
    await assert.rejects(call(writer, 'drained', 'other-writer'), /FENCE_LOST/);
    assert.equal(await call(reader, 'release', 'reader-b'), 1);
    assert.equal(await call(writer, 'drained', 'writer'), 1);
    await writer.set(keys[5], 'successor');
    await assert.rejects(call(writer, 'open', 'writer', 'journal'), /FENCE_LOST/);
    assert.equal(await writer.get(keys[2]), 'journal');
    await writer.set(keys[5], 'scanner');
    assert.equal(await call(reader, 'admit', 'still-closed'), 0);
    assert.equal(await writer.get(keys[2]), 'journal');
    await assert.rejects(call(writer, 'open', 'other-writer', 'journal'), /FENCE_LOST/);
    assert.equal(await call(writer, 'open', 'writer', 'changed-journal'), 0);
    assert.equal(await writer.get(keys[2]), 'journal');
    await writer.sadd(keys[3], ['unfinished-batch']);
    assert.equal(await call(writer, 'open', 'writer', 'journal'), 0);
    assert.equal(await writer.get(keys[2]), 'journal');
    await writer.srem(keys[3], ['unfinished-batch']);
    assert.equal(await call(writer, 'open', 'writer', 'journal'), 1);
    assert.equal(await writer.get(keys[2]), null);
    assert.equal(await call(reader, 'admit', 'fresh-reader'), 1);
    assert.equal(await call(reader, 'release', 'fresh-reader'), 1);
});

// If release fails, the token must remain and prevent a repair from starting.
// Treating a failed release as successful would incorrectly report the gate drained.
test('failed token release leaves repair blocked', async () => {
    let releaseAttempted;
    const attempted = new Promise(resolve => { releaseAttempted = resolve; });
    const guarded = { customCommand: async args => {
        if (args[9] === 'release') { releaseAttempted(); throw new Error('connection lost'); }
        return reader.customCommand(args);
    } };
    const app = express();
    app.use(experimentalReaderMiddleware(guarded, script, keys));
    app.get('/', (_req, res) => res.send('done'));
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    try {
        const response = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server.address().port, path: '/' }, resolve).on('error', reject));
        assert.equal(response.statusCode, 200);
        response.resume();
        await attempted;
        await writer.set(keys[4], 'failed-release-writer');
        assert.equal(await call(writer, 'close', 'failed-release-writer', 'failed-release-journal'), 1);
        assert.equal(await call(writer, 'drained', 'failed-release-writer'), 0);
        // The server is closed before this isolated-test-only orphan cleanup.
        await new Promise(resolve => server.close(resolve));
        const orphaned = await writer.smembers(keys[1]);
        assert.equal(orphaned.size, 1);
        await writer.srem(keys[1], [...orphaned]);
        assert.equal(await call(writer, 'open', 'failed-release-writer', 'failed-release-journal'), 1);
    } finally {
        if (server.listening) await new Promise(resolve => server.close(resolve));
    }
});

// A client that disconnects while Valkey admission is in flight must not strand a token.
// Removing the post-admission closed-response check leaves repair blocked indefinitely.
test('disconnect during admission releases the token without running the handler', async () => {
    let allowAdmission, admissionStarted, onRelease;
    const canAdmit = new Promise(resolve => { allowAdmission = resolve; });
    const started = new Promise(resolve => { admissionStarted = resolve; });
    const released = new Promise(resolve => { onRelease = resolve; });
    const guarded = { customCommand: async args => {
        if (args[9] === 'admit') { admissionStarted(); await canAdmit; }
        const result = await reader.customCommand(args);
        if (args[9] === 'release') onRelease();
        return result;
    } };
    const app = express();
    app.use(experimentalReaderMiddleware(guarded, script, keys));
    let handled = false;
    app.get('/', (_req, res) => { handled = true; res.send('unexpected'); });
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    try {
        const request = http.get({ host: '127.0.0.1', port: server.address().port, path: '/' });
        request.on('error', () => {});
        await started;
        const disconnected = new Promise(resolve => request.once('close', resolve));
        request.destroy();
        await disconnected;
        allowAdmission();
        await released;
        assert.equal(handled, false);
        await writer.set(keys[4], 'admission-writer');
        assert.equal(await call(writer, 'close', 'admission-writer', 'admission-journal'), 1);
        assert.equal(await call(writer, 'drained', 'admission-writer'), 1);
        assert.equal(await call(writer, 'open', 'admission-writer', 'admission-journal'), 1);
    } finally {
        allowAdmission();
        await new Promise(resolve => server.close(resolve));
    }
});

// A client disconnect releases its reader token only when the response closes.
// Without the close handler, the repair remains blocked even though the stream is gone.
test('disconnecting a stream releases its reader token', async () => {
    let onRelease;
    const released = new Promise(resolve => { onRelease = resolve; });
    const guarded = { customCommand: async args => {
        const result = await reader.customCommand(args);
        if (args[9] === 'release') onRelease();
        return result;
    } };
    const app = express();
    app.use(experimentalReaderMiddleware(guarded, script, keys));
    app.get('/', (_req, res) => res.write('partial'));
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    try {
        const response = await new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port: server.address().port, path: '/' }, resolve).on('error', reject));
        await new Promise(resolve => response.once('data', resolve));
        await writer.set(keys[4], 'abort-writer');
        assert.equal(await call(writer, 'close', 'abort-writer', 'abort-journal'), 1);
        assert.equal(await call(writer, 'drained', 'abort-writer'), 0);
        response.destroy();
        await released;
        assert.equal(await call(writer, 'drained', 'abort-writer'), 1);
        assert.equal(await call(writer, 'open', 'abort-writer', 'abort-journal'), 1);
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
});

// A streaming response remains admitted until its connection finishes. Removing the
// lifetime registration allows the writer to mutate while the stream is still open.
test('an in-flight HTTP stream blocks repair until it finishes', async () => {
    let onRelease;
    const released = new Promise(resolve => { onRelease = resolve; });
    const guarded = { customCommand: async args => {
        const result = await reader.customCommand(args);
        if (args[9] === 'release') onRelease();
        return result;
    } };
    const app = express();
    app.use(experimentalReaderMiddleware(guarded, script, keys));
    let stream;
    app.get('/stream', (_req, res) => { stream = res; res.write('first'); });
    app.get('/new', (_req, res) => res.send('new'));
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const port = server.address().port;
    const dataKeys = ['repair-owner', 'scanner-owner', 'field-journal', 'field-data'].map(part => `${prefix}:${part}`);
    const repairKeys = [...dataKeys, ...keys.slice(0, 4)];
    const mutate = script => writer.customCommand(['EVAL', script, '8', ...repairKeys, 'stream-writer', 'scanner', ...(script === applyField ? ['owner', 'new'] : [])]);
    await writer.set(dataKeys[0], 'stream-writer');
    await writer.set(dataKeys[1], 'scanner');
    await writer.hset(dataKeys[3], { owner: 'old' });
    const open = path => new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path }, resolve).on('error', reject);
    });
    try {
        const response = await open('/stream');
        await new Promise(resolve => response.once('data', resolve));
        await writer.set(keys[4], 'stream-writer');
        assert.equal(await call(writer, 'close', 'stream-writer', 'stream-journal'), 1);
        assert.equal(await call(writer, 'drained', 'stream-writer'), 0);
        await assert.rejects(mutate(applyField), /READERS_ACTIVE/);
        assert.equal(await writer.hget(dataKeys[3], 'owner'), 'old');
        const denied = await open('/new');
        assert.equal(denied.statusCode, 503);
        denied.resume();
        stream.end('last');
        response.resume();
        await released;
        assert.equal(await call(writer, 'drained', 'stream-writer'), 1);
        assert.equal(await mutate(applyField), 1);
        assert.equal(await writer.hget(dataKeys[3], 'owner'), 'new');
        assert.equal(await mutate(undoField), 1);
        assert.equal(await writer.hget(dataKeys[3], 'owner'), 'old');
        assert.equal(await call(writer, 'open', 'stream-writer', 'stream-journal'), 1);
    } finally {
        await writer.del(dataKeys);
        stream?.destroy();
        await new Promise(resolve => server.close(resolve));
    }
});
