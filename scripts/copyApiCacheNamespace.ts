import Redis from 'ioredis';
import { getApiCacheTag } from '../stores/redis/keys';

const LEGACY_GLOBAL_KEYS = ['metrics', 'scanner:lease', 'scanner:recovery'];

type Options = {
    sourceHost: string;
    sourcePort: number;
    sourcePassword?: string;
    sourceTls: boolean;
    sourceDb: number;
    targetHost: string;
    targetPort: number;
    targetPassword?: string;
    targetTls: boolean;
    targetDb: number;
    network: string;
    sourcePrefix: string;
    scanCount: number;
    dryRun: boolean;
};

const readFlag = (args: string[], flag: string) => {
    const index = args.indexOf(flag);
    if (index === -1) return undefined;
    return args[index + 1];
};

const hasFlag = (args: string[], flag: string) => args.includes(flag);

const toInt = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const usage = () => {
    console.log(`Usage:
  npx tsx scripts/copyApiCacheNamespace.ts \\
    --source-host <host> --target-host <host> --network <preview|preprod|mainnet> \\
    [--source-port 6379] [--target-port 6379] [--source-password <password>] [--target-password <password>] \\
    [--source-db 0] [--target-db 0] [--source-tls] [--target-tls] [--source-prefix {root}] \\
    [--scan-count 1000] [--dry-run]
`);
};

const parseArgs = (): Options => {
    const args = process.argv.slice(2);
    if (hasFlag(args, '--help')) {
        usage();
        process.exit(0);
    }

    const sourceHost = readFlag(args, '--source-host');
    const targetHost = readFlag(args, '--target-host');
    const network = readFlag(args, '--network');

    if (!sourceHost || !targetHost || !network) {
        usage();
        throw new Error('Missing required flags: --source-host, --target-host, and --network are required.');
    }

    return {
        sourceHost,
        sourcePort: toInt(readFlag(args, '--source-port'), 6379),
        sourcePassword: readFlag(args, '--source-password'),
        sourceTls: hasFlag(args, '--source-tls'),
        sourceDb: toInt(readFlag(args, '--source-db'), 0),
        targetHost,
        targetPort: toInt(readFlag(args, '--target-port'), 6379),
        targetPassword: readFlag(args, '--target-password'),
        targetTls: hasFlag(args, '--target-tls'),
        targetDb: toInt(readFlag(args, '--target-db'), 0),
        network,
        sourcePrefix: readFlag(args, '--source-prefix') ?? '{root}',
        scanCount: toInt(readFlag(args, '--scan-count'), 1000),
        dryRun: hasFlag(args, '--dry-run')
    };
};

const createClient = ({ host, port, password, tls, db }: { host: string; port: number; password?: string; tls: boolean; db: number }) =>
    new Redis({
        host,
        port,
        password,
        db,
        lazyConnect: true,
        tls: tls ? {} : undefined
    });

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

const collectSourceKeys = async (client: Redis, options: Options) => {
    const targetTag = getApiCacheTag(options.network);
    const keys = new Set<string>();

    for (const key of await collectMatchingKeys(client, `${options.sourcePrefix}:*`, options.scanCount)) keys.add(key);
    for (const key of await collectMatchingKeys(client, `${targetTag}:*`, options.scanCount)) keys.add(key);

    for (const key of LEGACY_GLOBAL_KEYS) {
        if (await client.exists(key)) keys.add(key);
    }

    return [...keys].sort();
};

const mapTargetKey = (sourceKey: string, options: Options) => {
    const targetTag = getApiCacheTag(options.network);
    if (sourceKey.startsWith(`${targetTag}:`)) return sourceKey;
    if (LEGACY_GLOBAL_KEYS.includes(sourceKey)) return `${targetTag}:${sourceKey}`;
    const sourcePrefix = `${options.sourcePrefix}:`;
    if (sourceKey.startsWith(sourcePrefix)) return `${targetTag}:${sourceKey.slice(sourcePrefix.length)}`;
    return undefined;
};

const copyKey = async (source: Redis, target: Redis, sourceKey: string, targetKey: string, dryRun: boolean) => {
    const type = await source.type(sourceKey);
    if (type === 'none') return { status: 'missing', type };

    if (dryRun) return { status: 'dry-run', type };

    const payload = await source.dump(sourceKey);
    if (!payload) return { status: 'missing', type };

    const ttl = await source.pttl(sourceKey);
    await target.restore(targetKey, ttl > 0 ? ttl : 0, payload, 'REPLACE');
    return { status: 'copied', type };
};

const main = async () => {
    const options = parseArgs();
    const source = createClient({
        host: options.sourceHost,
        port: options.sourcePort,
        password: options.sourcePassword,
        tls: options.sourceTls,
        db: options.sourceDb
    });
    const target = createClient({
        host: options.targetHost,
        port: options.targetPort,
        password: options.targetPassword,
        tls: options.targetTls,
        db: options.targetDb
    });

    await source.connect();
    await target.connect();

    try {
        const sourceKeys = await collectSourceKeys(source, options);
        const summary = {
            network: options.network.toLowerCase(),
            sourceKeys: sourceKeys.length,
            copied: 0,
            skipped: 0,
            missing: 0,
            dryRun: options.dryRun,
            sample: [] as Array<{ sourceKey: string; targetKey: string }>,
            byType: {} as Record<string, number>
        };

        for (const sourceKey of sourceKeys) {
            const targetKey = mapTargetKey(sourceKey, options);
            if (!targetKey) {
                summary.skipped += 1;
                continue;
            }

            if (summary.sample.length < 10) {
                summary.sample.push({ sourceKey, targetKey });
            }

            const result = await copyKey(source, target, sourceKey, targetKey, options.dryRun);
            summary.byType[result.type] = (summary.byType[result.type] ?? 0) + 1;

            if (result.status === 'missing') summary.missing += 1;
            else if (result.status === 'copied' || result.status === 'dry-run') summary.copied += 1;
        }

        console.log(JSON.stringify(summary, null, 2));
    } finally {
        await source.quit();
        await target.quit();
    }
};

main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
