import type { NextFunction, Request, Response } from 'express';
import { getApiLocalRepairEpochKey, getApiLocalRepairJournalKey } from '../stores/redis/keys';

/** Reject readers during repair and responses whose reads span a repair. */
export const localRepairGuard = (getStore: () => { redisClientCall(method: string, ...args: any[]): any }) =>
    (_req: Request, res: Response, next: NextFunction): void => {
        let store: ReturnType<typeof getStore>;
        let epoch: string | null;
        const read = (key: string): string | null => {
            const value = store.redisClientCall('get', key);
            if (value !== null && typeof value !== 'string') throw new Error('Repair fence unavailable');
            return value;
        };
        const reject = () => {
            res.removeHeader('Content-Length');
            res.removeHeader('Content-Encoding');
            res.removeHeader('ETag');
            res.status(503).json({ error: 'Repair in progress' });
        };
        try {
            store = getStore();
            epoch = read(getApiLocalRepairEpochKey());
            if (read(getApiLocalRepairJournalKey()) !== null) {
                reject();
                return;
            }
        } catch {
            reject();
            return;
        }
        const end = res.end.bind(res);
        res.end = ((...args: any[]) => {
            let unsafe = true;
            try {
                unsafe = read(getApiLocalRepairEpochKey()) !== epoch || read(getApiLocalRepairJournalKey()) !== null;
            } catch {
                // Fail closed if the repair fence cannot be checked.
            }
            if (unsafe) {
                if (res.headersSent) { res.destroy(); return res; }
                res.removeHeader('Content-Length');
                res.removeHeader('Content-Encoding');
                res.removeHeader('ETag');
                res.status(503).type('application/json');
                return end(JSON.stringify({ error: 'Repair in progress' }));
            }
            return (end as any)(...args);
        }) as typeof res.end;
        const send = res.send.bind(res);
        res.send = ((body: any) => {
            let unsafe = true;
            try {
                unsafe = read(getApiLocalRepairEpochKey()) !== epoch || read(getApiLocalRepairJournalKey()) !== null;
            } catch {
                // Fail closed if the repair fence cannot be checked.
            }
            if (unsafe) {
                res.removeHeader('Content-Length');
                res.removeHeader('Content-Encoding');
                res.removeHeader('ETag');
                res.status(503).type('application/json');
                return send(JSON.stringify({ error: 'Repair in progress' }));
            }
            return send(body);
        }) as typeof res.send;
        next();
    };
