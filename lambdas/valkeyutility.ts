import { GlideClient } from '@valkey/valkey-glide';
import { getApiMetricsKey } from '../stores/redis/keys';

const jsonReplacer = (_: string, value: any) => (typeof value === 'bigint' ? value.toString() : value);

let glideClient: any;

const getRedisHost = () => {
    const region = process.env.AWS_REGION?.toUpperCase().replace(/-/g, '_');
    if (region) {
        const regionHost = process.env[`REDIS_HOST_${region}`];
        if (regionHost) return regionHost;
    }
    return process.env.REDIS_HOST || '127.0.0.1';
};

const getRedisPort = () => {
    const parsedPort = Number(process.env.REDIS_PORT);
    if (Number.isInteger(parsedPort) && parsedPort > 0) return parsedPort;
    return 6379;
};

const getClient = async () => {
    if (!glideClient) {
        glideClient = await GlideClient.createClient({
            addresses: [{ host: getRedisHost(), port: getRedisPort() }],
            useTLS: process.env.REDIS_USE_TLS ? process.env.REDIS_USE_TLS == 'true' : true,
            requestTimeout: 20_000
        });
    }
    return glideClient;
};

const redisCall = async (command: string, args: any[]) => {
    const client = await getClient();
    const method = client?.[command];
    if (typeof method !== 'function') {
        throw new Error(`Unknown Valkey command: ${command}`);
    }
    return method.apply(client, args);
};

export const handler = async () => {
    const command = 'hgetall';
    const args = [getApiMetricsKey()];

    try {
        const result = await redisCall(command, args);
        console.log(JSON.stringify({ command, args, result }, jsonReplacer));
    } catch (error: any) {
        console.log(JSON.stringify({ command, args, error: `${error?.message ?? error}` }, jsonReplacer));
    }
};
