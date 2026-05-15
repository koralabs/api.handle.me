// Ad hoc operational lambda.
// This file is freeform by design; anything in here is expendable and may be replaced
// or deleted when the operational need changes. Add new actions inline as needed.
import { Trie } from '@aiken-lang/merkle-patricia-forestry';
import Redis from 'ioredis';

const LEGACY_GLOBAL_KEYS = ['metrics', 'scanner:lease', 'scanner:recovery'];
const SERVER_COPY_BATCH_SIZE = 200;
const SCANNER_LEASE_TTL_MS = 60_000;
const HANDLE_HMGET_BATCH = 500;
const SERVER_COPY_LUA = `
local copied = 0
local missing = 0
local by_type = {}
for i = 1, #ARGV, 2 do
  local source = ARGV[i]
  local target = ARGV[i + 1]
  local key_type = redis.call('TYPE', source)['ok']
  if key_type == 'none' then
    missing = missing + 1
  else
    redis.call('COPY', source, target, 'REPLACE')
    copied = copied + 1
    by_type[key_type] = (by_type[key_type] or 0) + 1
  end
end
local result = { tostring(copied), tostring(missing) }
for key_type, count in pairs(by_type) do
  table.insert(result, key_type)
  table.insert(result, tostring(count))
end
return result
`;
const SERVER_RENAME_LUA = `
local renamed = 0
local missing = 0
local by_type = {}
for i = 1, #ARGV, 2 do
  local source = ARGV[i]
  local target = ARGV[i + 1]
  local key_type = redis.call('TYPE', source)['ok']
  if key_type == 'none' then
    missing = missing + 1
  else
    if redis.call('EXISTS', target) == 1 then
      redis.call('DEL', target)
    end
    redis.call('RENAME', source, target)
    renamed = renamed + 1
    by_type[key_type] = (by_type[key_type] or 0) + 1
  end
end
local result = { tostring(renamed), tostring(missing) }
for key_type, count in pairs(by_type) do
  table.insert(result, key_type)
  table.insert(result, tostring(count))
end
return result
`;
const SERVER_DELETE_LUA = `
local deleted = 0
local missing = 0
local by_type = {}
for i = 1, #ARGV do
  local key = ARGV[i]
  local key_type = redis.call('TYPE', key)['ok']
  if key_type == 'none' then
    missing = missing + 1
  else
    redis.call('DEL', key)
    deleted = deleted + 1
    by_type[key_type] = (by_type[key_type] or 0) + 1
  end
end
local result = { tostring(deleted), tostring(missing) }
for key_type, count in pairs(by_type) do
  table.insert(result, key_type)
  table.insert(result, tostring(count))
end
return result
`;

// Atomic compare-and-DEL via Lua. Mirrors scanner.app.ts so we never DEL a lease
// owned by an active scanner — only the holder of the lease string can release it.
const LEASE_RELEASE_LUA = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

const GHOST_HANDLES: Record<string, string[]> = {
    mainnet: ['watchman@ngmerchs'],
    preview: ['dynamo2@ai']
};

const EMPTY_MPT_ROOT_HASH = Buffer.alloc(32).toString('hex');

type Action =
    | 'copy_namespace'
    | 'rename_namespace'
    | 'delete_namespace'
    | 'set_checkpoint'
    | 'seed_mpt_root'
    | 'add_mint_data'
    | 'scripts_with_cbor'
    | 'update_script_types'
    | 'hgetall'
    | 'get'
    | 'del'
    | 'hdel'
    | 'scard'
    | 'sdiff_count'
    | 'smembers_diff'
    | 'reset_scanner';

