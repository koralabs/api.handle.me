import './network-guard.cjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const harness = fileURLToPath(new URL('./valkey-harness.cjs', import.meta.url));

// Run explicitly after the coordinator clears 6381:
// API_TEST_MODE=integration node --test tests/valkey-harness.node-test.mjs
// Invariant: the actual native Glide client reads/writes the authenticated owned fixture.
// Catches incompatible Docker configuration/authentication; breaking password injection or publication fails the round trip.
test('real owned fixture supports native Glide round trips', {
    skip: process.env.API_TEST_MODE !== 'integration', timeout: 30000
}, async () => {
    const require = createRequire(import.meta.url);
    const h = require(harness);
    const inherited = Boolean(process.env.API_TEST_VALKEY_RECEIPT);
    let client;
    try {
        const r = await h.start();
        const { GlideClient } = require('@valkey/valkey-glide');
        client = await GlideClient.createClient(h.connectionOptions({
            addresses: [{ host: '127.0.0.1', port: 6381 }], useTLS: false,
            requestTimeout: 2000, advancedConfiguration: { connectionTimeout: 2000 }
        }));
        const key = `harness:${r.nonce}:native-round-trip`;
        assert.equal(await client.set(key, 'owned-fixture'), 'OK');
        assert.equal(await client.get(key), 'owned-fixture');
        assert.equal(await client.del([key]), 1);
        assert.equal(await client.get(key), null);
        assert.equal(h.verify().containerId, r.containerId);
        // Invariant: the fixture does not replace explicit caller credentials with a good
        // password. Restoring unconditional injection makes this real rejection disappear.
        await assert.rejects(GlideClient.createClient(h.connectionOptions({
            addresses: [{ host: '127.0.0.1', port: 6381 }], useTLS: false,
            credentials: { username: 'default', password: 'deliberately-wrong-test-password' }
        })).then(unexpected => { unexpected.close(); }), /WRONGPASS|authentication|invalid username-password/i);
    } finally {
        client?.close();
        if (!inherited) h.stop();
    }
});

