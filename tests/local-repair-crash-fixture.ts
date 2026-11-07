import { RedisHandlesStore } from '../stores/redis';
import { localKoiosRepair, localRepair } from '../utils/localRepair';
import { Internal } from '../lambdas/scanner.app';

// Child used only by the isolated-Valkey integration test: die without cleanup after the first write.
const run = async () => {
    const fixture = JSON.parse(process.env.LOCAL_REPAIR_TEST_FIXTURE!);
    const store = new RedisHandlesStore();
    store.initialize();
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
        await localRepair(store, lease, fixture.targets, async () => fixture.outputs, () => process.exit(87));
    }
};
run().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exit(1); });