type ValkeyEvent = {
    action?: Action;
    sourceHost?: string;
    sourcePort?: number | string;
    sourcePassword?: string;
    sourceTls?: boolean | string;
    sourceDb?: number | string;
    targetHost?: string;
    targetPort?: number | string;
    targetPassword?: string;
    targetTls?: boolean | string;
    targetDb?: number | string;
    network?: string;
    sourcePrefix?: string;
    scanCount?: number | string;
    includeTargetKeys?: boolean | string;
    sourceMode?: 'legacy_only' | 'namespaced_only' | 'all';
    handleName?: string;
    createdSlot?: number | string;
    txHash?: string;
    dryRun?: boolean | string;
    checkpointBlockHash?: string;
    checkpointSlot?: number | string;
    // Generic key/value debug actions (hgetall/get/del/hdel/scard).
    key?: string;
    keyA?: string;
    keyB?: string;
    expected?: string[];
    field?: string | string[];
    // update_script_types payload: { name, type } pairs.
    updates?: Array<{ name: string; type: string }>;
};

type RedisConfig = {
    host: string;
    port: number;
    password?: string;
    db: number;
    tls: boolean;
};

const jsonReplacer = (_: string, value: any) => (typeof value === 'bigint' ? value.toString() : value);

// Networks recognized by the api stack. The Lambda refuses to operate
// without an explicit `network` on the event payload — see requireNetwork
// below — so any silent default would be a footgun: e.g. an empty/probe
// payload would mutate the wrong network's keys. (This bit us once in
// production: an empty {} invocation defaulted to mainnet and cleared
// currentSlot/lockLambdas. Don't restore the default.)
const ALLOWED_NETWORKS = ['mainnet', 'preprod', 'preview'] as const;
type AllowedNetwork = typeof ALLOWED_NETWORKS[number];

const requireNetwork = (event: { network?: string }): AllowedNetwork => {
    const raw = `${event.network ?? ''}`.trim().toLowerCase();
    if (!raw) {
        throw new Error(`network is required (one of ${ALLOWED_NETWORKS.join(', ')}) — pass {"network":"<name>"} on the event payload`);
    }
    if (!(ALLOWED_NETWORKS as readonly string[]).includes(raw)) {
        throw new Error(`network=${JSON.stringify(raw)} is not allowed; expected one of ${ALLOWED_NETWORKS.join(', ')}`);
    }
    return raw as AllowedNetwork;
};

const getApiCacheTag = (network: string) => `{api:${network}}`;

const getApiMetricsKey = (network: string) => `${getApiCacheTag(network)}:metrics`;

const getScannerLeaseKey = (network: string) => `${getApiCacheTag(network)}:scanner:lease`;

const getHandleIndexRootKey = (network: string) => `${getApiCacheTag(network)}:handle`;

const getHandleIndexKey = (network: string, handleName: string) => `${getApiCacheTag(network)}:handle:${handleName}`;

const toInt = (value: number | string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const toBoolean = (value: boolean | string | undefined, fallback: boolean) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') return value.toLowerCase() === 'true';
    return fallback;
};

const normalizeSourceMode = (
    value: ValkeyEvent['sourceMode'] | undefined,
    includeTargetKeys: boolean
): 'legacy_only' | 'namespaced_only' | 'all' => {
    if (value == 'legacy_only' || value == 'namespaced_only' || value == 'all') return value;
    return includeTargetKeys ? 'all' : 'legacy_only';
};

const getRedisHost = () => {
    const region = process.env.AWS_REGION?.toUpperCase().replace(/-/g, '_');
    if (region) {
        const regionHost = process.env[`REDIS_HOST_${region}`];
        if (regionHost) return regionHost;
    }
    return process.env.REDIS_HOST || '127.0.0.1';
};

const getRedisConfig = (event: ValkeyEvent, prefix: 'source' | 'target'): RedisConfig => {
    const host = event[`${prefix}Host`] || (prefix == 'source' ? getRedisHost() : event.sourceHost) || getRedisHost();
    return {
        host,
        port: toInt(event[`${prefix}Port`], toInt(process.env.REDIS_PORT, 6379)),
        password: event[`${prefix}Password`],
        db: toInt(event[`${prefix}Db`], 0),
        tls: toBoolean(event[`${prefix}Tls`], process.env.REDIS_USE_TLS ? process.env.REDIS_USE_TLS == 'true' : true)
    };
};

const createClient = ({ host, port, password, db, tls }: RedisConfig) =>
    new Redis({
        host,
        port,
        password,
        db,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        tls: tls ? {} : undefined
    });