// Only OS boundaries are simulated: Docker CLI and the exclusive-port bind.
// The real harness, receipt filesystem, process handoff and ownership logic run unchanged.
function fixture(t, scenario = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'valkey-harness-test-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const state = path.join(dir, 'state.json');
    const calls = path.join(dir, 'calls.jsonl');
    fs.writeFileSync(path.join(dir, 'scenario.json'), JSON.stringify(scenario));
    fs.writeFileSync(path.join(dir, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const dir = ${JSON.stringify(dir)};
const scenario = JSON.parse(fs.readFileSync(dir + '/scenario.json'));
const args = process.argv.slice(2);
if (args.shift() !== '--host' || args.shift() !== 'unix:///var/run/docker.sock') process.exit(90);
if (args.shift() !== '--config') process.exit(91);
const config = args.shift();
if ((fs.statSync(config).mode & 0o777) !== 0o700 || fs.readdirSync(config).length) process.exit(92);
fs.appendFileSync(dir + '/calls.jsonl', JSON.stringify({ args: ['--host', 'unix:///var/run/docker.sock', ...args], env: process.env }) + '\\n');
let c = fs.existsSync(dir + '/state.json') ? JSON.parse(fs.readFileSync(dir + '/state.json')) : null;
const save = () => fs.writeFileSync(dir + '/state.json', JSON.stringify(c));
const id = 'a'.repeat(64), image = 'sha256:' + 'b'.repeat(64);
if (args[0] === 'image') { if (scenario.imageMissing) process.exit(1); console.log(image); }
else if (args[0] === 'create') {
    const imageIndex = args.indexOf(image);
    const labels = {};
    args.forEach((v, i) => { if (v === '--label') { const s = args[i+1].indexOf('='); labels[args[i+1].slice(0,s)] = args[i+1].slice(s+1); } });
    c = { Id: id, Image: image, Config: { Image: image, Labels: labels, Entrypoint: ['valkey-server'], Cmd: args.slice(imageIndex+1) },
        Path: 'valkey-server', Args: args.slice(imageIndex+1),
        HostConfig: { PortBindings: { '6381/tcp': [{ HostIp: '127.0.0.1', HostPort: '6381' }] }, NetworkMode: 'bridge', Privileged: false,
            ReadonlyRootfs: true, RestartPolicy: { Name: 'no' }, Tmpfs: { '/data': 'rw,noexec,nosuid,size=64m' }, Binds: [] },
        Mounts: [{ Type: 'tmpfs', Destination: '/data' }], State: { Running: false }, NetworkSettings: { Ports: {} } };
    save(); console.log(id);
} else if (args[0] === 'container') {
    if (!c || args[2] !== c.Id) process.exit(2);
    const out = structuredClone(c);
    if (scenario.tamper && c.State.Running) {
        const [area, key, value] = scenario.tamper;
        out[area][key] = value;
    }
    console.log(JSON.stringify([out]));
} else if (args[0] === 'start') {
    if (scenario.startFail) { console.error(c.Config.Cmd.join(' ')); process.exit(3); }
    c.State.Running = true; c.NetworkSettings.Ports = c.HostConfig.PortBindings; save(); console.log(id);
} else if (args[0] === 'exec') {
    const password = c.Config.Cmd[c.Config.Cmd.indexOf('--requirepass') + 1];
    // Valkey 8's CLI consumes REDISCLI_AUTH, not VALKEYCLI_AUTH.
    const auth = args[args.indexOf('-e') + 1];
    console.log(auth === 'REDISCLI_AUTH=' + password ? 'PONG' : 'NOAUTH Authentication required.');
}
else if (args[0] === 'rm') { fs.unlinkSync(dir + '/state.json'); console.log(id); }
else process.exit(99);
`, { mode: 0o700 });
    const preload = path.join(dir, 'preload.cjs');
    fs.writeFileSync(preload, `const net = require('node:net');
const { EventEmitter } = require('node:events');
net.createServer = () => { const s = new EventEmitter();
s.listen = (opts, cb) => { if (opts.host !== '127.0.0.1' || opts.port !== 6381 || !opts.exclusive) throw Error('unsafe bind');
queueMicrotask(() => ${scenario.busy ? "s.emit('error', Error('EADDRINUSE'))" : 'cb()'}); };
s.close = cb => cb(); return s; };
`);
    const env = { ...process.env, PATH: `${dir}:${process.env.PATH}`, API_TEST_VALKEY_RECEIPT: '',
        DOCKER_HOST: 'tcp://production.invalid:2375', DOCKER_CONTEXT: 'production',
        DOCKER_CONFIG: '/must-not-read', NODE_OPTIONS: '' };
    function run(body) {
        return execFileSync(process.execPath, ['--require', preload, '-e', `
const assert = require('node:assert/strict');
const fs = require('node:fs');
const h = require(${JSON.stringify(harness)});
(async () => { ${body} })().catch(e => { console.error(e); process.exitCode = 1; });
`], { env, encoding: 'utf8', timeout: 15000 });
    }
    return { dir, state, run, calls: () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) : [] };
}

// Invariant: only a newly owned password-protected, ephemeral fixture can supply credentials.
// Catches adoption, remote Docker and loss of connection options. Removing ownership or credential injection breaks the assertions.
test('owned lifecycle creates a private receipt, supports process handoff, preserves Glide options and removes only its container', t => {
    const f = fixture(t);
    f.run(`
const r = await h.start();
const receipt = process.env.API_TEST_VALKEY_RECEIPT;
assert.equal(fs.statSync(receipt).mode & 0o777, 0o600);
assert.equal(r.host, '127.0.0.1'); assert.equal(r.port, 6381);
const opts = { addresses: [{ host: r.host, port: r.port }], useTLS: false, requestTimeout: 1234, credentials: { password: 'wrong' } };
const got = h.connectionOptions(opts);
assert.deepEqual(got, opts);
assert.equal(opts.credentials.password, 'wrong');
const withoutCredentials = { addresses: opts.addresses, useTLS: false, requestTimeout: 1234 };
assert.deepEqual(h.connectionOptions(withoutCredentials), { ...withoutCredentials, credentials: { username: 'default', password: r.password } });
// The checked destination cannot retain caller-owned references across native awaits.
const mutable = { addresses: [{ host: r.host, port: r.port }], useTLS: false };
const checked = h.connectionOptions(mutable);
mutable.addresses[0].host = 'must-never-connect.invalid';
mutable.addresses[0].port = 6379;
assert.deepEqual(checked.addresses, [{ host: r.host, port: r.port }]);
assert.equal((await h.start()).containerId, r.containerId);
require('node:child_process').execFileSync(process.execPath, ['-e',
    'require(' + JSON.stringify(${JSON.stringify(harness)}) + ').verify()'], { env: process.env });
h.stop(); h.stop();
assert.equal(fs.existsSync(receipt), false);
assert.equal(process.env.API_TEST_VALKEY_RECEIPT, undefined);
`);
    assert.equal(fs.existsSync(f.state), false);
    const calls = f.calls();
    const create = calls.find(c => c.args[2] === 'create').args;
    assert.ok(create.includes('--pull=never'));
    assert.ok(create.includes('127.0.0.1:6381:6381'));
    assert.ok(create.includes('--read-only'));
    assert.deepEqual(create.slice(-10), ['--port', '6381', '--save', '', '--appendonly', 'no', '--requirepass', create.at(-3), '--protected-mode', 'yes']);
    assert.equal(calls.filter(c => c.args[2] === 'create').length, 1);
    assert.equal(calls.filter(c => c.args[2] === 'rm').length, 1);
    for (const c of calls) {
        assert.equal(c.env.DOCKER_HOST, undefined);
        assert.equal(c.env.DOCKER_CONTEXT, undefined);
        assert.equal(c.env.DOCKER_CONFIG, undefined);
    }
});

// Invariant: occupied ports and absent local images fail closed without touching any existing container.
// Catches implicit adoption/pulls; a create/remove call in either rejected path fails this test.
for (const scenario of [{ busy: true }, { imageMissing: true }]) {
    test(`refuses unavailable fixture prerequisites ${JSON.stringify(scenario)}`, t => {
        const f = fixture(t, scenario);
        f.run('await assert.rejects(h.start(), /occupied|Docker image failed/);');
        assert.equal(fs.existsSync(f.state), false);
        assert.equal(f.calls().some(c => ['create', 'rm', 'start'].includes(c.args[2])), false);
    });
}

// Invariant: failed startup cleans up only the container whose configuration was verified.
// Catches leaked fixtures and password disclosure; omitting stop or echoing Docker stderr fails.
test('failed Docker start removes owned container and does not disclose credentials', t => {
    const f = fixture(t, { startFail: true });
    f.run(`await assert.rejects(h.start(), e => {
assert.match(e.message, /Docker start failed/);
assert.doesNotMatch(e.message, /[a-f0-9]{64}/); return true;
}); assert.equal(process.env.API_TEST_VALKEY_RECEIPT, undefined);`);
    assert.equal(fs.existsSync(f.state), false);
    assert.equal(f.calls().filter(c => c.args[2] === 'rm').length, 1);
});

// Invariant: endpoint/TLS restrictions and receipt permissions hold before any native client can connect.
// Catches localhost aliases, tunnels/default ports and insecure receipts; deleting the input/permission checks fails.
test('rejects missing receipts, aliases, other ports, TLS and unsafe receipt files', t => {
    const f = fixture(t);
    f.run(`
assert.throws(() => h.verify(), /API_TEST_VALKEY_RECEIPT/);
await h.start();
for (const opts of [undefined, {}, { addresses: [] },
{ addresses: [{ host: 'localhost', port: 6381 }] },
{ addresses: [{ host: '127.0.0.1', port: 6379 }] },
{ addresses: [{ host: '127.0.0.1', port: 6381 }], useTLS: true },
{ addresses: [{ host: '127.0.0.1', port: 6381 }, { host: 'external', port: 6381 }] }]) {
assert.throws(() => h.connectionOptions(opts), /exactly/);
}
const receipt = process.env.API_TEST_VALKEY_RECEIPT;
fs.chmodSync(receipt, 0o644); assert.throws(() => h.verify(), /mode0600/); fs.chmodSync(receipt, 0o600);
const original = fs.readFileSync(receipt, 'utf8');
for (const patch of [{ port: 6379 }, { repo: '/other/repo' }, { host: 'localhost' }, { nonce: 'bad' }]) {
fs.writeFileSync(receipt, JSON.stringify({ ...JSON.parse(original), ...patch }));
assert.throws(() => h.verify(), /Invalid/);
}
fs.writeFileSync(receipt, original);
const link = receipt + '.link'; fs.symlinkSync(receipt, link); process.env.API_TEST_VALKEY_RECEIPT = link;
assert.throws(() => h.verify(), /ELOOP/); fs.unlinkSync(link); process.env.API_TEST_VALKEY_RECEIPT = receipt;
h.stop();
`);
    assert.equal(fs.existsSync(f.state), false);
});

// Invariant: altered ownership, arguments, storage or publication is never used or automatically stopped.
// Catches trusting receipt contents alone; bypassing any corresponding inspect check fails its negative control.
for (const tamper of [
    ['Config', 'Labels', {}], ['Config', 'Cmd', ['--requirepass', 'external']],
    ['Config', 'Entrypoint', ['sh']], ['HostConfig', 'NetworkMode', 'host'],
    ['HostConfig', 'PortBindings', { '6381/tcp': [{ HostIp: '0.0.0.0', HostPort: '6381' }] }],
    ['HostConfig', 'Binds', ['/production:/data']], ['HostConfig', 'ReadonlyRootfs', false],
    ['HostConfig', 'Tmpfs', {}], ['HostConfig', 'Privileged', true],
    ['HostConfig', 'RestartPolicy', { Name: 'always' }],
    ['NetworkSettings', 'Ports', { '6381/tcp': [{ HostIp: '127.0.0.1', HostPort: '6379' }] }]
]) {
    test(`rejects changed container ${tamper[0]}.${tamper[1]} without removing it`, t => {
        const f = fixture(t, { tamper });
        f.run(`await assert.rejects(h.start(), /ownership.configuration/);
assert.throws(() => h.verify(), /ownership.configuration/);
assert.throws(() => h.stop(), /ownership.configuration/);
`);
        assert.equal(fs.existsSync(f.state), true);
        assert.equal(f.calls().some(c => c.args[2] === 'rm'), false);
    });
}
