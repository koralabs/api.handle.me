import { randomUUID } from 'node:crypto';

// Experimental only. Callers must supply the actual Lua script, same-slot keys and
// a live Valkey client. Reader tokens never expire: cleanup after process death needs
// independent proof that the old process cannot resume emitting response bytes.
export function experimentalReaderMiddleware(client, script, keys) {
    const call = (operation, token) => client.customCommand(['EVAL', script, String(keys.length), ...keys, operation, token, '']);
    return async (_req, res, next) => {
        const token = randomUUID();
        let admitted;
        try { admitted = await call('admit', token); }
        catch { res.status(503).json({ error: 'Reader gate unavailable' }); return; }
        if (admitted !== 1) { res.status(503).json({ error: 'Repair in progress' }); return; }
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            // Failure deliberately leaves the token in Valkey and blocks repair.
            void call('release', token).catch(() => {});
        };
        res.once('finish', release);
        res.once('close', release);
        if (res.destroyed || res.writableEnded) { release(); return; }
        next();
    };
}