const isSameRedisTarget = (source: RedisConfig, target: RedisConfig) =>
    source.host == target.host &&
    source.port == target.port &&
    source.db == target.db &&
    source.password == target.password &&
    source.tls == target.tls;

const collectMatchingKeys = async (client: Redis, pattern: string, scanCount: number) => {
    const keys = new Set<string>();
    let cursor = '0';
    do {
        const [nextCursor, batch] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', `${scanCount}`);
        cursor = nextCursor;
        for (const key of batch) keys.add(key);
    } while (cursor !== '0');
    return keys;
};

const collectSourceKeys = async (
    client: Redis,
    network: string,
    sourcePrefix: string,
    scanCount: number,
    sourceMode: 'legacy_only' | 'namespaced_only' | 'all'
) => {
    const targetTag = getApiCacheTag(network);
    const keys = new Set<string>();

    if (sourceMode != 'namespaced_only') {
        for (const key of await collectMatchingKeys(client, `${sourcePrefix}:*`, scanCount)) keys.add(key);
    }
    if (sourceMode != 'legacy_only') {
        for (const key of await collectMatchingKeys(client, `${targetTag}:*`, scanCount)) keys.add(key);
    }

    for (const key of LEGACY_GLOBAL_KEYS) {
        if (await client.exists(key)) keys.add(key);
    }

    return [...keys].sort();
};

const mapTargetKey = (sourceKey: string, network: string, sourcePrefix: string) => {
    const targetTag = getApiCacheTag(network);
    if (sourceKey.startsWith(`${targetTag}:`)) return sourceKey;
    if (LEGACY_GLOBAL_KEYS.includes(sourceKey)) return `${targetTag}:${sourceKey}`;
    const legacyPrefix = `${sourcePrefix}:`;
    if (sourceKey.startsWith(legacyPrefix)) return `${targetTag}:${sourceKey.slice(legacyPrefix.length)}`;
    return undefined;
};

const copyKey = async (source: Redis, target: Redis, sourceKey: string, targetKey: string, dryRun: boolean, useServerCopy: boolean) => {
    const type = await source.type(sourceKey);
    if (type === 'none') return { status: 'missing', type };
    if (dryRun) return { status: 'dry-run', type };

    if (useServerCopy) {
        await target.call('COPY', sourceKey, targetKey, 'REPLACE');
        return { status: 'copied', type };
    }

    const payload = await source.callBuffer('DUMP', sourceKey) as Buffer;
    const ttl = await source.pttl(sourceKey);
    await target.restore(targetKey, ttl > 0 ? ttl : 0, payload, 'REPLACE');
    return { status: 'copied', type };
};

const copyKeysServerSide = async (target: Redis, pairs: Array<{ sourceKey: string; targetKey: string }>) => {
    const result = await target.eval(SERVER_COPY_LUA, 0, ...pairs.flatMap(({ sourceKey, targetKey }) => [sourceKey, targetKey])) as string[];
    const summary = {
        copied: Number(result[0] || 0),
        missing: Number(result[1] || 0),
        byType: {} as Record<string, number>
    };

    for (let index = 2; index < result.length; index += 2) {
        summary.byType[result[index]] = Number(result[index + 1] || 0);
    }

    return summary;
};

const renameKeysServerSide = async (target: Redis, pairs: Array<{ sourceKey: string; targetKey: string }>) => {
    const result = await target.eval(SERVER_RENAME_LUA, 0, ...pairs.flatMap(({ sourceKey, targetKey }) => [sourceKey, targetKey])) as string[];
    const summary = {
        renamed: Number(result[0] || 0),
        missing: Number(result[1] || 0),
        byType: {} as Record<string, number>
    };

    for (let index = 2; index < result.length; index += 2) {
        summary.byType[result[index]] = Number(result[index + 1] || 0);
    }

    return summary;
};

