import { RedisHandlesStore } from '../stores/redis';
import { localKoiosRepair, localRepair } from '../utils/localRepair';
import { Internal } from '../lambdas/scanner.app';
import { IndexNames } from '@koralabs/kora-labs-common';
import { getApiIndexKey } from '../stores/redis/keys';

// Child used only by the isolated-Valkey integration test: die without cleanup after the first write.
const run = async () => {
    const fixture = JSON.parse(process.env.LOCAL_REPAIR_TEST_FIXTURE!);
    const store = new RedisHandlesStore();
    store.initialize();
    if (fixture.partialBatch) {
        const original = store.redisClientCall.bind(store);
        store.redisClientCall = ((method: string, ...args: any[]) => {
            const outputKey = getApiIndexKey(IndexNames.UTXO, fixture.outputs[0].id);
            if (method === 'batch' && JSON.stringify(args[0]).includes(outputKey)) {
                const batch = args[0] as any[];
                if (batch.length < 2) throw new Error('Expected multi-command repository batch');
                original('batch', batch.slice(0, Math.floor(batch.length / 2)));
                process.exit(87);
            }
            return original(method, ...args);
        }) as typeof store.redisClientCall;
    }
    const lease = { acquire: Internal.acquireScannerLease, renew: Internal.renewScannerLease, release: Internal.releaseScannerLease };
    if (fixture.koios) {
        const query = async (path: string) => {
            if (path === 'tip') return [fixture.koios.tip];
            if (path === 'asset_utxos') return [fixture.koios.row];
            if (path === 'tx_info') return [fixture.koios.tx];
            throw new Error(`Unexpected fixture endpoint: ${path}`);
        };
        await localKoiosRepair(store, lease, fixture.targets, { query, afterFirstWrite: () => process.exit(87) });
    } else {
        await localRepair(store, lease, fixture.targets, async () => fixture.outputs, fixture.complete ? undefined : () => process.exit(87));
        if (fixture.complete) process.exit(0);
    }
};
run().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exit(1); });
