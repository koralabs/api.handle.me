import '../tests/network-guard.cjs';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { GlideClient } from '@valkey/valkey-glide';
import harness from '../tests/valkey-harness.cjs';

// Invariant: existing and new default-user clients cannot write during a maintenance
// restriction, while a separately authenticated repair user can. Re-enabling the
// write category makes the negative-control writes unexpectedly succeed.
test('isolated ACL restriction excludes direct writers but not direct readers', async () => {
    if (process.env.API_TEST_VALKEY_RECEIPT) throw new Error('Requires an exclusively owned fixture');
    await harness.start();
    const options = harness.connectionOptions({ addresses: [{ host: '127.0.0.1', port: 6381 }], useTLS: false });
    const defaultClient = await GlideClient.createClient(options);
    const username = `repair-${randomUUID()}`;
    const password = randomBytes(32).toString('hex');
    const key = `{acl-repair:${randomUUID()}}:handle`;
    let repair, second;
    try {
        await defaultClient.hset(key, { utxo: 'original' });
        await defaultClient.customCommand(['ACL', 'SETUSER', username, 'reset', 'on', `>${password}`, '~*', '+@all']);
        repair = await GlideClient.createClient({ ...options, credentials: { username, password } });
        await defaultClient.customCommand(['MULTI']);
        await defaultClient.customCommand(['HSET', key, 'utxo', 'queued-before-restriction']);
        await repair.customCommand(['ACL', 'SETUSER', 'default', '-@write', '-@scripting', '-@admin', '-@dangerous', '+info']);
        await assert.rejects(defaultClient.customCommand(['EXEC']), /NOPERM|permission|EXECABORT/i);
        second = await GlideClient.createClient(options);
        await assert.rejects(defaultClient.hset(key, { utxo: 'forbidden' }), /NOPERM|permission/i);
        await assert.rejects(second.customCommand(['EVAL', "return redis.call('HSET', KEYS[1], 'utxo', 'forbidden')", '1', key]), /NOPERM|permission/i);
        await assert.rejects(second.del([key]), /NOPERM|permission/i);
        assert.equal(await repair.hget(key, 'utxo'), 'original');
        await repair.hset(key, { utxo: 'partial' });
        // Reader access remains possible: writer ACLs alone do not provide a consistent view.
        assert.equal(await second.hget(key, 'utxo'), 'partial');
        await repair.hset(key, { utxo: 'complete' });
        await repair.customCommand(['ACL', 'SETUSER', 'default', '+@all']);
        await defaultClient.hset(key, { utxo: 'after-maintenance' });
        assert.equal(await repair.hget(key, 'utxo'), 'after-maintenance');

        // Disabling the only ordinary identity and disconnecting existing sessions
        // excludes both readers and writers, but takes all default-user apps offline.
        await repair.customCommand(['ACL', 'SETUSER', 'default', 'off']);
        const killed = await repair.customCommand(['CLIENT', 'KILL', 'USER', 'default']);
        assert.ok(Number(killed) >= 2);
        await assert.rejects(GlideClient.createClient(options), /AUTH|auth|disabled|wrongpass|connection/i);
        assert.equal(await repair.hget(key, 'utxo'), 'after-maintenance');
        await repair.customCommand(['ACL', 'SETUSER', 'default', 'on']);
        const resumed = await GlideClient.createClient(options);
        try { assert.equal(await resumed.hget(key, 'utxo'), 'after-maintenance'); }
        finally { resumed.close(); }
    } finally {
        if (repair) {
            await repair.customCommand(['ACL', 'SETUSER', 'default', 'on', '+@all']);
            await repair.del([key]);
            await repair.customCommand(['ACL', 'DELUSER', username]);
            repair.close();
        }
        second?.close();
        defaultClient.close();
        harness.stop();
    }
});

