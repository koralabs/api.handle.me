import { run } from './handle-audit-runner';

run().catch((e) => { console.error(e); process.exitCode = 1; });
