import { createHash } from 'crypto';
import { deflateSync } from 'zlib';
import { IndexNames, NETWORK, UTxOFunctionName } from '@koralabs/kora-labs-common';
import { registerSnapshotScannerOwner, unregisterSnapshotScannerOwner } from '../../utils/snapshotOwnership';
import { RedisHandlesStore } from './index';
import { getApiCacheTag, getApiIndexKey, getApiMetricsKey, getApiScannerLeaseKey, getApiScannerRecoveryKey } from './keys';

const snapshot = () => ({ slot: 20, hash: 'ab'.repeat(32), utxoSchemaVersion: 1,
    utxos: [{ id: 'test#0', tx_id: 'cd'.repeat(32), index: 0, blockHash: 'ab'.repeat(32), blockNum: 1,
        slot: 10, address: 'addr_test1xyz', lovelace: 100, handles: [], mint: [], metadata: {} }],
    mintingData: {}, verification: { verifiedAgainstChain: true, snapshotMptRootHash: 'ef'.repeat(32),
        chainMptRootHash: 'ef'.repeat(32), network: NETWORK.toLowerCase(), verifiedAtUtc: '2026-10-18T00:00:00Z' } });
const progressKey = `${getApiCacheTag()}:snapshot_loader:progress`;
const originalFetch = global.fetch;

function fixture() {
    const db = new Map<string, any>([
        [getApiMetricsKey(), { currentSlot: '7', currentBlockHash: 'original', handleCount: '1' }],
        [getApiIndexKey(IndexNames.UTXO, 'original#0'), { id: 'original#0' }],
        [getApiScannerLeaseKey(), 'scanner-original'], [getApiScannerRecoveryKey(), 'recovery-original']
    ]);
    registerSnapshotScannerOwner('scanner-original');
    const store = new RedisHandlesStore();
    const calls: string[] = [];
    const run = (cmd: string, ...args: any[]): any => {
        calls.push(cmd);
        if (cmd === 'hgetall') return Object.entries(db.get(args[0]) ?? {}).map(([field, value]) => ({ field, value }));
        if (cmd === 'get') return db.get(args[0]) ?? null;
        if (cmd === 'scard') return db.get(args[0])?.size ?? 0;
        if (cmd === 'snapshotClaim') return true; // Real atomic admission is exercised against Valkey in workers/snapshotTransactions.node-test.mjs.
        if (cmd === 'snapshotRelease') return 1;
        if (cmd === 'scan') return ['0', [...db.keys()]];
        if (cmd === 'hset') { db.set(args[0], { ...db.get(args[0]), ...args[1] }); return 1; }
        if (cmd === 'del') { for (const key of args[0]) db.delete(key); return args[0].length; }
        if (cmd === 'sadd') { const value = db.get(args[0]) ?? new Set(); for (const item of args[1]) value.add(item); db.set(args[0], value); return 1; }
        if (cmd === 'batch') return args[0].map(([method, values]: any) => run(method, ...values));
        throw new Error(`Unimplemented database boundary ${cmd}`);
    };
    jest.spyOn(store, 'redisClientCall').mockImplementation(run);
    jest.spyOn(store, 'getUTxOSchemaVersion').mockReturnValue(1);
    jest.spyOn(store, 'getIndexSchemaVersion').mockReturnValue(1);
    const handlers = { [UTxOFunctionName.ADD_UTXO]: (utxo: any) => store.setHashOnIndex(IndexNames.UTXO, utxo.id, utxo),
        [UTxOFunctionName.UPDATE_HANDLE_INDEXES]: () => {} } as any;
    const bytes = deflateSync(JSON.stringify(snapshot()));
    const respond = (value: any = snapshot()) => {
        const compressed = deflateSync(JSON.stringify(value));
        global.fetch = jest.fn().mockResolvedValue({ status: 200, arrayBuffer: async () => compressed });
    };
    respond();
    return { store, db, calls, handlers, bytes, respond, image: () => structuredClone([...db]) };
}
afterEach(() => { global.fetch = originalFetch; unregisterSnapshotScannerOwner('scanner-original'); jest.restoreAllMocks(); });