const deleteKeysServerSide = async (target: Redis, keys: string[]) => {
    const result = await target.eval(SERVER_DELETE_LUA, 0, ...keys) as string[];
    const summary = {
        deleted: Number(result[0] || 0),
        missing: Number(result[1] || 0),
        byType: {} as Record<string, number>
    };

    for (let index = 2; index < result.length; index += 2) {
        summary.byType[result[index]] = Number(result[index + 1] || 0);
    }

    return summary;
};

const buildNamespacePairs = async (
    source: Redis,
    network: string,
    sourcePrefix: string,
    scanCount: number,
    sourceMode: 'legacy_only' | 'namespaced_only' | 'all'
) => {
    const sourceKeys = await collectSourceKeys(source, network, sourcePrefix, scanCount, sourceMode);
    const sample: Array<{ sourceKey: string; targetKey: string }> = [];
    const pairs: Array<{ sourceKey: string; targetKey: string }> = [];
    let skipped = 0;

    for (const sourceKey of sourceKeys) {
        const targetKey = mapTargetKey(sourceKey, network, sourcePrefix);
        if (!targetKey) {
            skipped += 1;
            continue;
        }

        if (sample.length < 10) sample.push({ sourceKey, targetKey });
        pairs.push({ sourceKey, targetKey });
    }

    return { sourceKeys, pairs, sample, skipped };
};

const inspectMetrics = async (event: ValkeyEvent) => {
    const network = requireNetwork(event);
    const metricsKey = getApiMetricsKey(network);
    const client = createClient(getRedisConfig(event, 'source'));
    await client.connect();
    try {
        const result = await client.hgetall(metricsKey);
        return { command: 'hgetall', network, args: [metricsKey], result };
    } finally {
        client.disconnect();
    }
};

const setCheckpoint = async (event: ValkeyEvent) => {
    const network = requireNetwork(event);

    const checkpointBlockHash = `${event.checkpointBlockHash || ''}`.trim();
    const checkpointSlot = toInt(event.checkpointSlot, 0);
    if (!checkpointBlockHash) throw new Error('checkpointBlockHash is required for action=set_checkpoint');
    if (!checkpointSlot) throw new Error('checkpointSlot is required for action=set_checkpoint');

    const target = createClient(getRedisConfig(event, 'target'));
    await target.connect();

    try {
        await target.hset(getApiMetricsKey(network), 'currentBlockHash', checkpointBlockHash, 'currentSlot', `${checkpointSlot}`);
        return {
            action: 'set_checkpoint',
            network,
            targetHost: target.options.host,
            currentBlockHash: checkpointBlockHash,
            currentSlot: checkpointSlot
        };
    } finally {
        target.disconnect();
    }
};

const copyNamespace = async (event: ValkeyEvent) => {
    const network = requireNetwork(event);

    const sourcePrefix = event.sourcePrefix ?? '{root}';
    const scanCount = toInt(event.scanCount, 1000);
    const includeTargetKeys = toBoolean(event.includeTargetKeys, true);
    const sourceMode = normalizeSourceMode(event.sourceMode, includeTargetKeys);
    const dryRun = toBoolean(event.dryRun, false);
    const sourceConfig = getRedisConfig(event, 'source');
    const targetConfig = getRedisConfig(event, 'target');
    const useServerCopy = isSameRedisTarget(sourceConfig, targetConfig);
    const source = createClient(sourceConfig);
    const target = createClient(targetConfig);

    await source.connect();
    await target.connect();

    try {
        const { sourceKeys, pairs, sample, skipped } = await buildNamespacePairs(source, network, sourcePrefix, scanCount, sourceMode);
        const summary = {
            action: 'copy_namespace',
            network,
            sourceHost: source.options.host,
            targetHost: target.options.host,
            sourceKeys: sourceKeys.length,
            includeTargetKeys,
            sourceMode,
            useServerCopy,
            copied: 0,
            skipped,
            missing: 0,
            dryRun,
            sample,
            byType: {} as Record<string, number>
        };

        for (const { sourceKey, targetKey } of pairs) {
            if (useServerCopy) continue;

            const result = await copyKey(source, target, sourceKey, targetKey, dryRun, useServerCopy);
            summary.byType[result.type] = (summary.byType[result.type] ?? 0) + 1;

            if (result.status === 'missing') summary.missing += 1;
            else summary.copied += 1;
        }

        if (useServerCopy) {
            if (dryRun) {
                summary.copied += pairs.length;
            } else {
                for (let index = 0; index < pairs.length; index += SERVER_COPY_BATCH_SIZE) {
                    const batch = pairs.slice(index, index + SERVER_COPY_BATCH_SIZE);
                    const result = await copyKeysServerSide(target, batch);
                    summary.copied += result.copied;
                    summary.missing += result.missing;
                    for (const [type, count] of Object.entries(result.byType)) {
                        summary.byType[type] = (summary.byType[type] ?? 0) + count;
                    }
                }
            }
        }

        return summary;
    } finally {
        source.disconnect();
        target.disconnect();
    }
};

