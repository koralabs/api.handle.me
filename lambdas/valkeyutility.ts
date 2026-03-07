import Redis from 'ioredis';

const LEGACY_GLOBAL_KEYS = ['metrics', 'scanner:lease', 'scanner:recovery'];

type ValkeyCopyEvent = {
    action?: 'copy_namespace';
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
    dryRun?: boolean | string;
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

const collectSourceKeys = async (client: Redis, network: string, sourcePrefix: string, scanCount: number, includeTargetKeys: boolean) => {
    const targetTag = getApiCacheTag(network);
    const keys = new Set<string>();

    for (const key of await collectMatchingKeys(client, `${sourcePrefix}:*`, scanCount)) keys.add(key);
    if (includeTargetKeys) {
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

const copyNamespace = async (event: ValkeyCopyEvent) => {
    const network = `${event.network || ''}`.toLowerCase();
    if (!network) throw new Error('network is required for action=copy_namespace');

    const sourcePrefix = event.sourcePrefix ?? '{root}';
    const scanCount = toInt(event.scanCount, 1000);
    const includeTargetKeys = toBoolean(event.includeTargetKeys, true);
    const dryRun = toBoolean(event.dryRun, false);
    const sourceConfig = getRedisConfig(event, 'source');
    const targetConfig = getRedisConfig(event, 'target');
    const useServerCopy = isSameRedisTarget(sourceConfig, targetConfig);
    const source = createClient(sourceConfig);
    const target = createClient(targetConfig);

    await source.connect();
    await target.connect();

    try {
        const sourceKeys = await collectSourceKeys(source, network, sourcePrefix, scanCount, includeTargetKeys);
        const summary = {
            action: 'copy_namespace',
            network,
            sourceHost: source.options.host,
            targetHost: target.options.host,
            sourceKeys: sourceKeys.length,
            includeTargetKeys,
            useServerCopy,
            copied: 0,
            skipped: 0,
            missing: 0,
            dryRun,
            sample: [] as Array<{ sourceKey: string; targetKey: string }>,
            byType: {} as Record<string, number>
        };

        for (const sourceKey of sourceKeys) {
            const targetKey = mapTargetKey(sourceKey, network, sourcePrefix);
            if (!targetKey) {
                summary.skipped += 1;
                continue;
            }

            if (summary.sample.length < 10) summary.sample.push({ sourceKey, targetKey });

            const result = await copyKey(source, target, sourceKey, targetKey, dryRun, useServerCopy);
            summary.byType[result.type] = (summary.byType[result.type] ?? 0) + 1;

            if (result.status === 'missing') summary.missing += 1;
            else summary.copied += 1;
        }

        console.log(JSON.stringify(summary, jsonReplacer));
    } finally {
        source.disconnect();
        target.disconnect();
    }
};

export const handler = async (event: ValkeyCopyEvent = {}) => {
    try {
        if (event.action == 'copy_namespace') {
            await copyNamespace(event);
            return;
        }
        await inspectMetrics(event);
    } catch (error: any) {
        console.log(JSON.stringify({ action: event.action ?? 'inspect_metrics', error: `${error?.message ?? error}` }, jsonReplacer));
    }
};
