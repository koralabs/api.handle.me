import { wantsJsonForDecoding, wantsRawCbor, wantsTextPlain } from './contentNegotiation';

const requestWithAccept = (accept?: string) => ({
    headers: accept === undefined ? {} : { accept }
} as any);

describe('contentNegotiation', () => {
    it('defaults missing Accept headers to JSON semantics', () => {
        const req = requestWithAccept();

        expect(wantsTextPlain(req)).toBe(false);
        expect(wantsRawCbor(req)).toBe(false);
        expect(wantsJsonForDecoding(req)).toBe(true);
    });

    it('prefers JSON when the client advertises JSON, text, and wildcards', () => {
        const req = requestWithAccept('application/json, text/plain, */*');

        expect(wantsTextPlain(req)).toBe(false);
        expect(wantsRawCbor(req)).toBe(false);
        expect(wantsJsonForDecoding(req)).toBe(true);
    });

    it('matches text/plain with parameters when JSON is not requested', () => {
        const req = requestWithAccept('text/plain; charset=utf-8');

        expect(wantsTextPlain(req)).toBe(true);
        expect(wantsRawCbor(req)).toBe('text/plain');
        expect(wantsJsonForDecoding(req)).toBe(false);
    });

    it('recognizes explicit CBOR representations without treating application wildcards as raw', () => {
        expect(wantsRawCbor(requestWithAccept('application/cbor'))).toBe('application/cbor');
        expect(wantsRawCbor(requestWithAccept('application/cbor-hex'))).toBe('application/cbor-hex');
        expect(wantsRawCbor(requestWithAccept('application/*'))).toBe(false);
    });
});
