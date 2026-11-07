'use strict';

const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const childProcess = require('node:child_process');
const { AsyncLocalStorage } = require('node:async_hooks');

const preload = `--require=${JSON.stringify(path.resolve(__filename))}`;
function sanitizeEnvironment(env) {
    for (const name of Object.keys(env)) {
        if (/^AWS_(ACCESS_KEY|SECRET|SESSION|SECURITY_TOKEN|PROFILE$|DEFAULT_PROFILE$|ROLE_|WEB_IDENTITY|CONTAINER_|CREDENTIAL_|ENDPOINT_URL)/.test(name)) delete env[name];
    }
    Object.assign(env, {
        AWS_SHARED_CREDENTIALS_FILE: '/dev/null', AWS_CONFIG_FILE: '/dev/null',
        AWS_EC2_METADATA_DISABLED: 'true', AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1',
        AWS_ENDPOINT_URL: 'http://aws-test.invalid', AWS_ENDPOINT_URL_DYNAMODB: 'http://aws-test.invalid',
        AWS_ENDPOINT_URL_S3: 'http://aws-test.invalid', AWS_ENDPOINT_URL_KMS: 'http://aws-test.invalid', AWS_MAX_ATTEMPTS: '1'
    });
    // Our preload must precede caller-supplied app preloaders in every child.
    env.NODE_OPTIONS = `${preload} ${(env.NODE_OPTIONS || '').replace(preload, '').trim()}`.trim();
    return env;
}
sanitizeEnvironment(process.env);

class TestNetworkDeniedError extends Error {
    constructor(host, port) {
        super(`Test network denied: ${host}:${port}; use an owned loopback server or the verified integration Valkey harness`);
        this.code = 'TEST_NETWORK_DENIED';
    }
}
const installed = Symbol.for('api.test.networkGuard');
if (!net[installed]) {
    const ports = new Map();
    const nativeContext = new AsyncLocalStorage();
    const check = (host, port) => {
        const normalized = String(host || 'localhost').replace(/^\[|\]$/g, '');
        if (['localhost', '127.0.0.1', '::1'].includes(normalized) && ports.has(Number(port))) return;
        if (normalized === '127.0.0.1' && Number(port) === 6381 && process.env.API_TEST_MODE === 'integration') {
            require('./valkey-harness.cjs').verify();
            return;
        }
        throw new TestNetworkDeniedError(normalized, port);
    };
    const listen = net.Server.prototype.listen;
    net.Server.prototype.listen = function (...args) {
        let registered = false;
        const register = () => {
            if (registered) return;
            const address = this.address();
            // A wildcard listener is also reachable over loopback. Outbound checks
            // still permit ONLY loopback, never this server's external interface.
            if (address && typeof address !== 'string' && ['127.0.0.1', '::1', '0.0.0.0', '::'].includes(address.address)) {
                ports.set(address.port, (ports.get(address.port) || 0) + 1);
                registered = true;
                const revoke = () => {
                    if (!registered) return;
                    registered = false;
                    const count = ports.get(address.port) - 1;
                    if (count) ports.set(address.port, count); else ports.delete(address.port);
                };
                this[installed] = revoke;
                this.once('close', revoke);
            }
        };
        this.prependOnceListener('listening', register);
        const result = listen.apply(this, args);
        // listen(0) exposes address() synchronously; supertest uses it immediately.
        register();
        return result;
    };
    const close = net.Server.prototype.close;
    net.Server.prototype.close = function (...args) { this[installed]?.(); return close.apply(this, args); };
    const connect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (...args) {
        let options = Array.isArray(args[0]) ? args[0][0] : args[0];
        if (typeof options === 'string') options = { path: options };
        else if (typeof options !== 'object') options = { port: options, host: typeof args[1] === 'string' ? args[1] : 'localhost' };
        if (options.path) {
            // Glide's JS/Rust private IPC is not a network destination. Only the exact
            // socket returned inside an already validated native-client creation is allowed.
            if (nativeContext.getStore()?.ipcPath !== options.path) throw new TestNetworkDeniedError('unix-socket', options.path);
        } else {
            check(options.host || options.hostname, options.port);
            if ((options.host || options.hostname) === 'localhost') options.host = '127.0.0.1';
        }
        return connect.apply(this, args);
    };
    const requestCheck = (args, defaultPort) => {
        const first = args[0];
        const options = typeof first === 'string' || first instanceof URL ? new URL(first) : first;
        check(options.hostname || options.host, options.port || defaultPort);
    };
    for (const [module, port] of [[http, 80], [https, 443]]) {
        for (const name of ['request', 'get']) {
            const original = module[name];
            module[name] = function (...args) { requestCheck(args, port); return original.apply(this, args); };
        }
    }
    const tlsConnect = tls.connect;
    tls.connect = function (...args) {
        const options = typeof args[0] === 'object' ? args[0] : { port: args[0], host: typeof args[1] === 'string' ? args[1] : 'localhost' };
        check(options.host || options.hostname, options.port || 443);
        return tlsConnect.apply(this, args);
    };
    // A child with an explicit env (even {}) must not regain profiles or lose the preload.
    const childOptions = options => ({ ...options, env: sanitizeEnvironment({ ...(options?.env || process.env) }) });
    for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) {
        const original = childProcess[name];
        childProcess[name] = function (file, args, options, ...rest) {
            if (typeof args === 'function') return original.call(this, file, childOptions(), args);
            if (!Array.isArray(args)) return original.call(this, file, childOptions(args), options, ...rest);
            if (typeof options === 'function') return original.call(this, file, args, childOptions(), options);
            return original.call(this, file, args, childOptions(options), ...rest);
        };
    }
    for (const name of ['exec', 'execSync']) {
        const original = childProcess[name];
        childProcess[name] = function (command, options, ...rest) {
            if (typeof options === 'function') return original.call(this, command, childOptions(), options, ...rest);
            return original.call(this, command, childOptions(options), ...rest);
        };
    }
    const workerThreads = require('node:worker_threads');
    const OriginalWorker = workerThreads.Worker;
    workerThreads.Worker = class GuardedTestWorker extends OriginalWorker {
        constructor(filename, options = {}) {
            const env = options.env === workerThreads.SHARE_ENV ? options.env : sanitizeEnvironment({ ...(options.env || process.env) });
            super(filename, { ...options, env,
                execArgv: ['--require', path.resolve(__filename), ...(options.execArgv || process.execArgv)] });
        }
    };
    net[installed] = { check, nativeContext };
    require('node:module').syncBuiltinESMExports();
}

