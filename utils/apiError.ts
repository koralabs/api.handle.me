import { HttpException } from '@koralabs/kora-labs-common';

export const DEFAULT_DOCS_URL = 'https://api.handle.me/';
export const HANDLE_HELP_URL = 'https://handle.me/$/faq#:~:text=What%20kind%20of%20characters%20can%20I%20use';

export class ApiError extends HttpException {
    public code: string;
    public docs: string;
    public headers?: Record<string, string>;

    constructor(status: number, code: string, message: string, docs: string = DEFAULT_DOCS_URL) {
        super(status, message);
        this.code = code;
        this.docs = docs;
    }

    public withHeaders(headers: Record<string, string>): ApiError {
        this.headers = { ...(this.headers ?? {}), ...headers };
        return this;
    }

    // The handle FAQ URL is reserved for "I tried a name and it doesn't exist /
    // isn't valid" cases — that's the page that answers both "what's a valid
    // handle?" and "where do I mint one?". 404s on adjacent artifacts (datum,
    // script, subhandle settings) point at the generic API docs instead, since
    // the FAQ wouldn't help an agent debug those.
    static handleNotFound(message = 'Handle not found'): ApiError {
        return new ApiError(404, 'handle_not_found', message, HANDLE_HELP_URL);
    }

    static handleNameInvalid(message = 'Handle not found'): ApiError {
        return new ApiError(404, 'handle_not_found', message, HANDLE_HELP_URL);
    }

    static datumNotFound(message = 'Handle datum not found'): ApiError {
        return new ApiError(404, 'handle_datum_not_found', message);
    }

    static datumDecodeFailed(message = 'Unable to decode datum to json'): ApiError {
        return new ApiError(400, 'datum_decode_failed', message);
    }

    static datumEndpointDisabled(): ApiError {
        return new ApiError(400, 'datum_endpoint_disabled', 'Datum endpoint is disabled');
    }

    static scriptNotFound(): ApiError {
        return new ApiError(404, 'script_not_found', 'Script not found');
    }

    static subhandleSettingsNotFound(): ApiError {
        return new ApiError(404, 'subhandle_settings_not_found', 'SubHandle settings not found');
    }

    static subhandleSettingsUtxoNotFound(): ApiError {
        return new ApiError(404, 'subhandle_settings_utxo_not_found', 'SubHandle settings UTxO not found');
    }

    static policiesNotFound(): ApiError {
        return new ApiError(404, 'policies_not_found', 'Handle policies not found');
    }

    static policiesDecodeFailed(): ApiError {
        return new ApiError(400, 'policies_decode_failed', 'Unable to decode handle policies datum to json');
    }

    static cborRequired(): ApiError {
        return new ApiError(400, 'cbor_required', 'cbor required');
    }

    static routeNotFound(path: string): ApiError {
        return new ApiError(404, 'route_not_found', `Route not found: ${path}`);
    }

    static methodNotAllowed(allowed: string[]): ApiError {
        return new ApiError(
            405,
            'method_not_allowed',
            `Method not allowed. Allowed methods: ${allowed.join(', ')}`
        ).withHeaders({ Allow: allowed.join(', ') });
    }

    static notAcceptable(supported: string[]): ApiError {
        return new ApiError(
            406,
            'not_acceptable',
            `No representation matches the Accept header. Supported: ${supported.join(', ')}`
        );
    }

    static rateLimited(): ApiError {
        return new ApiError(429, 'rate_limited', 'Too Many Requests');
    }

    static recordsPerPageTooLarge(limit: number): ApiError {
        return new ApiError(
            400,
            'records_per_page_too_large',
            `'records_per_page' must be ${limit} or less`
        );
    }

    static invalidListBody(message = 'expected array of strings'): ApiError {
        return new ApiError(400, 'bad_request', message);
    }

    static unknownQueryParams(unknown: string[]): ApiError {
        // Reject silently-ignored typos at the door — when an unknown filter
        // like `?holder=...` is dropped, callers see "results" that look
        // filtered but are actually the unfiltered head of the dataset,
        // which is the worst kind of wrong. List the offending keys so the
        // caller can fix them in one round trip.
        const keys = unknown.map((k) => `'${k}'`).join(', ');
        return new ApiError(
            400,
            'unknown_query_params',
            `Unknown query parameter${unknown.length === 1 ? '' : 's'}: ${keys}`
        );
    }

    static handleTypeUnsupportedForMint(): ApiError {
        return new ApiError(
            400,
            'handle_type_unsupported_for_mint',
            "handle_type: 'handle' is not supported for minting at this time."
        );
    }
}

export function statusCodeToErrorCode(status: number): string {
    if (status === 400) return 'bad_request';
    if (status === 401) return 'unauthorized';
    if (status === 403) return 'forbidden';
    if (status === 404) return 'not_found';
    if (status === 405) return 'method_not_allowed';
    if (status === 406) return 'not_acceptable';
    if (status === 409) return 'conflict';
    if (status === 410) return 'gone';
    if (status === 422) return 'unprocessable_entity';
    if (status === 423) return 'locked';
    if (status === 429) return 'rate_limited';
    if (status === 451) return 'unavailable_for_legal_reasons';
    if (status >= 500) return 'internal_error';
    return 'error';
}
