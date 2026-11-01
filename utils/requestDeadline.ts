/** A caller's work budget, not an upstream/provider failure. */
export class RequestDeadlineError extends Error {
    public readonly code = 'REQUEST_DEADLINE_EXCEEDED' as const;

    constructor(message = 'Request work deadline exceeded') {
        super(message);
        this.name = 'RequestDeadlineError';
    }
}

// Jest isolation and separately bundled entrypoints do not share class identity.
export const isRequestDeadlineError = (error: unknown): error is RequestDeadlineError =>
    !!error && typeof error === 'object' && (error as { code?: unknown }).code === 'REQUEST_DEADLINE_EXCEEDED';
