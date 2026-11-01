import { scannerBudgetMs } from './scannerBudget';

// Invariant: scheduled work stops before runtime termination, reserving root/lock cleanup time.
// Failure caught: the former fixed 12-minute deadline outlived Fn's 300-second cap.
// Negative control: returning 720_000 unconditionally breaks the Fn and short-context cases.
describe('scanner invocation work budget', () => {
    it('leaves a minute inside the 300-second Fn cap when the bridge has no remaining-time API', () => {
        expect(scannerBudgetMs(undefined, true)).toBe(240_000);
    });

    it('cannot exceed the Fn cap even when a context advertises a longer invocation', () => {
        expect(scannerBudgetMs(900_000, true)).toBe(240_000);
    });

    it('respects a shorter remaining lifetime', () => {
        expect(scannerBudgetMs(90_000, true)).toBe(30_000);
        expect(scannerBudgetMs(90_000, false)).toBe(30_000);
    });

    it('does not admit work when only the cleanup reserve remains', () => {
        expect(scannerBudgetMs(60_000, true)).toBe(0);
        expect(scannerBudgetMs(1_000, false)).toBe(0);
    });

    it('preserves the existing twelve-minute maximum outside scheduled Fn scans', () => {
        expect(scannerBudgetMs(undefined, false)).toBe(720_000);
        expect(scannerBudgetMs(900_000, false)).toBe(720_000);
    });
});