const renameNamespace = async (event: ValkeyEvent) => {
    const network = requireNetwork(event);

    const sourcePrefix = event.sourcePrefix ?? '{root}';
    const scanCount = toInt(event.scanCount, 1000);
    const dryRun = toBoolean(event.dryRun, false);
    const sourceMode = normalizeSourceMode(event.sourceMode, false);
    const sourceConfig = getRedisConfig(event, 'source');
    const targetConfig = getRedisConfig(event, 'target');
    if (!isSameRedisTarget(sourceConfig, targetConfig)) {
        throw new Error('rename_namespace requires sourceHost and targetHost to resolve to the same redis target');
    }

    const target = createClient(targetConfig);
    await target.connect();

    try {
        const { sourceKeys, pairs, sample, skipped } = await buildNamespacePairs(target, network, sourcePrefix, scanCount, sourceMode);
        const summary = {
            action: 'rename_namespace',
            network,
            targetHost: target.options.host,
            sourceKeys: sourceKeys.length,
            sourceMode,
            renamed: 0,
            skipped,
            missing: 0,
            dryRun,
            sample,
            byType: {} as Record<string, number>
        };

        if (dryRun) {
            summary.renamed = pairs.length;
        } else {
            for (let index = 0; index < pairs.length; index += SERVER_COPY_BATCH_SIZE) {
                const batch = pairs.slice(index, index + SERVER_COPY_BATCH_SIZE);
                const result = await renameKeysServerSide(target, batch);
                summary.renamed += result.renamed;
                summary.missing += result.missing;
                for (const [type, count] of Object.entries(result.byType)) {
                    summary.byType[type] = (summary.byType[type] ?? 0) + count;
                }
            }
        }

        return summary;
    } finally {
        target.disconnect();
    }
};

const deleteNamespace = async (event: ValkeyEvent) => {
    const network = requireNetwork(event);

    const sourcePrefix = event.sourcePrefix ?? '{root}';
    const scanCount = toInt(event.scanCount, 1000);
    const dryRun = toBoolean(event.dryRun, false);
    const sourceMode = normalizeSourceMode(event.sourceMode, true);
    const target = createClient(getRedisConfig(event, 'target'));
    await target.connect();

    try {
        const sourceKeys = await collectSourceKeys(target, network, sourcePrefix, scanCount, sourceMode);
        const summary = {
            action: 'delete_namespace',
            network,
            targetHost: target.options.host,
            sourceKeys: sourceKeys.length,
            sourceMode,
            deleted: 0,
            missing: 0,
            dryRun,
            sample: sourceKeys.slice(0, 10),
            byType: {} as Record<string, number>
        };

        if (dryRun) {
            summary.deleted = sourceKeys.length;
        } else {
            for (let index = 0; index < sourceKeys.length; index += SERVER_COPY_BATCH_SIZE) {
                const batch = sourceKeys.slice(index, index + SERVER_COPY_BATCH_SIZE);
                const result = await deleteKeysServerSide(target, batch);
                summary.deleted += result.deleted;
                summary.missing += result.missing;
                for (const [type, count] of Object.entries(result.byType)) {
                    summary.byType[type] = (summary.byType[type] ?? 0) + count;
                }
            }
        }

        return summary;
    } finally {
        target.disconnect();
    }
};

