import { Logger, REDIS_HOST } from '@koralabs/kora-labs-common';
import { Batch, GlideClient } from '@valkey/valkey-glide';
import { parentPort } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

let glideClient;
let snapshotClient;
const snapshotTTL = 60_000;
const hashImage = raw => Object.fromEntries((Array.isArray(raw) ? raw : Object.entries(raw ?? {}).map(([field, value]) => ({ field, value })))
    .map(entry => [String(entry.field ?? entry.key), String(entry.value)]).sort(([a], [b]) => a.localeCompare(b)));
const sameHash = (raw, expected) => JSON.stringify(hashImage(raw)) === JSON.stringify(hashImage(expected));

// This client is private to snapshot transactions: unrelated worker requests must not
// share WATCH state. The synchronous store sends only one snapshot request at a time.
async function getSnapshotClient() {
    if (!snapshotClient) snapshotClient = await GlideClient.createClient({
        addresses: [{ host: REDIS_HOST, port: getRedisPort() }],
        useTLS: process.env.REDIS_USE_TLS ? process.env.REDIS_USE_TLS === 'true' : true,
        requestTimeout: 20_000
    });
    return snapshotClient;
}

export async function claimSnapshot(client, args, writerGuard) {
    const { fence, scannerOriginal = fence.scannerOwner, metricsKey, progressKey, originalMetrics, originalProgress, requireEmpty, pattern, dataRoots } = args;
    const guard = writerGuard && fence.key !== writerGuard[4] ? writerGuard.slice(0, 2) : [];
    await client.watch([fence.key, fence.scannerKey, metricsKey, progressKey, ...guard]);
    try {
        if (guard.length && ((await client.get(guard[0])) !== null || (await client.get(guard[1])) !== null)) return false;
        if (await client.get(fence.key) !== null || (await client.get(fence.scannerKey) ?? null) !== scannerOriginal ||
            !sameHash(await client.hgetall(metricsKey), originalMetrics) || !sameHash(await client.hgetall(progressKey), originalProgress)) return false;
        if (requireEmpty) {
            let cursor = '0';
            do {
                const result = await client.scan(cursor, { match: pattern, count: 1000 });
                cursor = String(result[0]);
                if (result[1].some(key => dataRoots.some(root => String(key) === root || String(key).startsWith(`${root}:`)))) return false;
            } while (cursor !== '0');
        }
        const batch = new Batch(true);
        batch.set(fence.key, fence.owner, { conditionalSet: 'onlyIfDoesNotExist', expiry: { type: 'PX', count: snapshotTTL } });
        if (fence.ownsScannerLease) batch.set(fence.scannerKey, fence.scannerOwner, { conditionalSet: 'onlyIfDoesNotExist', expiry: { type: 'PX', count: snapshotTTL } });
        const result = await client.exec(batch, true);
        return result !== null && result[0] === 'OK';
    } finally {
        await client.unwatch();
    }
}

const undoWrites = new Set(['set', 'del', 'hset', 'hdel', 'sadd', 'srem', 'zadd', 'zrem', 'zremRangeByRank', 'zremRangeByScore']);
let undoBefore, undoAfter;
const undoKeys = (cmd, args) => {
    const commands = cmd === 'batch' ? args[0] : [[cmd, args]];
    const keys = new Set();
    for (const [method, values] of commands) {
        if (repositoryReads.has(method)) continue;
        if (!undoWrites.has(method)) throw new Error(`Unsupported experimental undo command: ${method}`);
        const targets = method === 'del' ? values[0] : [values[0]];
        if (!Array.isArray(targets) || targets.some(key => typeof key !== 'string' || !key)) throw new Error('Invalid experimental undo key');
        for (const key of targets) keys.add(key);
    }
    return [...keys];
};

