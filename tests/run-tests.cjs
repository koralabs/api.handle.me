'use strict';
require('./network-setup.cjs');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const mode = process.argv[2];
const forwarded = process.argv.slice(3);
const configs = { unit: 'jest.config.ts', e2e: 'jest.e2e.config.ts', critical: 'jest.critical.config.ts' };
async function run() {
    process.env.API_TEST_MODE = mode === 'unit' || mode === 'guard' ? 'unit' : 'integration';
    process.env.UTXO_SCHEMA_VERSION ||= '1';
    process.env.INDEX_SCHEMA_VERSION ||= '1';
    let args;
    if (configs[mode]) {
        args = [path.resolve('node_modules/jest/bin/jest.js'), '-c', configs[mode], '--runInBand', ...forwarded];
        if (mode !== 'unit') args.push('--forceExit');
    } else if (mode === 'native' || mode === 'harness') {
        args = ['--test', mode === 'native' ? 'workers/snapshotTransactions.node-test.mjs' : 'tests/valkey-harness.node-test.mjs', ...forwarded];
    } else if (mode === 'guard') {
        args = ['--test', 'tests/network-guard.node-test.mjs', ...forwarded];
    } else throw new Error(`Unknown test profile: ${mode}`);
    const fixture = process.env.API_TEST_MODE === 'integration' ? require('./valkey-harness.cjs') : undefined;
    try {
        if (fixture) {
            Object.assign(process.env, { REDIS_HOST: '127.0.0.1', REDIS_PORT: '6380', REDIS_USE_TLS: 'false', NETWORK: 'preview' });
            await fixture.start();
        }
        const result = spawnSync(process.execPath, args, { stdio: 'inherit', env: process.env });
        if (result.error) throw result.error;
        process.exitCode = result.status ?? 1;
    } finally {
        // Jest global teardown may already have removed the same owned receipt.
        if (fixture && process.env.API_TEST_VALKEY_RECEIPT) {
            const fs = require('node:fs');
            if (fs.existsSync(process.env.API_TEST_VALKEY_RECEIPT)) fixture.stop();
        }
    }
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
