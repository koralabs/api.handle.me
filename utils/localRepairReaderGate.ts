import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { getApiCacheKey, getApiLocalRepairJournalKey, getApiScannerLeaseKey } from '../stores/redis/keys';

let script: string | undefined;
type Store = { redisClientCall(method: string, ...args: any[]): any };
const keys = () => [getApiCacheKey('local-repair:reader-gate'), getApiCacheKey('local-repair:readers'),
    getApiLocalRepairJournalKey(), getApiCacheKey('local-repair:lease'), getApiScannerLeaseKey()];

export const localRepairGate = (store: Store, operation: string, ...args: string[]): number => {
    script ??= readFileSync(resolve(process.cwd(), 'stores/redis/localRepairReaderGate.lua'), 'utf8');
    return store.redisClientCall('customCommand', ['EVAL', script, '5', ...keys(), operation, ...args]);
};

/** Isolated-only admission held until the response cannot emit further bytes. */
export const localRepairReaderAdmission = (getStore: () => Store) =>
    (_req: Request, res: Response, next: NextFunction): void => {
        const token = randomUUID();
        let store: Store;
        try {
            store = getStore();
            if (localRepairGate(store, 'admit', token) !== 1) {
                res.status(503).json({ error: 'Repair in progress' });
                return;
            }
        } catch {
            res.status(503).json({ error: 'Repair in progress' });
            return;
        }
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            try { localRepairGate(store, 'release', token); } catch { /* An orphan must remain blocking. */ }
        };
        res.once('finish', release);
        res.once('close', release);
        next();
    };
