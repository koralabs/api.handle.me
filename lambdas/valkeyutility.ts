import Redis from 'ioredis';

const LEGACY_GLOBAL_KEYS = ['metrics', 'scanner:lease', 'scanner:recovery'];
const SERVER_COPY_BATCH_SIZE = 200;
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

type ValkeyCopyEvent = {
    action?: 'copy_namespace' | 'rename_namespace' | 'delete_namespace' | 'set_checkpoint';
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
    dryRun?: boolean | string;
    checkpointBlockHash?: string;
    checkpointSlot?: number | string;
};

type RedisConfig = {
    host: string;
    port: number;
    password?: string;
    db: number;
    tls: boolean;
};

const jsonReplacer = (_: string, value: any) => (typeof value === 'bigint' ? value.toString() : value);

const normalizeNetwork = (network = process.env.NETWORK || 'mainnet') => `${network}`.toLowerCase();

const getApiCacheTag = (network = process.env.NETWORK || 'mainnet') => `{api:${normalizeNetwork(network)}}`;

const getApiMetricsKey = (network = process.env.NETWORK || 'mainnet') => `${getApiCacheTag(network)}:metrics`;

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
    value: ValkeyCopyEvent['sourceMode'] | undefined,
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

const getRedisConfig = (event: ValkeyCopyEvent, prefix: 'source' | 'target'): RedisConfig => {
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

const inspectMetrics = async (event: ValkeyCopyEvent) => {
    const client = createClient(getRedisConfig(event, 'source'));
    await client.connect();
    try {
        const result = await client.hgetall(getApiMetricsKey());
        console.log(JSON.stringify({ command: 'hgetall', args: [getApiMetricsKey()], result }, jsonReplacer));
    } finally {
        client.disconnect();
    }
};

const setCheckpoint = async (event: ValkeyCopyEvent) => {
    const network = `${event.network || ''}`.toLowerCase();
    if (!network) throw new Error('network is required for action=set_checkpoint');

    const checkpointBlockHash = `${event.checkpointBlockHash || ''}`.trim();
    const checkpointSlot = toInt(event.checkpointSlot, 0);
    if (!checkpointBlockHash) throw new Error('checkpointBlockHash is required for action=set_checkpoint');
    if (!checkpointSlot) throw new Error('checkpointSlot is required for action=set_checkpoint');

    const target = createClient(getRedisConfig(event, 'target'));
    await target.connect();

    try {
        await target.hset(getApiMetricsKey(network), 'currentBlockHash', checkpointBlockHash, 'currentSlot', `${checkpointSlot}`);
        console.log(JSON.stringify({
            action: 'set_checkpoint',
            network,
            targetHost: target.options.host,
            currentBlockHash: checkpointBlockHash,
            currentSlot: checkpointSlot
        }, jsonReplacer));
    } finally {
        target.disconnect();
    }
};

const copyNamespace = async (event: ValkeyCopyEvent) => {
    const network = `${event.network || ''}`.toLowerCase();
    if (!network) throw new Error('network is required for action=copy_namespace');

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

        console.log(JSON.stringify(summary, jsonReplacer));
    } finally {
        source.disconnect();
        target.disconnect();
    }
};

const renameNamespace = async (event: ValkeyCopyEvent) => {
    const network = `${event.network || ''}`.toLowerCase();
    if (!network) throw new Error('network is required for action=rename_namespace');

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

        console.log(JSON.stringify(summary, jsonReplacer));
    } finally {
        target.disconnect();
    }
};

const deleteNamespace = async (event: ValkeyCopyEvent) => {
    const network = `${event.network || ''}`.toLowerCase();
    if (!network) throw new Error('network is required for action=delete_namespace');

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

        console.log(JSON.stringify(summary, jsonReplacer));
    } finally {
        target.disconnect();
    }
};

export const handler = async (event: ValkeyCopyEvent = {}) => {
    try {
        if (event.action == 'copy_namespace') {
            await copyNamespace(event);
            return;
        }
        if (event.action == 'rename_namespace') {
            await renameNamespace(event);
            return;
        }
        if (event.action == 'delete_namespace') {
            await deleteNamespace(event);
            return;
        }
        if (event.action == 'set_checkpoint') {
            await setCheckpoint(event);
            return;
        }
        await inspectMetrics(event);
    } catch (error: any) {
        console.log(JSON.stringify({ action: event.action ?? 'inspect_metrics', error: `${error?.message ?? error}` }, jsonReplacer));
    }
};
