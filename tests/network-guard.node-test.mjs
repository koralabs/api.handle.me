import './network-guard.cjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { mkdtempSync, writeFileSync, rmSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import { GlideClient } from '@valkey/valkey-glide';

// These assertions execute during entrypoint evaluation, before any application import.
assert.equal(process.env.AWS_SHARED_CREDENTIALS_FILE, '/dev/null');
assert.equal(process.env.AWS_CONFIG_FILE, '/dev/null');
assert.equal(process.env.AWS_ACCESS_KEY_ID, undefined);
assert.equal(process.env.AWS_SECRET_ACCESS_KEY, undefined);
assert.equal(process.env.AWS_PROFILE, undefined);
assert.equal(process.env.AWS_EC2_METADATA_DISABLED, 'true');
assert.equal(process.env.AWS_ENDPOINT_URL, 'http://aws-test.invalid');
const denied = error => error.code === 'TEST_NETWORK_DENIED';

// Invariant: unfaked AWS clients cannot use workstation profiles or issue a request.
// Removing credential isolation resolves the real default profile; removing transport
// denial lets the explicit fixture-credential client attempt its real AWS hostname.
test('unfaked AWS clients fail without credential discovery or network', async () => {
    const defaults = new S3Client({ maxAttempts: 1 });
    try { await assert.rejects(defaults.send(new ListBucketsCommand({})), /Could not load credentials/); }
    finally { defaults.destroy(); }
    const explicit = new S3Client({ region: 'us-east-1', endpoint: 'https://s3.us-east-1.amazonaws.com',
        credentials: { accessKeyId: 'unit-test-only', secretAccessKey: 'unit-test-only' }, maxAttempts: 1 });
    try { await assert.rejects(explicit.send(new ListBucketsCommand({})), /Test network denied/); }
    finally { explicit.destroy(); }
});

// Invariant: every Node transport denies outside/unowned destinations before connect.
// Removing any individual hook changes that path's exact denial into a connection attempt.
test('denies HTTP HTTPS fetch TCP TLS and unowned loopback/Unix sockets', async () => {
    assert.throws(() => http.get('http://169.254.169.254/latest/meta-data/'), denied);
    assert.throws(() => https.request('https://dynamodb.us-east-1.amazonaws.com/'), denied);
    assert.throws(() => net.connect({ host: '127.0.0.1', port: 9 }), denied);
    assert.throws(() => tls.connect({ host: '127.0.0.1', port: 9 }), denied);
    assert.throws(() => net.connect('/tmp/not-an-owned-test-socket'), denied);
    await assert.rejects(fetch('https://s3.us-east-1.amazonaws.com/'), denied);
});

// Invariant: Rust networking cannot bypass strict unit isolation via native Glide.
// Removing the native factory check reaches the native driver rather than this denial.
test('unfaked native client refuses both production and unowned local targets', async () => {
    for (const address of [{ host: 'redis.production.invalid', port: 6379 }, { host: '127.0.0.1', port: 6380 }, { host: '127.0.0.1', port: 6381 }]) {
        await assert.rejects(GlideClient.createClient({ addresses: [address], useTLS: false }), /Test network denied/);
    }
});

// Invariant: child entrypoints remain guarded even when callers replace the entire env.
// Removing forced preload/env injection exposes default profile files or permits HTTP.
test('Node children inherit isolation with an explicit empty environment', () => {
    const output = execFileSync(process.execPath, ['-e', `
const assert = require('node:assert/strict');
assert.equal(process.env.AWS_SHARED_CREDENTIALS_FILE, '/dev/null');
assert.equal(process.env.AWS_ACCESS_KEY_ID, undefined);
assert.equal(process.env.AWS_ENDPOINT_URL, 'http://aws-test.invalid');
assert.throws(() => require('node:https').get('https://s3.amazonaws.com'), e => e.code === 'TEST_NETWORK_DENIED');
console.log('child-isolated');
`], { encoding: 'utf8', env: {} });
    assert.equal(output.trim(), 'child-isolated');
});

// Invariant: caller-supplied child preloaders cannot import an app before the guard.
// Appending our preload instead of prepending fails the fixture before it opens any socket.
test('installs before caller-supplied child preloaders', () => {
    const dir = mkdtempSync(join(tmpdir(), 'api-guard-preload-'));
    const fixture = join(dir, 'app-preload.cjs');
    writeFileSync(fixture, `require('node:assert/strict').ok(require('node:net')[Symbol.for('api.test.networkGuard')], 'guard must precede app import');`);
    try {
        const output = execFileSync(process.execPath, ['-e', "console.log('preload-ordered')"], {
            encoding: 'utf8', env: { NODE_OPTIONS: `--require=${JSON.stringify(fixture)}` }
        });
        assert.equal(output.trim(), 'preload-ordered');
    } finally { rmSync(fixture); rmdirSync(dir); }
});

// Invariant: a worker cannot drop isolation through explicit env/execArgv replacements.
// Removing Worker propagation exposes profile paths and permits the attempted request.
test('worker threads inherit isolation before evaluating their entrypoint', async () => {
    const worker = new Worker(`
const assert = require('node:assert/strict');
const { parentPort } = require('node:worker_threads');
assert.equal(process.env.AWS_SHARED_CREDENTIALS_FILE, '/dev/null');
assert.equal(process.env.AWS_ACCESS_KEY_ID, undefined);
assert.throws(() => require('node:https').get('https://s3.amazonaws.com'), e => e.code === 'TEST_NETWORK_DENIED');
parentPort.postMessage('worker-isolated');
`, { eval: true, env: { AWS_ACCESS_KEY_ID: 'must-be-cleared' }, execArgv: [] });
    try {
        const message = await new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); });
        assert.equal(message, 'worker-isolated');
    } finally { await worker.terminate(); }
});

// Invariant: the guard preserves Node's synchronous listen(0)/supertest contract.
// Forcing an explicit host makes address() null here and breaks the original app tests.
test('registers an implicit listener synchronously without allowing external destinations', async () => {
    const server = http.createServer((_req, res) => res.end('implicit-owned'));
    server.listen(0);
    const address = server.address();
    assert.equal(typeof address.port, 'number');
    try {
        assert.equal(await (await fetch(`http://127.0.0.1:${address.port}/`)).text(), 'implicit-owned');
        assert.throws(() => http.get('http://s3.amazonaws.com'), denied);
    } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

// Invariant: a real same-process loopback server works, but authority ends on close.
// Removing registration breaks the happy path; broad localhost allowances fail revocation.
test('allows only an owned loopback listener until it closes', async () => {
    const server = http.createServer((_request, response) => response.end('owned-test-server'));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port, address } = server.address();
    assert.equal(address, '127.0.0.1');
    const url = `http://127.0.0.1:${port}/`;
    try { assert.equal(await (await fetch(url)).text(), 'owned-test-server'); }
    finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await assert.rejects(fetch(url), denied);
});