const addMintData = async (event: ValkeyEvent) => {
    const network = requireNetwork(event);

    const handleName = `${event.handleName || ''}`.trim();
    if (!handleName) throw new Error('handleName is required for action=add_mint_data');
    const createdSlot = toInt(event.createdSlot, 0);
    if (!createdSlot) throw new Error('createdSlot is required for action=add_mint_data');
    const txHash = `${event.txHash || ''}`.trim();
    if (!txHash) throw new Error('txHash is required for action=add_mint_data');

    const tag = getApiCacheTag(network);
    const mintKey = `${tag}:mint:${handleName}`;

    const target = createClient(getRedisConfig(event, 'target'));
    await target.connect();

    try {
        const mintData = JSON.stringify({ created_slot: createdSlot, txHash });
        await target.sadd(mintKey, mintData);

        return {
            action: 'add_mint_data',
            network,
            targetHost: target.options.host,
            handleName,
            createdSlot,
            txHash,
            mintKey
        };
    } finally {
        target.disconnect();
    }
};

const seedMptRoot = async (event: ValkeyEvent) => {
    const network = requireNetwork(event);

    const tag = getApiCacheTag(network);
    const handleIndexKey = `${tag}:handle`;
    const mptRootHashKey = `${tag}:mpt_root_hash`;

    const target = createClient(getRedisConfig(event, 'target'));
    await target.connect();

    try {
        const handleNames: string[] = [];
        let cursor = '0';
        do {
            const [nextCursor, batch] = await target.sscan(handleIndexKey, cursor, 'COUNT', '10000');
            cursor = nextCursor;
            handleNames.push(...batch);
        } while (cursor !== '0');

        const ghosts = GHOST_HANDLES[network] ?? [];
        const allNames = [...new Set([...handleNames, ...ghosts].map((h) => `${h}`.trim()).filter(Boolean))].sort();

        const trie = new Trie();
        for (const name of allNames) {
            await trie.insert(name, '');
        }
        const hash = trie.hash?.toString('hex') ?? EMPTY_MPT_ROOT_HASH;

        await target.set(mptRootHashKey, hash);

        return {
            action: 'seed_mpt_root',
            network,
            targetHost: target.options.host,
            handleCount: handleNames.length,
            ghostCount: ghosts.length,
            totalTrieEntries: allNames.length,
            mptRootHash: hash
        };
    } finally {
        target.disconnect();
    }
};

// Returns every handle in {api:network}:handle:* whose `script.cbor` field is set.
// Read-only enumerator for the script-type backfill (see scripts/backfill-script-types.ts).
const scriptsWithCbor = async (event: ValkeyEvent) => {
    const network = requireNetwork(event);
    const handleIndexKey = getHandleIndexRootKey(network);
    const target = createClient(getRedisConfig(event, 'target'));
    await target.connect();

    try {
        const allNames: string[] = [];
        let cursor = '0';
        do {
            const [nextCursor, batch] = await target.sscan(handleIndexKey, cursor, 'COUNT', '10000');
            cursor = nextCursor;
            allNames.push(...batch);
        } while (cursor !== '0');

        const handles: Array<{ name: string; hex: string; policy: string; utxo: string; type: string; cbor: string }> = [];
        for (let i = 0; i < allNames.length; i += HANDLE_HMGET_BATCH) {
            const chunk = allNames.slice(i, i + HANDLE_HMGET_BATCH);
            const pipeline = target.pipeline();
            for (const name of chunk) {
                pipeline.hmget(getHandleIndexKey(network, name), 'name', 'hex', 'policy', 'utxo', 'script');
            }
            const replies = await pipeline.exec();
            if (!replies) continue;
            for (let j = 0; j < replies.length; j++) {
                const [err, fields] = replies[j];
                if (err || !Array.isArray(fields)) continue;
                const [storedName, hex, policy, utxo, scriptRaw] = fields as Array<string | null>;
                if (!scriptRaw) continue;
                let script: { type?: string; cbor?: string } | null = null;
                try {
                    script = JSON.parse(scriptRaw);
                } catch {
                    continue;
                }
                if (!script?.cbor) continue;
                handles.push({
                    name: storedName || chunk[j],
                    hex: hex ?? '',
                    policy: policy ?? '',
                    utxo: utxo ?? '',
                    type: script.type ?? '',
                    cbor: script.cbor
                });
            }
        }

        return {
            action: 'scripts_with_cbor',
            network,
            targetHost: target.options.host,
            total: allNames.length,
            withScript: handles.length,
            handles
        };
    } finally {
        target.disconnect();
    }
};

