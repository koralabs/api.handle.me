'use strict';

// Test-only ownership boundary. Never discover/adopt an existing Redis listener.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { execFileSync } = require('node:child_process');

const REPO = fs.realpathSync(path.join(__dirname, '..'));
const IMAGE = 'valkey/valkey:8-alpine';
const SOCKET = 'unix:///var/run/docker.sock';
const LABEL = 'io.handle.api-test-valkey';
const HOST = '127.0.0.1';
const PORT = 6381;

function docker(args) {
    // Ignore contexts, remote endpoints and inherited Docker CLI configuration.
    const env = { PATH: process.env.PATH, HOME: os.tmpdir() };
    const config = fs.mkdtempSync(path.join(os.tmpdir(), 'api-test-docker-config-'));
    try {
        return execFileSync('docker', ['--host', SOCKET, '--config', config, ...args], {
            env, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe']
        }).trim();
    } catch {
        // Docker errors may echo argv, including the fixture password.
        throw new Error(`Valkey fixture Docker ${args[0]} failed (no pull or remote Docker permitted)`);
    } finally { fs.rmSync(config, { recursive: true, force: true }); }
}

function command(receipt) {
    return ['--bind', '0.0.0.0', '--port', String(PORT), '--save', '', '--appendonly', 'no',
        '--requirepass', receipt.password, '--protected-mode', 'yes'];
}

function readReceipt() {
    const file = process.env.API_TEST_VALKEY_RECEIPT;
    if (!file || !path.isAbsolute(file)) throw new Error('API_TEST_VALKEY_RECEIPT must name an owned fixture receipt');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid()) {
            throw new Error('Valkey receipt must be an owner-only mode0600 regular file');
        }
        const r = JSON.parse(fs.readFileSync(fd, 'utf8'));
        if (r.repo !== REPO || r.host !== HOST || r.port !== PORT ||
            !/^[a-f0-9]{64}$/.test(r.containerId) || !/^[a-f0-9]{48}$/.test(r.nonce) ||
            !/^[a-f0-9]{64}$/.test(r.password) || !/^sha256:[a-f0-9]{64}$/.test(r.imageId)) {
            throw new Error('Invalid Valkey fixture receipt');
        }
        return r;
    } finally { fs.closeSync(fd); }
}

function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function inspectOwned(r, running = true) {
    const [c] = JSON.parse(docker(['container', 'inspect', r.containerId]));
    const binding = [{ HostIp: HOST, HostPort: String(PORT) }];
    const pinnedImage = docker(['image', 'inspect', IMAGE, '--format', '{{.Id}}']);
    if (r.imageId !== pinnedImage || !c || c.Id !== r.containerId || c.Image !== r.imageId || c.Config.Image !== r.imageId ||
        c.Config.Labels?.[LABEL] !== r.nonce || c.Config.Labels?.[`${LABEL}.repo`] !== REPO ||
        !equal(c.Config.Entrypoint, ['valkey-server']) || !equal(c.Config.Cmd, command(r)) ||
        c.Path !== 'valkey-server' || !equal(c.Args, command(r)) ||
        !equal(c.HostConfig.PortBindings, { [`${PORT}/tcp`]: binding }) ||
        c.HostConfig.NetworkMode !== 'bridge' || c.HostConfig.Privileged ||
        !c.HostConfig.ReadonlyRootfs || c.HostConfig.RestartPolicy?.Name !== 'no' ||
        !equal(c.HostConfig.Tmpfs, { '/data': 'rw,noexec,nosuid,size=64m' }) ||
        (c.Mounts || []).some(m => m.Type !== 'tmpfs' || m.Destination !== '/data') ||
        (c.HostConfig.Binds || []).length || (running && !c.State.Running) ||
        (c.State.Running && !equal(c.NetworkSettings.Ports?.[`${PORT}/tcp`], binding))) {
        throw new Error('Valkey fixture ownership/configuration verification failed; refusing use/removal');
    }
    return r;
}

