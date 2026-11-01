import { type ALBEvent, type Context } from 'aws-lambda';
import { LockedLambdaReason, type UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import { performance } from 'node:perf_hooks';
import { getApiScannerLeaseKey } from '../stores/redis/keys';
import { buildAndStoreMptRootHash } from '../utils/snapshotVerification';
import { HandlesRepository } from '../repositories/handlesRepository';
import { RedisHandlesStore } from '../stores/redis';
import * as helpers from '../utils/helpers';

// Local-only integration: real entrypoint, provider helpers, persisted cursor and
// token lease. Only HTTP and clock boundaries are controlled. Never touch 6379.
if (process.env.REDIS_HOST !== '127.0.0.1' || process.env.REDIS_PORT !== '6380') {
    throw new Error('Scanner budget integration requires isolated loopback Valkey 6380');
}
const store = new RedisHandlesStore();
const repo = new HandlesRepository(store);
const runtime = { handler: require('./scanner').lambdaHandler as typeof import('./scanner.app').lambdaHandler,
    helpers, repo, store, unlocked: LockedLambdaReason.UNLOCKED };
let testEpoch = 1_000_000;
beforeAll(async () => {
    await repo.initialize();
    require('./scanner.app');
});
afterAll(() => repo.destroy());
const loadRuntime = async () => {
    repo.rollBackToGenesis();
    repo.setMetrics({
        currentSlot: 140, lastSlot: 1000, currentBlockHash: 'budget-anchor', tipBlockHash: 'budget-tip',
        utxoSchemaVersion: Number(store.getUTxOSchemaVersion()),
        indexSchemaVersion: Number(store.getIndexSchemaVersion()), lockLambdas: runtime.unlocked
    });
    return runtime;
};

type RequestRecord = { path: string; at: number };
const clockBoundary = (clock: { now: number }, longSleeps: number[] = []) => {
    jest.spyOn(Date, 'now').mockImplementation(() => clock.now);
    const realTimeout = global.setTimeout;
    jest.spyOn(global, 'setTimeout').mockImplementation(((callback: (...args: unknown[]) => void, delay = 0, ...args: unknown[]) => {
        if (delay >= 300_000) longSleeps.push(delay);
        // Advance the clock when a timer actually fires, including normal paging
        // waits; a frozen clock would correctly keep the shared gate waiting forever.
        return realTimeout(() => { clock.now += delay; callback(...args); },
            delay <= 2000 || delay >= 300_000 ? 0 : delay);
    }) as typeof setTimeout);
};
const providerBoundary = (clock: { now: number }, requests: RequestRecord[], expireAt?: 'block_txs' | 'tx_info') =>
    jest.spyOn(global, 'fetch').mockImplementation(async (input) => {
        const url = new URL(String(input));
        requests.push({ path: url.pathname, at: clock.now });
        let data: unknown;
        if (url.hostname.endsWith('.blockfrost.io')) {
            if (url.pathname === '/api/v0/blocks/latest') data = { height: 5000, slot: 1000, hash: 'budget-tip' };
            else if (url.pathname === '/api/v0/blocks/budget-anchor/next') {
                data = [{ hash: 'budget-block', slot: 201, confirmations: 21, tx_count: expireAt ? 1 : 0 }];
            } else if (url.pathname === '/api/v0/blocks/budget-block/next') data = [];
            // These valid responses expose an incorrect post-deadline fallback;
            // the test must fail on the extra HTTP, not on malformed fixtures.
            else if (url.pathname === '/api/v0/blocks/budget-block/txs') data = [];
            else if (url.pathname === '/api/v0/txs/budget-tx') data = { block: 'budget-block', slot: 201, block_height: 5000, asset_mint_or_burn_count: 0 };
            else if (url.pathname === '/api/v0/txs/budget-tx/utxos') data = { inputs: [], outputs: [] };
            else if (url.pathname === '/api/v0/scripts/datum/budget-datum/cbor') data = { cbor: 'd87980' };
        } else if (url.hostname.endsWith('.koios.rest')) {
            const endpoint = url.pathname.split('/').at(-1);
            if (endpoint === 'tip') return new Response('[]', { status: 429, headers: { 'Retry-After': '3600' } });
            if (endpoint === 'block_txs') data = expireAt ? [{ block_hash: 'budget-block', tx_hash: 'budget-tx' }] : [];
            if (endpoint === 'tx_info') data = [{ tx_hash: 'budget-tx', block_hash: 'budget-block', absolute_slot: 201,
                inputs: [], reference_inputs: [], outputs: [{ tx_index: 0, datum_hash: 'budget-datum', inline_datum: null,
                    payment_addr: { bech32: '', cred: '' }, asset_list: [], value: '1000000' }], metadata: {}, assets_minted: [] }];
            if (endpoint === 'datum_info' || endpoint === 'asset_utxos') data = [];
            if (endpoint === expireAt) clock.now += 240_001;
        }
        if (data === undefined) throw new Error(`Unexpected integration HTTP request: ${url.origin}${url.pathname}`);
        return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
    });

const assertResumable = (runtime: Awaited<ReturnType<typeof loadRuntime>>) => {
    expect(runtime.repo.getMetrics()).toEqual(expect.objectContaining({
        currentSlot: 140, currentBlockHash: 'budget-anchor', lockLambdas: runtime.unlocked
    }));
    expect([...runtime.store.getScannedBlockHashesInRange(201, 201)]).toEqual([]);
};

const originalDefer = process.env.KORA_SCANNER_DEFER_IMPORTS;
const originalSource = process.env.SCANNER_CHAIN_SOURCE;
const originalKmsDisabled = process.env.KORA_KMS_DISABLED;
const clearFixtureLease = () => {
    const owner = store.redisClientCall('get', getApiScannerLeaseKey());
    if (typeof owner === 'string') require('./scanner.app').Internal.releaseScannerLease(owner);
};
beforeEach(() => {
    // Advance monotonically past prior test holds; never reset the transport's floor.
    testEpoch += 10_000_000;
    process.env.KORA_SCANNER_DEFER_IMPORTS = 'true';
    process.env.KORA_KMS_DISABLED = 'true';
    process.env.SCANNER_CHAIN_SOURCE = 'blockfrost';
    clearFixtureLease();
});
afterEach(() => {
    // Isolate a failed release negative control using the real token-conditional
    // helper. Every test asserts TTL/re-entry BEFORE this cleanup runs.
    clearFixtureLease();
    jest.restoreAllMocks();
    if (originalDefer === undefined) delete process.env.KORA_SCANNER_DEFER_IMPORTS;
    else process.env.KORA_SCANNER_DEFER_IMPORTS = originalDefer;
    if (originalSource === undefined) delete process.env.SCANNER_CHAIN_SOURCE;
    else process.env.SCANNER_CHAIN_SOURCE = originalSource;
    if (originalKmsDisabled === undefined) delete process.env.KORA_KMS_DISABLED;
    else process.env.KORA_KMS_DISABLED = originalKmsDisabled;
});

it('leaves an unadmittable provider hold without outliving Fn or clearing its floor, then resumes the same block', async () => {
    // Failure: the helper sleeps an hour inside a five-minute invocation.
    // Negative control: ignore the proposed admission time; elapsed exceeds Fn's cap.
    const runtime = await loadRuntime();
    const clock = { now: testEpoch };
    const start = clock.now;
    const longSleeps: number[] = [];
    clockBoundary(clock, longSleeps);
    const requests: RequestRecord[] = [];
    providerBoundary(clock, requests);
    try {
        await expect(runtime.helpers.fetchKoios('tip')).rejects.toMatchObject({ status: 429 });
        await runtime.handler({} as ALBEvent, {} as Context);
        expect(clock.now - start).toBeLessThan(300_000);
        expect(longSleeps).toEqual([]);
        assertResumable(runtime);
        await runtime.handler({} as ALBEvent, {} as Context);
        assertResumable(runtime);
        // Both invocations run immediately against Redis' real60s TTL. Removing
        // the outer release would skip the second before any provider work.
        expect(requests.filter((request) => request.path === '/api/v0/blocks/latest')).toHaveLength(2);
        expect(Number(runtime.store.redisClientCall('customCommand', ['PTTL', getApiScannerLeaseKey()]))).toBe(-2);
        expect(requests.filter((request) => request.path.startsWith('/api/v1/'))).toEqual([
            { path: '/api/v1/tip', at: start }
        ]);
        expect(requests.filter((request) => request.path.endsWith('/txs') || request.path.includes('/txs/'))).toEqual([]);
        clock.now = start + 3_600_000;
        await runtime.handler({} as ALBEvent, {} as Context);
        expect(runtime.repo.getMetrics()).toEqual(expect.objectContaining({
            currentSlot: 201, currentBlockHash: 'budget-block', lockLambdas: runtime.unlocked
        }));
        expect([...runtime.store.getScannedBlockHashesInRange(201, 201)]).toEqual(['budget-block']);
        const starts = requests.filter((request) => request.path === '/api/v1/block_txs').map((request) => request.at);
        expect(starts).toHaveLength(1);
        expect(starts[0]).toBeGreaterThanOrEqual(start + 3_600_000);
    } finally {
        jest.restoreAllMocks();
    }
});

it.each(['block_txs', 'tx_info'] as const)('propagates budget expiry after %s without starting new fallback HTTP or advancing the incomplete block', async (expireAt) => {
    // Failure: a deliberate deadline becomes fresh Blockfrost tx/datum work.
    // Negative control: consume deadline errors in the fallback wrappers; HTTP starts after expiry.
    const runtime = await loadRuntime();
    const clock = { now: testEpoch };
    const start = clock.now;
    clockBoundary(clock);
    const requests: RequestRecord[] = [];
    providerBoundary(clock, requests, expireAt);
    try {
        await runtime.handler({} as ALBEvent, {} as Context);
        expect(clock.now).toBeGreaterThanOrEqual(start + 240_001);
        expect(requests.filter((request) => request.at >= start + 240_000)).toEqual([]);
        assertResumable(runtime);
    } finally {
        jest.restoreAllMocks();
    }
});


const rollbackPolicy = 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a';
const rollbackAddress = 'addr_test1qzdzhdzf9ud8k2suzryvcdl78l3tfesnwp962vcuh99k8z834r3hjynmsy2cxpc04a6dkqxcsr29qfl7v9cmrd5mm89qfmc97q';
const prepareRollback = async () => {
    await loadRuntime();
    const names = Array.from({ length: 60 }, (_, i) => `rb${String(i).padStart(4, '0')}`);
    const assets = names.map(name => `000de140${Buffer.from(name).toString('hex')}`);
    const utxo: UTxOWithTxInfo = {
        id: 'rollback-budget-tx#0', tx_id: 'rollback-budget-tx', index: 0,
        blockHash: 'orphaned-budget-block', blockNum: 1, slot: 100,
        address: rollbackAddress, lovelace: 1_000_000,
        handles: [[rollbackPolicy, assets]], mint: [[rollbackPolicy, assets]], burn: [],
        metadata: { '721': { [rollbackPolicy]: Object.fromEntries(assets.map((hex, i) => [hex, {
            name: `$${names[i]}`, image: 'ipfs://budget-fixture', mediaType: 'image/png',
            og: 0, og_number: 0, rarity: 'basic', length: names[i].length,
            characters: 'letters,numbers', numeric_modifiers: '', version: 1
        }])) } }
    };
    repo.addUTxOsWithMintDataAndUpdateIndexes([utxo]);
    store.recordScannedBlock(100, 'orphaned-budget-block');
    const root = await buildAndStoreMptRootHash(store);
    expect(root).toMatch(/^[0-9a-f]{64}$/);
    const handles = names.map(name => repo.getHandle(name));
    expect(handles.map(handle => handle?.name)).toEqual(names);
    return { names, handles, root, utxo: repo.getUTxO(utxo.id) };
};
const assertRollbackUnchanged = (before: Awaited<ReturnType<typeof prepareRollback>>) => {
    expect(repo.getMetrics()).toEqual(expect.objectContaining({
        currentSlot: 140, currentBlockHash: 'budget-anchor', lockLambdas: LockedLambdaReason.UNLOCKED
    }));
    expect(before.names.map(name => repo.getHandle(name))).toEqual(before.handles);
    expect(repo.getUTxO('rollback-budget-tx#0')).toEqual(before.utxo);
    expect(store.getMptRootHash()).toBe(before.root);
    expect([...store.getScannedBlockHashesInRange(90, 140)]).toEqual(['orphaned-budget-block']);
};
const rollbackBoundary = (clock: { now: number }, asset: (at: number) => Promise<Response>) =>
    jest.spyOn(global, 'fetch').mockImplementation(async input => {
        const url = new URL(String(input));
        if (url.hostname.endsWith('.blockfrost.io')) {
            if (url.pathname === '/api/v0/blocks/latest') return new Response(JSON.stringify({ height: 5000, slot: 1000, hash: 'budget-tip' }));
            if (url.pathname === '/api/v0/blocks/budget-anchor/next') return new Response('[]');
            if (url.pathname === '/api/v0/blocks/2840/next') return new Response(JSON.stringify([
                { hash: 'canonical-budget-predecessor', slot: 90, confirmations: 20, tx_count: 0 },
                { hash: 'canonical-budget-head', slot: 140, confirmations: 19, tx_count: 0 }
            ]));
        }
        if (url.hostname.endsWith('.koios.rest') && url.pathname.endsWith('/asset_utxos')) return asset(clock.now);
        throw new Error(`Unexpected rollback integration request: ${url.origin}${url.pathname}`);
    });

it.each(['deadline', 'provider'] as const)('rollback %s stops queued assets, preserves state, and reacquires before lease TTL', async mode => {
    // Invariant: the actual rollback caller observes errors before the shared
    // helper's next turn, never starts queued HTTP, and releases its real lease.
    // Negative control: positive asyncForEach delay emits unhandled rejections
    // and/or starts every queued batch instead of exactly the failed first one.
    const before = await prepareRollback();
    const clock = { now: testEpoch };
    clockBoundary(clock);
    const starts: number[] = [];
    const unhandled: unknown[] = [];
    const onUnhandled = (error: unknown) => { unhandled.push(error); };
    process.on('unhandledRejection', onUnhandled);
    const fetch = rollbackBoundary(clock, async at => {
        starts.push(at);
        if (mode === 'deadline') clock.now += 240_001;
        return new Response(JSON.stringify({ message: 'asset fixture failure' }), { status: 400 });
    });
    const began = performance.now();
    try {
        await runtime.handler({} as ALBEvent, {} as Context);
        expect(starts).toHaveLength(1);
        assertRollbackUnchanged(before);
        expect(Number(store.redisClientCall('customCommand', ['PTTL', getApiScannerLeaseKey()]))).toBe(-2);
        const latest = () => fetch.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/api/v0/blocks/latest').length;
        expect(latest()).toBe(2);
        // No real60s elapse (Redis' clock is not the controlled JS clock).
        await runtime.handler({} as ALBEvent, {} as Context);
        expect(latest()).toBe(4);
        expect(starts).toHaveLength(2);
        assertRollbackUnchanged(before);
        expect(performance.now() - began).toBeLessThan(10_000);
        expect(unhandled).toEqual([]);
    } finally {
        process.removeListener('unhandledRejection', onUnhandled);
    }
});

it('rollback drains a started asset read before lease release while stopping later admissions', async () => {
    // Invariant: already-started work settles before outer cleanup; a first
    // failure cannot leave a background pool borrowing a later invocation.
    // Negative control: the old Promise.all attaches late/rejects early and
    // resolves the handler while this second real helper read is still held.
    const before = await prepareRollback();
    const clock = { now: testEpoch };
    const realTimeout = global.setTimeout;
    clockBoundary(clock);
    let failFirst!: (error: Error) => void;
    let finishSecond!: (response: Response) => void;
    let secondStarted!: () => void;
    const entered = new Promise<void>(resolve => { secondStarted = resolve; });
    const starts: number[] = [];
    const fetch = rollbackBoundary(clock, at => {
        starts.push(at);
        if (starts.length === 1) return new Promise<Response>((_resolve, reject) => { failFirst = reject; });
        if (starts.length === 2) {
            failFirst(new Error('first asset read failed'));
            secondStarted();
            return new Promise<Response>(resolve => { finishSecond = resolve; });
        }
        return Promise.reject(new Error('queued asset HTTP must not start'));
    });
    let delivered = false;
    const invocation = runtime.handler({} as ALBEvent, {} as Context).then(result => { delivered = true; return result; });
    try {
        await entered;
        await new Promise<void>(resolve => realTimeout(resolve, 100));
        expect(delivered).toBe(false);
        expect(starts).toHaveLength(2);
        expect(Number(store.redisClientCall('customCommand', ['PTTL', getApiScannerLeaseKey()]))).toBeGreaterThan(0);
    } finally {
        finishSecond(new Response('[]'));
        await invocation;
    }
    assertRollbackUnchanged(before);
    expect(Number(store.redisClientCall('customCommand', ['PTTL', getApiScannerLeaseKey()]))).toBe(-2);
    const latest = () => fetch.mock.calls.filter(([input]) => new URL(String(input)).pathname === '/api/v0/blocks/latest').length;
    expect(latest()).toBe(2);
    // A fresh immediate invocation is independently admitted, not TTL recovery.
    fetch.mockImplementation(async input => {
        if (new URL(String(input)).pathname.endsWith('/asset_utxos')) return new Response('{}', { status: 400 });
        const pathname = new URL(String(input)).pathname;
        if (pathname.endsWith('/blocks/latest')) return new Response(JSON.stringify({ height: 5000, slot: 1000, hash: 'budget-tip' }));
        if (pathname.endsWith('/blocks/budget-anchor/next')) return new Response('[]');
        return new Response(JSON.stringify([{ hash: 'canonical-budget-head', slot: 100, confirmations: 20, tx_count: 0 }]));
    });
    await runtime.handler({} as ALBEvent, {} as Context);
    expect(latest()).toBe(4);
    assertRollbackUnchanged(before);
});