// A server started with an ACL file must remain closed across process restart,
// while a separately authenticated repair identity retains access. Without ACL
// SAVE, default access reopens and this test fails.
test('persisted ACL keeps the maintenance exclusion through service restart', async () => {
    if (process.env.API_TEST_VALKEY_RECEIPT) throw new Error('Requires an exclusively owned fixture');
    await harness.start();
    const fixture = harness.verify();
    const password = randomBytes(32).toString('hex');
    const run = (args, input = '') => execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', 'exec', '-i', fixture.containerId, ...args], { input, encoding: 'utf8', timeout: 15000 });
    const cli = input => run(['valkey-cli', '-h', '127.0.0.1', '-p', '6382', '--raw'], input);
    try {
        const acl = `user default on nopass ~* &* +@all\nuser repair on >${password} ~* &* +@all\n`;
        const config = 'bind 127.0.0.1\nport 6382\nprotected-mode no\ndaemonize yes\npidfile /data/acltest.pid\nlogfile /data/acltest.log\nsave ""\nappendonly no\naclfile /data/acltest.acl\n';
        run(['sh', '-c', 'umask 077; cat > /data/acltest.acl'], acl);
        run(['sh', '-c', 'umask 077; cat > /data/acltest.conf'], config);
        run(['valkey-server', '/data/acltest.conf']);
        assert.match(cli('PING\n'), /PONG/);
        assert.match(cli(`AUTH repair ${password}\nACL SETUSER default off\nACL SAVE\n`), /OK\nOK\nOK/);
        assert.match(cli('PING\n'), /NOAUTH|authentication/i);
        cli(`AUTH repair ${password}\nSHUTDOWN NOSAVE\n`);
        run(['valkey-server', '/data/acltest.conf']);
        assert.match(cli('PING\n'), /NOAUTH|authentication/i);
        assert.match(cli(`AUTH repair ${password}\nSET repair-probe retained\nGET repair-probe\n`), /OK\nOK\nretained/);
        assert.match(cli(`AUTH repair ${password}\nACL SETUSER default on\nACL SAVE\n`), /OK\nOK\nOK/);
        cli(`AUTH repair ${password}\nSHUTDOWN NOSAVE\n`);
        run(['valkey-server', '/data/acltest.conf']);
        assert.match(cli('PING\n'), /PONG/);
        cli('SHUTDOWN NOSAVE\n');
    } finally {
        harness.stop();
    }
});

// Runtime ACL changes do not survive the test server's restart without an ACL
// file. Assuming the temporary restriction survives makes this test fail.
test('restart reopens default access when ACL changes are not persisted', async () => {
    if (process.env.API_TEST_VALKEY_RECEIPT) throw new Error('Requires an exclusively owned fixture');
    await harness.start();
    const options = harness.connectionOptions({ addresses: [{ host: '127.0.0.1', port: 6381 }], useTLS: false });
    const initial = await GlideClient.createClient(options);
    const username = `repair-${randomUUID()}`;
    const password = randomBytes(32).toString('hex');
    const key = `{acl-restart:${randomUUID()}}:probe`;
    let repair;
    try {
        await initial.customCommand(['ACL', 'SETUSER', username, 'reset', 'on', `>${password}`, '~*', '+@all']);
        repair = await GlideClient.createClient({ ...options, credentials: { username, password } });
        await repair.customCommand(['ACL', 'SETUSER', 'default', 'off']);
        await repair.customCommand(['CLIENT', 'KILL', 'USER', 'default']);
        await assert.rejects(GlideClient.createClient(options), /AUTH|auth|disabled|wrongpass|connection/i);
        const fixture = harness.verify();
        execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', 'restart', fixture.containerId], { stdio: 'pipe', timeout: 30000 });
        const reopened = await GlideClient.createClient(options);
        try {
            await reopened.set(key, 'writable-after-restart');
            assert.equal(await reopened.get(key), 'writable-after-restart');
            await reopened.del([key]);
        } finally { reopened.close(); }
    } finally {
        repair?.close();
        initial.close();
        harness.stop();
    }
});