// Every Jest realm has its own fetch and package cache, but shared built-in transports.
if (globalThis.fetch && !globalThis.fetch[installed]) {
    const original = globalThis.fetch;
    globalThis.fetch = function (input, init) {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
        try { net[installed].check(url.hostname, url.port || (url.protocol === 'https:' ? 443 : 80)); }
        catch (error) { return Promise.reject(error); }
        return original(input, init);
    };
    globalThis.fetch[installed] = true;
}
// Config files and app entrypoints may load dotenv after the preloader.
const dotenv = require('dotenv');
if (!dotenv[installed]) {
    for (const name of ['config', 'configDotenv']) {
        const original = dotenv[name];
        if (original) dotenv[name] = function (...args) {
            const result = original.apply(this, args);
            sanitizeEnvironment(process.env);
            if (result?.parsed) for (const key of Object.keys(result.parsed)) if (/^AWS_/.test(key)) delete result.parsed[key];
            return result;
        };
    }
    dotenv[installed] = true;
}

// Rust Glide networking does not pass through Node's socket hooks. Validate BEFORE
// native creation and authenticate only to the fixture the test harness started.
const { BaseClient } = require('@valkey/valkey-glide');
if (!BaseClient[installed]) {
    const optionsForFixture = options => {
        if (process.env.API_TEST_MODE !== 'integration') throw new TestNetworkDeniedError('native-valkey', 'unit-test');
        return require('./valkey-harness.cjs').connectionOptions(options);
    };
    const create = BaseClient.createClientInternal;
    BaseClient.createClientInternal = function (options, constructor) {
        const verified = optionsForFixture(options);
        return net[installed].nativeContext.run({ verified: true }, () => create.call(this, verified, constructor));
    };
    const fromSocket = BaseClient.__createClientInternal;
    BaseClient.__createClientInternal = function (options, socket, constructor) {
        return fromSocket.call(this, optionsForFixture(options), socket, constructor);
    };
    const getSocket = BaseClient.GetSocket;
    BaseClient.GetSocket = function (socketPath) {
        if (!net[installed].nativeContext.getStore()?.verified) throw new TestNetworkDeniedError('native-ipc', socketPath);
        return net[installed].nativeContext.run({ verified: true, ipcPath: socketPath }, () => getSocket.call(this, socketPath));
    };
    BaseClient[installed] = true;
}
module.exports = { sanitizeEnvironment, TestNetworkDeniedError };