// Targeted update of the `type` inside each handle's stored `script` JSON field.
// Lease-gated against the scanner so a partial concurrent write can't race the writer.
// Read-modify-write per handle: HMGET, mutate, HSET.
const updateScriptTypes = async (event: ValkeyEvent) => {
    const network = requireNetwork(event);
    if (!Array.isArray(event.updates) || !event.updates.length) {
        throw new Error('updates is required for action=update_script_types and must be non-empty');
    }
    const updates = event.updates;
    const dryRun = toBoolean(event.dryRun, false);
    const target = createClient(getRedisConfig(event, 'target'));
    await target.connect();

    const leaseKey = getScannerLeaseKey(network);
    const leaseOwner = `valkey-utility-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let leaseAcquired = false;
    try {
        const leaseResult = dryRun
            ? 'OK'
            : await target.set(leaseKey, leaseOwner, 'PX', SCANNER_LEASE_TTL_MS, 'NX');
        if (leaseResult !== 'OK') {
            return {
                action: 'update_script_types',
                network,
                targetHost: target.options.host,
                dryRun,
                error: 'Scanner lease held by another invocation; retry shortly.',
                leaseKey
            };
        }
        leaseAcquired = !dryRun;

        const summary = {
            action: 'update_script_types',
            network,
            targetHost: target.options.host,
            dryRun,
            requested: updates.length,
            updated: 0,
            unchanged: 0,
            missing: 0,
            invalid: 0,
            failures: [] as Array<{ name: string; reason: string }>
        };

        for (const update of updates) {
            const name = `${update?.name ?? ''}`.trim();
            const newType = `${update?.type ?? ''}`.trim();
            if (!name || !newType) {
                summary.invalid += 1;
                summary.failures.push({ name, reason: 'name and type are required' });
                continue;
            }
            const handleKey = getHandleIndexKey(network, name);
            const scriptRaw = await target.hget(handleKey, 'script');
            if (!scriptRaw) {
                summary.missing += 1;
                summary.failures.push({ name, reason: 'no script field' });
                continue;
            }
            let script: { type?: string; cbor?: string } | null = null;
            try {
                script = JSON.parse(scriptRaw);
            } catch {
                summary.invalid += 1;
                summary.failures.push({ name, reason: 'unparseable script JSON' });
                continue;
            }
            if (!script?.cbor) {
                summary.invalid += 1;
                summary.failures.push({ name, reason: 'script.cbor missing' });
                continue;
            }
            if (script.type === newType) {
                summary.unchanged += 1;
                continue;
            }
            const next = JSON.stringify({ ...script, type: newType });
            if (!dryRun) {
                await target.hset(handleKey, 'script', next);
            }
            summary.updated += 1;
        }

        return summary;
    } finally {
        if (leaseAcquired) {
            try {
                await target.eval(LEASE_RELEASE_LUA, 1, leaseKey, leaseOwner);
            } catch {
                // Best effort; lease will expire via TTL.
            }
        }
        target.disconnect();
    }
};

// Inspection / debugging actions (originally hand-deployed slim handler).
const inspect = async (event: ValkeyEvent) => {
    const target = createClient(getRedisConfig(event, 'target'));
    await target.connect();
    try {
        const action = event.action ?? 'status';
        if (action === 'hgetall') {
            const result = await target.hgetall(`${event.key}`);
            return { key: event.key, result };
        }
        if (action === 'get') {
            const result = await target.get(`${event.key}`);
            return { key: event.key, result };
        }
        if (action === 'del') {
            const result = await target.del(`${event.key}`);
            return { key: event.key, deleted: result };
        }
        if (action === 'hdel') {
            const fields = Array.isArray(event.field) ? event.field : [`${event.field ?? ''}`];
            const validFields = fields.filter((f) => !!f);
            if (!event.key || !validFields.length) {
                return { error: 'hdel requires `key` and `field` (string or string[])' };
            }
            const before = await target.hmget(`${event.key}`, ...validFields);
            const removed = await target.hdel(`${event.key}`, ...validFields);
            return { key: event.key, fields: validFields, removed, before };
        }
        if (action === 'scard') {
            const result = await target.scard(`${event.key}`);
            return { key: event.key, count: result };
        }
        if (action === 'sdiff_count') {
            const a = await target.smembers(`${event.keyA}`);
            const b = new Set(await target.smembers(`${event.keyB}`));
            const onlyInA = a.filter((x) => !b.has(x));
            return { keyA: event.keyA, keyB: event.keyB, aCount: a.length, bCount: b.size, onlyInA: onlyInA.slice(0, 50), onlyInACount: onlyInA.length };
        }
        if (action === 'smembers_diff') {
            // Compare {api:NET}:handle (set of handle names) against an externally provided list.
            const a = new Set(await target.smembers(`${event.keyA}`));
            const expected = new Set(event.expected ?? []);
            const inApiNotExpected = [...a].filter((n) => !expected.has(n));
            const inExpectedNotApi = [...expected].filter((n) => !a.has(n));
            return { redis: a.size, expected: expected.size, inApiNotExpected, inExpectedNotApi };
        }
        if (action === 'reset_scanner') {
            const network = requireNetwork(event);
            const metricsKey = getApiMetricsKey(network);
            const progressKey = `${getApiCacheTag(network)}:snapshot_loader:progress`;
            const before = await target.hgetall(metricsKey);
            await target.hset(metricsKey, {
                currentBlockHash: '',
                currentSlot: '0',
                lockLambdas: '',
                lockLambdasTimestamp: '0'
            });
            const progressDeleted = await target.del(progressKey);
            const after = await target.hgetall(metricsKey);
            return { network, metricsKey, progressKey, progressDeleted, before, after };
        }
        // Default status: read the requested network's MPT root + scanner metrics.
        // Network is required — no silent default. (See requireNetwork: a missing
        // network used to default to mainnet, so an empty {} payload mutated mainnet.)
        const network = requireNetwork(event);
        const tag = getApiCacheTag(network);
        const mptRoot = await target.get(`${tag}:mpt_root_hash`);
        const metrics = await target.hgetall(`${tag}:metrics`);
        return { network, mptRoot, slot: metrics.currentSlot, lock: metrics.lockLambdas };
    } finally {
        target.disconnect();
    }
};

export const handler = async (event: ValkeyEvent = {}) => {
    try {
        let result: any;
        switch (event.action) {
            case 'copy_namespace': result = await copyNamespace(event); break;
            case 'rename_namespace': result = await renameNamespace(event); break;
            case 'delete_namespace': result = await deleteNamespace(event); break;
            case 'set_checkpoint': result = await setCheckpoint(event); break;
            case 'seed_mpt_root': result = await seedMptRoot(event); break;
            case 'add_mint_data': result = await addMintData(event); break;
            case 'scripts_with_cbor': result = await scriptsWithCbor(event); break;
            case 'update_script_types': result = await updateScriptTypes(event); break;
            case 'hgetall':
            case 'get':
            case 'del':
            case 'hdel':
            case 'scard':
            case 'sdiff_count':
            case 'smembers_diff':
            case 'reset_scanner': result = await inspect(event); break;
            default: result = await inspectMetrics(event); break;
        }
        console.log(JSON.stringify(result, jsonReplacer));
        return result;
    } catch (error: any) {
        const errorPayload = { action: event.action ?? 'inspect_metrics', error: `${error?.message ?? error}` };
        console.log(JSON.stringify(errorPayload, jsonReplacer));
        return errorPayload;
    }
};
