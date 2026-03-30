import { Logger, REDIS_HOST } from '@koralabs/kora-labs-common';
import { Batch, GlideClient } from '@valkey/valkey-glide';
import { parentPort } from 'node:worker_threads';

let glideClient;
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

if (parentPort) {
    parentPort.on('message', async (m) => {
        const { id, sab, payload, reply } = m;
        const view = new Int32Array(sab);
        try {
            //logKeyRequest('handle:', payload); // What is getting passed in?
            const client = await getClient();
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
