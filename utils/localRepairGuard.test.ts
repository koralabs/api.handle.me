import express from 'express';
import request from 'supertest';
import { localRepairGuard } from './localRepairGuard';
import { getApiLocalRepairEpochKey, getApiLocalRepairJournalKey } from '../stores/redis/keys';

describe('local repair reader fence', () => {
    // A completed repair invalidates a captured response. Removing the final fence check leaks it.
    it('rejects an in-flight response after a repair and permits fresh reads', async () => {
        const state = new Map<string, string>();
        const app = express();
        app.use(localRepairGuard(() => ({ redisClientCall: (_method, key) => state.get(key) ?? null })));
        let resume!: () => void;
        let entered!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const wait = new Promise<void>(resolve => { resume = resolve; });
        app.get('/slow', async (_req, res) => { entered(); await wait; res.json({ address: 'old' }); });
        app.get('/fresh', (_req, res) => res.json({ address: 'new' }));
        const pending = request(app).get('/slow').then(result => result);
        await started;
        state.set(getApiLocalRepairEpochKey(), 'completed');
        resume();
        const stale = await pending;
        expect(stale.status).toBe(503);
        expect(stale.body).toEqual({ error: 'Repair in progress' });
        const fresh = await request(app).get('/fresh');
        expect(fresh.status).toBe(200);
        expect(fresh.body).toEqual({ address: 'new' });
    });

    // Direct end must not bypass the epoch fence; an in-flight response must fail closed.
    // Without end interception the old address is returned after repair.
    it('rejects an in-flight response sent with end', async () => {
        const state = new Map<string, string>();
        const app = express();
        app.use(localRepairGuard(() => ({ redisClientCall: (_method, key) => state.get(key) ?? null })));
        let resume!: () => void;
        let entered!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const wait = new Promise<void>(resolve => { resume = resolve; });
        app.get('/', async (_req, res) => { entered(); await wait; res.end('old address'); });
        app.get('/fresh-end', (_req, res) => res.status(202).end());
        const pending = request(app).get('/').then(result => result);
        await started;
        state.set(getApiLocalRepairEpochKey(), 'changed');
        resume();
        const response = await pending;
        expect(response.status).toBe(503);
        expect(response.text).not.toContain('old address');
        const fresh = await request(app).get('/fresh-end');
        expect(fresh.status).toBe(202);
        expect(fresh.text).toBe('');
    });

    // If the store becomes unreadable after a request starts, direct end must not leak the response.
    // Allowing a failed final check through returns the old address instead of 503.
    it('rejects direct end when the final fence read fails', async () => {
        const app = express();
        let broken = false;
        app.use(localRepairGuard(() => ({ redisClientCall: () => {
            if (broken) throw new Error('connection lost');
            return null;
        } })));
        app.get('/', (_req, res) => { broken = true; res.end('old address'); });
        const response = await request(app).get('/');
        expect(response.status).toBe(503);
        expect(response.text).not.toContain('old address');
    });

    // An active journal or unreadable fence must never expose a handle. Treating either as absent leaks it.
    it.each(['journal', 'unavailable', 'undefined'] as const)('fails closed when the fence is %s', async mode => {
        const app = express();
        app.use(localRepairGuard(() => ({ redisClientCall: (_method, key) => {
            if (mode === 'unavailable') throw new Error('connection lost');
            if (mode === 'undefined') return undefined;
            return key === getApiLocalRepairJournalKey() ? 'active' : null;
        } })));
        app.get('/', (_req, res) => res.json({ address: 'unsafe' }));
        const response = await request(app).get('/');
        expect(response.status).toBe(503);
        expect(response.body).toEqual({ error: 'Repair in progress' });
    });
});
