export const SCANNER_MAX_WORK_MS = 12 * 60_000;
const FN_TIMEOUT_MS = 300_000;
const CLEANUP_RESERVE_MS = 60_000;

/** Leave time for root rebuilding and lease cleanup before the runtime ends the invocation. */
export const scannerBudgetMs = (remainingTimeMs: number | undefined, deferImports: boolean): number => {
    const runtimeRemaining = Math.min(remainingTimeMs ?? Infinity, deferImports ? FN_TIMEOUT_MS : Infinity);
    return Math.max(0, Math.min(SCANNER_MAX_WORK_MS, runtimeRemaining - CLEANUP_RESERVE_MS));
};
