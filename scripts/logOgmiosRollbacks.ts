import { HealthResponseBody } from '../interfaces/ogmios.interfaces';
import { fetchHealth } from '../services/ogmios/utils';
import * as url from 'url';
import WebSocket from 'ws';

type IntersectionPoint = { slot: number; id: string };
type RollbackWatcherSocket = {
    send: (payload: string) => void;
    on: (event: string, listener: (...args: any[]) => void) => unknown;
};

type RollbackWatcherDeps = {
    ogmiosHost?: string;
    fetchHealthFn?: () => Promise<HealthResponseBody | null>;
    createSocket?: (ogmiosHost: string) => RollbackWatcherSocket;
    log?: (...args: any[]) => void;
    errorLog?: (...args: any[]) => void;
};

const toNumber = (value: unknown) => {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
};

const toWebSocketUrl = (host: string) => {
    const parsed = new url.URL(host);
    if (parsed.protocol === 'http:') parsed.protocol = 'ws:';
    if (parsed.protocol === 'https:') parsed.protocol = 'wss:';
    return parsed.toString();
};

export const resolveIntersectionPoint = (health: HealthResponseBody | null): IntersectionPoint => {
    const tip = health?.lastKnownTip;
    const slot = toNumber(tip?.slot);
    const id = typeof tip?.id === 'string' ? tip.id : typeof tip?.hash === 'string' ? tip.hash : null;

    if (!id || slot === null) {
        throw new Error('Could not determine current tip from Ogmios health');
    }
    return { slot, id };
};

export const startOgmiosRollbackWatcher = async (deps: RollbackWatcherDeps = {}) => {
    const ogmiosHost = deps.ogmiosHost ?? process.env.OGMIOS_HOST ?? 'http://localhost:1337';
    const log = deps.log ?? console.log;
    const errorLog = deps.errorLog ?? console.error;
    const getHealth = deps.fetchHealthFn ?? (() => fetchHealth(ogmiosHost));
    const createSocket = deps.createSocket ?? ((host: string) => new WebSocket(toWebSocketUrl(host), { allowSynchronousEvents: false }));
    const intersectionPoint = resolveIntersectionPoint(await getHealth());
    const client = createSocket(ogmiosHost);

    const rpcRequest = (method: string, params: Record<string, unknown>, id: string) => {
        client.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }));
    };

    const logRollback = (rollback: unknown) => {
        log(`[${new Date().toISOString()}] ROLLBACK`, JSON.stringify(rollback));
    };

    client.on('open', () => {
        log(`Connected to Ogmios at ${ogmiosHost}`);
        log(`Watching from intersection point ${JSON.stringify(intersectionPoint)}`);
        rpcRequest('findIntersection', { points: [intersectionPoint] }, 'find-intersection');
    });

    client.on('message', (msg: Buffer | string) => {
        try {
            const response = JSON.parse(msg.toString());

            if (response.id === 'find-intersection') {
                rpcRequest('nextBlock', {}, 'next-block');
                return;
            }

            if (response.id !== 'next-block') return;

            const result = response?.result;
            if (result?.direction === 'backward') {
                logRollback({
                    point: result?.point,
                    tip: result?.tip
                });
            } else if (result?.RollBackward) {
                logRollback(result.RollBackward);
            }

            rpcRequest('nextBlock', {}, 'next-block');
        } catch (error: any) {
            errorLog('Failed to parse Ogmios message', error?.message ?? error);
        }
    });

    client.on('error', (error: unknown) => {
        errorLog('Ogmios websocket error', error);
    });

    client.on('close', (code: number, reason: Buffer) => {
        log(`Ogmios websocket closed (${code}) ${reason.toString()}`);
    });

    return { client, intersectionPoint };
};

const isMainModule = process.argv[1] && import.meta.url === url.pathToFileURL(process.argv[1]).href;
if (isMainModule) {
    startOgmiosRollbackWatcher().catch((error: any) => {
        console.error('Failed to start Ogmios rollback watcher', error?.message ?? error);
        process.exitCode = 1;
    });
}
