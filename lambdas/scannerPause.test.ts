import { Logger } from '@koralabs/kora-labs-common';
import { COVERAGE_PAUSE_WARN_AFTER, reportCoveragePause, resetCoveragePauseForTest } from './scannerPause';

// Invariant: a block Koios simply has not indexed yet (a few paused invocations) raises no alert; a block that stays
// paused does. Failure caught: every tip-lag pause was a WARN (1,000+ occurrences/14 days) hiding real stalls.
// Negative control: logging WARN on every pause fails the quiet assertions.
describe('scanner coverage pause alerting', () => {
    const EVENT = 'scannerLambda.koiosTxInfo.coverageIncompletePause';
    let warn: jest.SpyInstance;
    let local: jest.SpyInstance;
    beforeEach(() => {
        resetCoveragePauseForTest();
        warn = jest.spyOn(Logger, 'log').mockImplementation(() => undefined as never);
        local = jest.spyOn(Logger, 'local').mockImplementation(() => undefined as never);
    });
    afterEach(() => jest.restoreAllMocks());

    it('stays quiet while a block is paused briefly, then warns once it stays paused', () => {
        for (let i = 1; i < COVERAGE_PAUSE_WARN_AFTER; i++) reportCoveragePause(EVENT, 'aa', 'm');
        expect(warn).not.toHaveBeenCalled();
        expect(local).toHaveBeenCalledTimes(COVERAGE_PAUSE_WARN_AFTER - 1);
        reportCoveragePause(EVENT, 'aa', 'm');
        expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: EVENT, category: 'WARN' }));
    });

    it('restarts the count when the scan moves to a different block', () => {
        for (let i = 1; i < COVERAGE_PAUSE_WARN_AFTER; i++) reportCoveragePause(EVENT, 'aa', 'm');
        reportCoveragePause(EVENT, 'bb', 'm');
        expect(warn).not.toHaveBeenCalled();
    });
});
