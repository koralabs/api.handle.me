import { Trie } from '@aiken-lang/merkle-patricia-forestry';
import Redis from 'ioredis';
import { handler } from './valkeyutility';

// Runs against the repo-owned test Valkey (tests/valkey-harness.cjs, 127.0.0.1:6380).
// Every case uses its own logical databases so it can never touch the keys other suites seed in db 0.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const harness = require('../tests/valkey-harness.cjs');

const SOURCE_DB = 7;
const TARGET_DB = 8;
const UTXO = `${'ab'.repeat(32)}#1`;

describe('valkeyutility operational lambda against real Valkey', () => {
    let password: string;
    let source: Redis;
    let target: Redis;
    const conn = (db = SOURCE_DB) => ({
        sourceHost: '127.0.0.1', sourcePort: 6380, sourcePassword: password, sourceTls: false, sourceDb: db,
        targetHost: '127.0.0.1', targetPort: 6380, targetPassword: password, targetTls: false, targetDb: db
    });

    beforeAll(async () => {
        if (process.env.REDIS_PORT !== '6380') throw new Error('valkeyutility integration tests require test Valkey port 6380');
        password = harness.verify().password;
        source = new Redis({ host: '127.0.0.1', port: 6380, password, db: SOURCE_DB });
        target = new Redis({ host: '127.0.0.1', port: 6380, password, db: TARGET_DB });
    });

    beforeEach(async () => {
        await source.flushdb();
        await target.flushdb();
    });

    afterAll(async () => {
        await source.flushdb();
        await target.flushdb();
        source.disconnect();
        target.disconnect();
    });

    it('refuses to run any mutating action without an explicit, allowed network and leaves data untouched', async () => {
        await source.hset('{api:mainnet}:metrics', { currentSlot: '123', lockLambdas: '' });

        const missing = await handler({ action: 'reset_scanner', ...conn() });
        const unknown = await handler({ action: 'reset_scanner', network: 'testnet', ...conn() });

        expect(missing).toEqual({ action: 'reset_scanner', error: expect.stringMatching(/^network is required/) });
        expect(unknown.error).toBe('network="testnet" is not allowed; expected one of mainnet, preprod, preview');
        expect(await source.hgetall('{api:mainnet}:metrics')).toEqual({ currentSlot: '123', lockLambdas: '' });
    });

    it('copy_namespace on one server maps legacy keys into the network tag; dry run writes nothing', async () => {
        await source.set('{root}:alpha', 'A');
        await source.sadd('{root}:handle', 'x', 'y');
        await source.hset('metrics', 'currentSlot', '42');
        await source.set('unrelated', 'keep');

        const dry = await handler({ action: 'copy_namespace', network: 'preprod', dryRun: 'true', sourceMode: 'legacy_only', ...conn() });
        expect(dry).toMatchObject({ useServerCopy: true, sourceKeys: 3, copied: 3, skipped: 0, dryRun: true });
        expect(await source.exists('{api:preprod}:alpha', '{api:preprod}:handle', '{api:preprod}:metrics')).toBe(0);

        const real = await handler({ action: 'copy_namespace', network: 'preprod', sourceMode: 'legacy_only', ...conn() });
        expect(real).toMatchObject({ copied: 3, missing: 0, byType: { string: 1, set: 1, hash: 1 } });
        expect(await source.get('{api:preprod}:alpha')).toBe('A');
        expect((await source.smembers('{api:preprod}:handle')).sort()).toEqual(['x', 'y']);
        expect(await source.hget('{api:preprod}:metrics', 'currentSlot')).toBe('42');
        // copy leaves the source intact and ignores keys outside the prefix
        expect(await source.get('{root}:alpha')).toBe('A');
        expect(await source.exists('{api:preprod}:unrelated')).toBe(0);
    });

    it('copy_namespace across databases uses DUMP/RESTORE and preserves the key TTL', async () => {
        await source.set('{root}:ttl', 'v', 'PX', 600_000);
        await source.set('{api:preview}:already', 'n');

        const result = await handler({ action: 'copy_namespace', network: 'preview', sourceMode: 'all', ...conn(), targetDb: TARGET_DB });

        expect(result).toMatchObject({ useServerCopy: false, sourceKeys: 2, copied: 2, byType: { string: 2 } });
        expect(await target.get('{api:preview}:ttl')).toBe('v');
        expect(await target.get('{api:preview}:already')).toBe('n');
        const ttl = await target.pttl('{api:preview}:ttl');
        expect(ttl).toBeGreaterThan(500_000);
        expect(ttl).toBeLessThanOrEqual(600_000);
    });

    it('rename_namespace moves keys (overwriting stale targets) and refuses two different servers', async () => {
        await source.set('{root}:a', 'new');
        await source.set('{api:preprod}:a', 'stale');

        const refused = await handler({ action: 'rename_namespace', network: 'preprod', ...conn(), targetDb: TARGET_DB });
        expect(refused.error).toMatch(/same redis target/);

        const dry = await handler({ action: 'rename_namespace', network: 'preprod', dryRun: true, ...conn() });
        expect(dry).toMatchObject({ renamed: 1, dryRun: true });
        expect(await source.get('{root}:a')).toBe('new');

        const real = await handler({ action: 'rename_namespace', network: 'preprod', ...conn() });
        expect(real).toMatchObject({ renamed: 1, missing: 0, byType: { string: 1 } });
        expect(await source.exists('{root}:a')).toBe(0);
        expect(await source.get('{api:preprod}:a')).toBe('new');
    });

    it('delete_namespace removes only the selected namespace and honours dry run', async () => {
        await source.set('{api:preprod}:a', '1');
        await source.hset('{api:preprod}:b', 'f', '1');
        await source.set('{api:preview}:a', 'other-network');

        const dry = await handler({ action: 'delete_namespace', network: 'preprod', sourceMode: 'namespaced_only', dryRun: true, ...conn() });
        expect(dry).toMatchObject({ deleted: 2, sample: ['{api:preprod}:a', '{api:preprod}:b'] });
        expect(await source.dbsize()).toBe(3);

        const real = await handler({ action: 'delete_namespace', network: 'preprod', sourceMode: 'namespaced_only', ...conn() });
        expect(real).toMatchObject({ deleted: 2, missing: 0, byType: { string: 1, hash: 1 } });
        expect(await source.keys('*')).toEqual(['{api:preview}:a']);
    });

    it('set_checkpoint and add_mint_data validate input and write the exact records', async () => {
        expect((await handler({ action: 'set_checkpoint', network: 'preview', ...conn() })).error).toMatch(/checkpointBlockHash is required/);
        expect((await handler({ action: 'set_checkpoint', network: 'preview', checkpointBlockHash: 'h', checkpointSlot: 'x', ...conn() })).error).toMatch(/checkpointSlot is required/);
        expect((await handler({ action: 'add_mint_data', network: 'preview', handleName: 'a', createdSlot: 5, ...conn() })).error).toMatch(/txHash is required/);

        await handler({ action: 'set_checkpoint', network: 'preview', checkpointBlockHash: 'beef', checkpointSlot: '77', ...conn() });
        await handler({ action: 'add_mint_data', network: 'preview', handleName: 'goose', createdSlot: '9', txHash: 'tx1', ...conn() });

        expect(await source.hgetall('{api:preview}:metrics')).toEqual({ currentBlockHash: 'beef', currentSlot: '77' });
        expect(await source.smembers('{api:preview}:mint:goose')).toEqual([JSON.stringify({ created_slot: 9, txHash: 'tx1' })]);
        const metrics = await handler({ network: 'preview', ...conn() });
        expect(metrics).toEqual({ command: 'hgetall', network: 'preview', args: ['{api:preview}:metrics'], result: { currentBlockHash: 'beef', currentSlot: '77' } });
    });

    it('seed_mpt_root hashes the handle set plus network ghosts; an empty set yields the zero root', async () => {
        await source.sadd('{api:preview}:handle', 'b', 'a');
        const expected = new Trie();
        for (const name of ['a', 'b', 'dynamo2@ai']) await expected.insert(name, '');

        const seeded = await handler({ action: 'seed_mpt_root', network: 'preview', ...conn() });
        const empty = await handler({ action: 'seed_mpt_root', network: 'preprod', ...conn() });

        expect(seeded).toMatchObject({ handleCount: 2, ghostCount: 1, totalTrieEntries: 3, mptRootHash: expected.hash.toString('hex') });
        expect(await source.get('{api:preview}:mpt_root_hash')).toBe(expected.hash.toString('hex'));
        expect(await source.get('{api:preprod}:mpt_root_hash')).toBe('00'.repeat(32));
        expect(empty).toMatchObject({ handleCount: 0, ghostCount: 0, totalTrieEntries: 0 });
    });

    it('scripts_with_cbor and update_script_types only touch handles with a parseable script cbor', async () => {
        await source.sadd('{api:preview}:handle', 'has', 'none', 'bad');
        await source.hset('{api:preview}:handle:has', { name: 'has', hex: '00', policy: 'p', utxo: 'u#0', script: JSON.stringify({ type: 'plutus_v2', cbor: 'c0' }) });
        await source.hset('{api:preview}:handle:none', { name: 'none' });
        await source.hset('{api:preview}:handle:bad', { name: 'bad', script: '{not json' });

        const listed = await handler({ action: 'scripts_with_cbor', network: 'preview', ...conn() });
        expect(listed).toMatchObject({ total: 3, withScript: 1, handles: [{ name: 'has', hex: '00', policy: 'p', utxo: 'u#0', type: 'plutus_v2', cbor: 'c0' }] });

        const updates = [{ name: 'has', type: 'plutus_v3' }, { name: 'none', type: 'x' }, { name: 'bad', type: 'x' }, { name: '', type: 'x' }];
        const dry = await handler({ action: 'update_script_types', network: 'preview', dryRun: true, updates, ...conn() });
        expect(dry).toMatchObject({ updated: 1, missing: 1, invalid: 2 });
        expect(JSON.parse((await source.hget('{api:preview}:handle:has', 'script'))!).type).toBe('plutus_v2');

        const real = await handler({ action: 'update_script_types', network: 'preview', updates, ...conn() });
        expect(real).toMatchObject({ updated: 1, unchanged: 0 });
        expect(JSON.parse((await source.hget('{api:preview}:handle:has', 'script'))!)).toEqual({ type: 'plutus_v3', cbor: 'c0' });
        // the scanner lease it took is released afterwards
        expect(await source.exists('{api:preview}:scanner:lease')).toBe(0);

        const again = await handler({ action: 'update_script_types', network: 'preview', updates: [{ name: 'has', type: 'plutus_v3' }], ...conn() });
        expect(again).toMatchObject({ updated: 0, unchanged: 1 });
    });

    it('lease-gated writes refuse while the scanner holds the lease and never release a lease they do not own', async () => {
        await source.hset('{api:preview}:handle:has', { script: JSON.stringify({ type: 'a', cbor: 'c0' }) });
        await source.set('{api:preview}:scanner:lease', 'scanner-owner', 'PX', 60_000);

        const blocked = await handler({ action: 'update_script_types', network: 'preview', updates: [{ name: 'has', type: 'b' }], ...conn() });
        const blockedRepoint = await handler({ action: 'repoint_subhandle_settings', network: 'preview', subhandleSettingsUpdates: [{ name: 'has', utxoId: UTXO }], ...conn() });

        expect(blocked.error).toMatch(/Scanner lease held/);
        expect(blockedRepoint.error).toMatch(/Scanner lease held/);
        expect(await source.get('{api:preview}:scanner:lease')).toBe('scanner-owner');
        expect(JSON.parse((await source.hget('{api:preview}:handle:has', 'script'))!).type).toBe('a');
    });

    it('repoint_subhandle_settings only re-points to a UTxO that exists in the store', async () => {
        await source.hset('{api:preview}:handle:root', 'subhandle_settings', JSON.stringify({ utxo_id: 'old#0', price: 5 }));
        await source.hset('{api:preview}:handle:nofield', 'name', 'nofield');
        const missingUtxo = `${'cd'.repeat(32)}#0`;

        const result = await handler({
            action: 'repoint_subhandle_settings', network: 'preview', ...conn(),
            subhandleSettingsUpdates: [
                { name: 'root', utxoId: missingUtxo },
                { name: 'root', utxoId: 'not-a-utxo' },
                { name: 'nofield', utxoId: UTXO }
            ]
        });
        expect(result).toMatchObject({ updated: 0, missing: 2, invalid: 1 });
        expect(JSON.parse((await source.hget('{api:preview}:handle:root', 'subhandle_settings'))!).utxo_id).toBe('old#0');

        await source.hset(`{api:preview}:utxo:${UTXO}`, 'id', UTXO);
        const repointed = await handler({ action: 'repoint_subhandle_settings', network: 'preview', subhandleSettingsUpdates: [{ name: 'root', utxoId: UTXO }], ...conn() });
        expect(repointed.results).toEqual([{ name: 'root', status: 'updated', from: 'old#0', to: UTXO }]);
        expect(JSON.parse((await source.hget('{api:preview}:handle:root', 'subhandle_settings'))!)).toEqual({ utxo_id: UTXO, price: 5 });
        expect(await source.exists('{api:preview}:scanner:lease')).toBe(0);
    });

    it('debug actions read, diff and delete exactly the requested keys', async () => {
        await source.hset('h', { a: '1', b: '2', c: '3' });
        await source.set('s', 'v');
        await source.sadd('A', '1', '2', '3');
        await source.sadd('B', '2');

        expect(await handler({ action: 'hgetall', key: 'h', ...conn() })).toEqual({ key: 'h', result: { a: '1', b: '2', c: '3' } });
        expect(await handler({ action: 'get', key: 's', ...conn() })).toEqual({ key: 's', result: 'v' });
        expect(await handler({ action: 'scard', key: 'A', ...conn() })).toEqual({ key: 'A', count: 3 });
        expect(await handler({ action: 'hdel', key: 'h', ...conn() })).toEqual({ error: 'hdel requires `key` and `field` (string or string[])' });
        expect(await handler({ action: 'hdel', key: 'h', field: ['a', 'zz'], ...conn() })).toEqual({ key: 'h', fields: ['a', 'zz'], removed: 1, before: ['1', null] });
        expect(await source.hgetall('h')).toEqual({ b: '2', c: '3' });
        expect(await handler({ action: 'sdiff_count', keyA: 'A', keyB: 'B', ...conn() })).toMatchObject({ aCount: 3, bCount: 1, onlyInACount: 2 });
        expect(await handler({ action: 'smembers_diff', keyA: 'A', expected: ['1', '9'], ...conn() }))
            .toEqual({ redis: 3, expected: 2, inApiNotExpected: ['2', '3'], inExpectedNotApi: ['9'] });
        expect(await handler({ action: 'del', key: 's', ...conn() })).toEqual({ key: 's', deleted: 1 });
        expect(await source.exists('s')).toBe(0);
    });

    it('reset_scanner locks lambdas and clears loader progress; trigger_reindex sets the recovery flag', async () => {
        await source.hset('{api:preview}:metrics', { currentSlot: '500', currentBlockHash: 'abc', lockLambdas: '' });
        await source.set('{api:preview}:snapshot_loader:progress', '12');
        await source.set('{api:preview}:mpt_root_hash', 'r00t');

        const reset = await handler({ action: 'reset_scanner', network: 'preview', ...conn() });
        const reindex = await handler({ action: 'trigger_reindex', network: 'preview', ...conn() });
        const status = await handler({ action: 'get' as any, key: '{api:preview}:scanner:recovery', ...conn() });

        expect(reset).toMatchObject({ progressDeleted: 1, after: { currentSlot: '0', currentBlockHash: '', lockLambdas: 'UTXO_IMPORT' } });
        expect(await source.exists('{api:preview}:snapshot_loader:progress')).toBe(0);
        expect(reindex).toMatchObject({ before: null, after: 'reindex' });
        expect(status).toEqual({ key: '{api:preview}:scanner:recovery', result: 'reindex' });
    });
});