export async function fencedSnapshotCall(client, fence, cmd, args, writerGuard) {
    const guard = writerGuard && fence.key !== writerGuard[4] ? writerGuard.slice(0, 2) : [];
    const images = fence.undoLog ? undoKeys(cmd, args) : [];
    if (images.includes(fence.undoLog)) throw new Error('Experimental undo journal overlaps data');
    await client.watch([fence.key, fence.scannerKey, ...guard, ...images]);
    try {
        if (guard.length && ((await client.get(guard[0])) !== null || (await client.get(guard[1])) !== null)) throw new Error('Repair writer gate closed');
        if (await client.get(fence.key) !== fence.owner || (await client.get(fence.scannerKey) ?? null) !== fence.scannerOwner) {
            throw new Error('Snapshot ownership fence lost');
        }
        if (images.length) {
            for (const key of images) if (Number(await client.customCommand(['PTTL', key])) >= 0) throw new Error('Experimental undo refuses expiring data');
            undoBefore ??= readFileSync(new URL('../stores/redis/experimentalUndoBefore.lua', import.meta.url), 'utf8');
            undoAfter ??= readFileSync(new URL('../stores/redis/experimentalUndoAfter.lua', import.meta.url), 'utf8');
        }
        const batch = new Batch(true);
        batch.pexpire(fence.key, snapshotTTL);
        batch.pexpire(fence.scannerKey, snapshotTTL);
        const undoId = images.length ? randomUUID() : '';
        if (images.length) batch.customCommand(['EVAL', undoBefore, String(images.length + 1), fence.undoLog, ...images, undoId]);
        if (cmd === 'batch') {
            for (const [method, values] of args[0]) batch[method](...values);
        } else batch[cmd](...args);
        if (images.length) batch.customCommand(['EVAL', undoAfter, String(images.length + 1), fence.undoLog, ...images, undoId]);
        const result = await client.exec(batch, true);
        if (result === null) throw new Error('Snapshot ownership fence changed');
        const offset = images.length ? 3 : 2;
        return cmd === 'batch' ? result.slice(offset, images.length ? -1 : undefined) : result[offset];
    } finally {
        await client.unwatch();
    }
} 
export const getRedisPort = () => {
    const parsedPort = Number(process.env.REDIS_PORT);
    if (Number.isInteger(parsedPort) && parsedPort > 0) return parsedPort;
    return 6379;
};

async function getClient() {
    if (!glideClient) {
        //Logger.local('REDIS_HOST_WORKER', process.env.REDIS_HOST_US_EAST_1, process.env.AWS_REGION, `REDIS_HOST_${process.env.AWS_REGION}`.toUpperCase().replace(/-/g, '_'))
        glideClient = await GlideClient.createClient({
            addresses: [{ host: REDIS_HOST, port: getRedisPort() }],
            useTLS: process.env.REDIS_USE_TLS ? process.env.REDIS_USE_TLS == 'true' : true,
            requestTimeout: 20_000,
            advancedConfiguration: {
                connectionTimeout: 10_000
            }
        });
        const status = await glideClient.ping();
        if (status == 'PONG') {
            Logger.local('Connected to Valkey');
        }
    }
    return glideClient;
}

// Isolated experiment only: this coordinates opted-in store clients, not
// independent Valkey clients or administrative writers.
let readerGateScript;
const leaseScripts = new Set([
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end",
    "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end"
]);
const allowedRepairControl = (cmd, args, keys) => {
    if (cmd !== 'customCommand' || !Array.isArray(args[0])) return false;
    const [op, script, count, ...rest] = args[0];
    if (op !== 'EVAL') return false;
    readerGateScript ??= readFileSync(new URL('../stores/redis/localRepairReaderGate.lua', import.meta.url), 'utf8');
    if (script === readerGateScript && count === '5' && [keys[0], keys[3], keys[1], keys[4], keys[2]].every((key, i) => rest[i] === key)) return true;
    return count === '1' && rest[0] === keys[2] && leaseScripts.has(script);
};
const repositoryReads = new Set(['get', 'hget', 'hgetall', 'scan', 'scard', 'smembers', 'sort', 'zmscore', 'zrange', 'zrangeWithScores', 'close']);
export async function guardedRepositoryWrite(client, keys, cmd, args) {
    await client.watch(keys.slice(0, 2));
    try {
        if ((await client.get(keys[0])) !== null || (await client.get(keys[1])) !== null) throw new Error('Repair writer gate closed');
        const batch = new Batch(true);
        if (cmd === 'batch') {
            for (const [method, values] of args[0]) batch[method](...values);
        } else batch[cmd](...args);
        const result = await client.exec(batch, true);
        if (result === null) throw new Error('Repair writer gate changed');
        return cmd === 'batch' ? result : result[0];
    } finally {
        await client.unwatch();
    }
}

