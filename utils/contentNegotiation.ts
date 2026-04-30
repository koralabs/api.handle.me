import { Request } from 'express';

// Default-to-JSON content negotiation. The standard `accepts` package can't
// match `text/plain; charset=utf-8` against the bare `text/plain` offer, and it
// also surprises agents that send the axios-default
// `application/json, text/plain, */*` by picking the first listed type from the
// offer array. This helper is opinionated:
//   - if the client lists `application/json` (or `*/*`) → prefer JSON
//   - if the client *only* lists a non-JSON type → use that
//   - if Accept is missing → default to JSON

const parseTypes = (req: Request<any, any, any, any>): string[] => {
    const raw = String(req.headers.accept ?? '');
    if (!raw) return [];
    return raw.split(',').map((part) => part.split(';')[0]!.trim().toLowerCase()).filter(Boolean);
};

const accepts = (types: string[], target: string): boolean =>
    types.some((t) => t === target || t === '*/*' || t === target.split('/')[0] + '/*');

export const wantsTextPlain = (req: Request<any, any, any, any>): boolean => {
    const types = parseTypes(req);
    if (types.length === 0) return false;
    if (accepts(types, 'application/json')) return false;
    return accepts(types, 'text/plain');
};

export const wantsRawCbor = (req: Request<any, any, any, any>): string | false => {
    const types = parseTypes(req);
    if (types.length === 0) return false;
    if (accepts(types, 'application/json')) return false;
    for (const candidate of ['text/plain', 'application/cbor', 'application/cbor-hex']) {
        if (accepts(types, candidate)) return candidate;
    }
    return false;
};

export const wantsJsonForDecoding = (req: Request<any, any, any, any>): boolean => {
    // Helper for endpoints that flip between "decode CBOR to JSON" and "send raw CBOR-hex".
    // Default = JSON (decoded). Only return false when the client explicitly opts into raw.
    return wantsRawCbor(req) === false;
};
