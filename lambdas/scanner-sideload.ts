import { hydrateKmsEnvironment } from '@koralabs/kora-labs-common';

// Standalone REIMPORT / REINDEX runner. The self-host box invokes this entrypoint in a one-off,
// memory/time-unconstrained container (see aws-exit/scanner_sideload.sh) so the heavy ops can exceed
// the fnserver's hard per-function caps (8192MB / 300s). The scheduled scanner DEFERS these
// (KORA_SCANNER_DEFER_IMPORTS); this is where they actually run, reusing runSideload in scanner.app.
//
// mode (argv[2] or SIDELOAD_MODE, default 'auto'): reimport | reindex | both | auto | detect
//   detect -> print {reimportNeeded,reindexNeeded} and exit 10 if either is pending (else 0), so a
//             deploy can branch on "is a sideload needed?" without running it.
const main = async () => {
    await hydrateKmsEnvironment();
    const { runSideload } = await import('./scanner.app');
    const mode = (process.argv[2] || process.env.SIDELOAD_MODE || 'auto') as any;
    const result = await runSideload(mode);
    console.log(JSON.stringify(result));
    if (mode === 'detect') {
        process.exit(result.reimportNeeded || result.reindexNeeded ? 10 : 0);
    }
    process.exit(0);
};

main().catch((error: any) => {
    console.error(error?.message || error);
    process.exit(1);
});