// Invariant: late invalid DTOs cannot erase old data or metrics, even with valid publisher metadata.
// Restoring clear-before-fetch makes these exact-image assertions fail.
it.each(['schema', 'root', 'late-utxo', 'mint-data', 'decode', 'resume404', 'fresh404-with-original'])('preserves the complete original on %s rejection', async kind => {
    const f = fixture();
    const value: any = snapshot();
    if (kind === 'schema') value.utxoSchemaVersion = 2;
    if (kind === 'root') { delete value.verification.snapshotMptRootHash; delete value.verification.chainMptRootHash; }
    if (kind === 'late-utxo') value.utxos.push({ ...value.utxos[0], id: 'late', lovelace: -1 });
    if (kind === 'mint-data') value.mintingData.alpha = [{ txHash: 'bad', created_slot: 10 }];
    f.respond(value);
    if (kind === 'decode') global.fetch = jest.fn().mockResolvedValue({ status: 200, arrayBuffer: async () => Buffer.from('bad gzip') });
    if (kind === 'resume404') f.db.set(progressKey, { mdIdx: '0', utxoIdx: '0', snapshotHash: value.hash });
    if (kind.includes('404')) global.fetch = jest.fn().mockResolvedValue({ status: 404 });
    const before = f.image();
    await expect(f.store.tryPopulateFromS3UTxOs(f.handlers)).rejects.toThrow();
    expect(f.image()).toEqual(before);
    expect(f.calls).not.toContain('snapshotClaim');
});

// Invariant: array-shaped Glide progress is decoded and strictly bounded by the complete payload.
// Removing digest/cursor checks makes these invalid resumptions mutate the original.
it.each(['-1', 'NaN', '0.5', '2', ''])('refuses invalid Glide resume cursor %s without mutation', async cursor => {
    const f = fixture();
    f.db.set(progressKey, { mdIdx: '0', utxoIdx: cursor, utxoSchemaVersion: '1', snapshotHash: snapshot().hash,
        snapshotDigest: createHash('sha256').update(f.bytes).digest('hex') });
    const before = f.image();
    await expect(f.store.tryPopulateFromS3UTxOs(f.handlers)).rejects.toThrow(/progress/);
    expect(f.image()).toEqual(before);
});

// Invariant: rejected original-image admission does not invoke any cache mutations.
// Replacing admission with unconditional success causes this test to rewrite metrics.
it('preserves a changed original when admission refuses', async () => {
    const f = fixture();
    const wire = (f.store.redisClientCall as jest.Mock).getMockImplementation()!;
    jest.spyOn(f.store, 'redisClientCall').mockImplementation((cmd, ...args) => cmd === 'snapshotClaim' ? false : wire(cmd, ...args));
    const before = f.image();
    await expect(f.store.tryPopulateFromS3UTxOs(f.handlers)).rejects.toThrow(/ownership changed/);
    expect(f.image()).toEqual(before);
});

// Invariant: only an absent original may initialize genesis; control keys are not data.
// Requiring a snapshot for all404 breaks this supported empty boot edge case.
it('initializes fresh404 genesis with no original data and preserves controls', async () => {
    const f = fixture();
    f.db.delete(getApiMetricsKey());
    f.db.delete(getApiIndexKey(IndexNames.UTXO, 'original#0'));
    global.fetch = jest.fn().mockResolvedValue({ status: 404 });
    const result = await f.store.tryPopulateFromS3UTxOs(f.handlers);
    expect(result.slot).toBeGreaterThan(0);
    expect(f.db.get(getApiMetricsKey())).toMatchObject({ currentSlot: String(result.slot), currentBlockHash: result.id });
    expect(f.db.get(getApiScannerLeaseKey())).toBe('scanner-original');
    expect(f.calls).not.toContain('scan');
});

// Invariant: observing another invocation's scanner token is not ownership.
// Removing the registration check makes this invocation clear the cache.
it('refuses an unowned scanner lease without touching the original', async () => {
    const f = fixture();
    unregisterSnapshotScannerOwner('scanner-original');
    const before = f.image();
    await expect(f.store.tryPopulateFromS3UTxOs(f.handlers)).rejects.toThrow(/another invocation/);
    expect(f.image()).toEqual(before);
    expect(f.calls).not.toContain('snapshotClaim');
});

// Invariant: valid imports publish replayed UTxOs while preserving scanner/control ownership.
// Broad namespace deletion removes the two control keys and fails these assertions.
it('replays a fully validated snapshot and preserves control keys', async () => {
    const f = fixture();
    expect(await f.store.tryPopulateFromS3UTxOs(f.handlers)).toEqual({ id: snapshot().hash, slot: 20 });
    expect(f.db.get(getApiIndexKey(IndexNames.UTXO, 'test#0'))).toMatchObject({ id: 'test#0', lovelace: '100' });
    expect(f.db.has(getApiIndexKey(IndexNames.UTXO, 'original#0'))).toBe(false);
    expect(f.db.get(getApiScannerLeaseKey())).toBe('scanner-original');
    expect(f.db.get(getApiScannerRecoveryKey())).toBe('recovery-original');
    expect(f.db.get(getApiMetricsKey())).toMatchObject({ currentSlot: '20', currentBlockHash: snapshot().hash });
    expect(f.db.has(progressKey)).toBe(false);
});