function verify() { return inspectOwned(readReceipt()); }

function assertPortFree() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', () => reject(new Error('127.0.0.1:6381 is occupied; refusing to adopt or stop its owner')));
        server.listen({ host: HOST, port: PORT, exclusive: true }, () => server.close(resolve));
    });
}

async function start() {
    if (process.env.API_TEST_VALKEY_RECEIPT) return verify();
    await assertPortFree();
    // Resolve the already-local tag once, then launch that immutable image ID.
    const imageId = docker(['image', 'inspect', IMAGE, '--format', '{{.Id}}']);
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId)) throw new Error('Pinned local Valkey image unavailable');
    const r = { repo: REPO, host: HOST, port: PORT, imageId,
        nonce: randomBytes(24).toString('hex'), password: randomBytes(32).toString('hex') };
    r.containerId = docker(['create', '--pull=never', '--network', 'bridge', '--read-only',
        '--tmpfs', '/data:rw,noexec,nosuid,size=64m', '--restart', 'no',
        '--label', `${LABEL}=${r.nonce}`, '--label', `${LABEL}.repo=${REPO}`,
        '--publish', `${HOST}:${PORT}:${PORT}`, '--entrypoint', 'valkey-server', imageId, ...command(r)]);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-test-valkey-'));
    const file = path.join(dir, 'receipt.json');
    fs.writeFileSync(file, JSON.stringify(r), { mode: 0o600, flag: 'wx' });
    process.env.API_TEST_VALKEY_RECEIPT = file;
    try {
        inspectOwned(r, false);
        docker(['start', r.containerId]);
        verify();
        // PING only inside the verified container, never against a host listener.
        let ready = false;
        for (let attempt = 0; attempt < 50; attempt++) {
            try {
                if (docker(['exec', '-e', `REDISCLI_AUTH=${r.password}`, r.containerId,
                    'valkey-cli', '-h', HOST, '-p', String(PORT), 'PING']) === 'PONG') { ready = true; break; }
            } catch {
                // The server may not yet be listening immediately after Docker starts it.
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!ready) throw new Error('Owned Valkey fixture did not become ready');
        return verify();
    } catch (error) {
        stop();
        throw error;
    }
}

function stop() {
    if (!process.env.API_TEST_VALKEY_RECEIPT) return;
    const r = readReceipt();
    inspectOwned(r, false);
    docker(['rm', '--force', r.containerId]);
    fs.unlinkSync(process.env.API_TEST_VALKEY_RECEIPT);
    fs.rmdirSync(path.dirname(process.env.API_TEST_VALKEY_RECEIPT));
    delete process.env.API_TEST_VALKEY_RECEIPT;
}

function connectionOptions(options) {
    if (!options || !Array.isArray(options.addresses) || options.addresses.length !== 1 ||
        options.addresses[0].host !== HOST || options.addresses[0].port !== PORT ||
        (options.useTLS !== undefined && options.useTLS !== false)) {
        throw new Error('Integration Valkey requires exactly 127.0.0.1:6381 with no TLS');
    }
    const r = verify();
    // Supply the fixture's authentication only when the caller did not choose credentials;
    // an explicit wrong password must still fail at the real server, not be papered over.
    // Native creation awaits before using options: never retain a caller-mutable target.
    return { ...options, addresses: [{ ...options.addresses[0], host: r.host, port: r.port }], useTLS: false,
        credentials: options.credentials ?? (process.env.API_TEST_VALKEY_REPAIR_USER && process.env.API_TEST_VALKEY_REPAIR_PASSWORD
            ? { username: process.env.API_TEST_VALKEY_REPAIR_USER, password: process.env.API_TEST_VALKEY_REPAIR_PASSWORD }
            : { username: 'default', password: r.password }) };
}

module.exports = { start, stop, verify, connectionOptions };
