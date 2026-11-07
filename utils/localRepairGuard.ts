import type { NextFunction, Request, Response } from 'express';
import { getApiLocalRepairEpochKey, getApiLocalRepairJournalKey } from '../stores/redis/keys';

/** Local repair prototype: reject both new readers and responses spanning a repair. */
export const localRepairGuard = (getStore: () => { redisClientCall(method: string, ...args: any[]): any }) =>
    (_req: Request, res: Response, next: NextFunction): void => {
        const store = getStore();
        let epoch: string | null;
        try {
            epoch = store.redisClientCall('get', getApiLocalRepairEpochKey()) ?? null;
            if (store.redisClientCall('get', getApiLocalRepairJournalKey())) {
                res.status(503).json({ error: 'Repair in progress' });
                return;
            }
        } catch (error) {
            next(error);
            return;
        }
        const send = res.send.bind(res);
        res.send = ((body: any) => {
            let unsafe = true;
            try {
                unsafe = (store.redisClientCall('get', getApiLocalRepairEpochKey()) ?? null) !== epoch
                    || !!store.redisClientCall('get', getApiLocalRepairJournalKey());
            } catch {
                // Fail closed if the repair fence cannot be checked.
            }
            if (unsafe) {
                res.status(503).type('application/json');
                return send(JSON.stringify({ error: 'Repair in progress' }));
            }
            return send(body);
        }) as typeof res.send;
        next();
    };