if (parentPort) {
    parentPort.on('message', async (m) => {
        const { id, sab, payload, reply } = m;
        const view = new Int32Array(sab);
        try {
            //logKeyRequest('handle:', payload); // What is getting passed in?
            const client = await getClient();
            if (payload.cmd === 'snapshotClaim') {
                const result = await claimSnapshot(await getSnapshotClient(), payload.args[0], payload.writerGuard);
                reply.postMessage({ id, ok: true, result });
                return;
            }
            if (payload.cmd === 'snapshotRelease') {
                const fence = payload.args[0];
                const result = await client.customCommand(['EVAL', "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end", '1', fence.key, fence.owner]);
                if (fence.ownsScannerLease) await client.customCommand(['EVAL', "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end", '1', fence.scannerKey, fence.scannerOwner]);
                reply.postMessage({ id, ok: true, result });
                return;
            }
            if (payload.fence) {
                const result = await fencedSnapshotCall(await getSnapshotClient(), payload.fence, payload.cmd, payload.args, payload.writerGuard);
                reply.postMessage({ id, ok: true, result });
                return;
            }
            const guardedMutation = (cmd, args) => {
                if (repositoryReads.has(cmd)) return false;
                if (cmd === 'set' && args[0] === payload.writerGuard[2] && args[2]?.conditionalSet === 'onlyIfDoesNotExist' && args[2]?.expiry?.type === 'PX' && args[2]?.expiry?.count > 0) return false;
                if (cmd === 'customCommand') return !allowedRepairControl(cmd, args, payload.writerGuard);
                return true;
            };
            if (payload.writerGuard && (guardedMutation(payload.cmd, payload.args) ||
                (payload.cmd === 'batch' && payload.args[0].some(([cmd, args]) => guardedMutation(cmd, args))))) {
                const result = await guardedRepositoryWrite(await getSnapshotClient(), payload.writerGuard, payload.cmd, payload.args);
                reply.postMessage({ id, ok: true, result });
                return;
            }
            switch (payload.cmd) {
                case 'close': {
                    await client.close();
                    glideClient = undefined;
                    const result = 'closed';
                    await reply.postMessage({ id, ok: true, result });
                    break;
                }
                case 'batch': {
                    //Logger.local('BATCH');
                    const pipeline = new Batch(true);
                    for (const [cmd, args] of payload.args[0]) {
                        //Logger.local(cmd, args);
                        pipeline[cmd](...args);
                    }
                    const result = await client.exec(pipeline, true, { timeout: 20_000 });
                    reply.postMessage({ id, ok: true, result });
                    break;
                }
                default: {
                    //Logger.local('VALKEY', payload.cmd, payload.args);
                    const result = await client[payload.cmd](...payload.args);
                    reply.postMessage({ id, ok: true, result });
                    break;
                }
            }
            //logKeyResult('handle:', payload, result) // What is the result from Valkey?
        } catch (e) {
            if (e?.constructor?.name === 'ClosingError' || e?.message?.includes('Connection error')) {
                glideClient = undefined;
            }
            const message = `ERROR WITH PAYLOAD: ${JSON.stringify(payload)} | ERROR: ${JSON.stringify(e)} | STACK: ${e?.stack}`;
            reply.postMessage({ id, ok: false, error: { message, stack: e?.stack } });
        } finally {
            reply.close();
            Atomics.store(view, 0, 1);
            Atomics.notify(view, 0, 1);
        }
    });
}

function logKeyRequest(key, payload) {
    if (payload.args && payload.args.length > 0 && typeof payload.args[0] == 'string' && payload.args[0].startsWith(key)) {
        Logger.local({ message: `Valkey request for ${payload.args[0]}: ${JSON.stringify(payload)}` });
    }
}

function logKeyResult(key, payload, result) {
    if (payload.args && payload.args.length > 0 && typeof payload.args[0] == 'string' && payload.args[0].startsWith(key)) {
        Logger.local({ message: `Valkey result for ${payload.args[0]}: ${JSON.stringify(result)}` });
    }
}
