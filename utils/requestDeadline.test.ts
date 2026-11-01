import type * as Deadline from './requestDeadline';

// Invariant: independently bundled/Jest-isolated deadline subclasses keep their typed signal.
// Failure: instanceof-only checks misclassify a budget exit as an upstream provider failure.
// Negative control: replacing the structural guard with instanceof fails the cross-context assertion.
it('recognizes a deadline across module identities but not an ordinary lookalike name', () => {
    let first!: typeof Deadline;
    let second!: typeof Deadline;
    jest.isolateModules(() => { first = require('./requestDeadline'); });
    jest.isolateModules(() => { second = require('./requestDeadline'); });
    class ScannerDeadline extends first.RequestDeadlineError {}
    const error = new ScannerDeadline('actual scanner work budget');
    expect(error instanceof second.RequestDeadlineError).toBe(false);
    expect(error.code).toBe('REQUEST_DEADLINE_EXCEEDED');
    expect(second.isRequestDeadlineError(error)).toBe(true);
    expect(second.isRequestDeadlineError(Object.assign(new Error('not a typed signal'), { name: 'ScannerDeadlineError' }))).toBe(false);
    expect(second.isRequestDeadlineError(null)).toBe(false);
});
