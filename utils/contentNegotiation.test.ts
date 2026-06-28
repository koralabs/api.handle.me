import { Request } from 'express';
import { wantsJsonForDecoding, wantsRawCbor, wantsTextPlain } from './contentNegotiation';

const makeReq = (accept?: string) => ({
    headers: accept === undefined ? {} : { accept }
} as Request<any, any, any, any>);

describe('contentNegotiation', () => {
    describe('wantsTextPlain', () => {
        it('defaults to JSON when Accept is missing or wildcard', () => {
            expect(wantsTextPlain(makeReq())).toBe(false);
            expect(wantsTextPlain(makeReq('*/*'))).toBe(false);
        });

        it('prefers JSON when application/json is listed alongside text/plain', () => {
            expect(wantsTextPlain(makeReq('application/json, text/plain, */*'))).toBe(false);
            expect(wantsTextPlain(makeReq('text/plain, application/json'))).toBe(false);
        });

        it('detects explicit text/plain even with parameters', () => {
            expect(wantsTextPlain(makeReq('text/plain; charset=utf-8'))).toBe(true);
        });
    });

    describe('wantsRawCbor', () => {
        it('defaults to decoded JSON unless a raw type is explicitly requested', () => {
            expect(wantsRawCbor(makeReq())).toBe(false);
            expect(wantsRawCbor(makeReq('*/*'))).toBe(false);
            expect(wantsRawCbor(makeReq('application/json'))).toBe(false);
        });

        it('returns the first supported raw response type requested by the client', () => {
            expect(wantsRawCbor(makeReq('application/cbor'))).toBe('application/cbor');
            expect(wantsRawCbor(makeReq('application/cbor-hex'))).toBe('application/cbor-hex');
            expect(wantsRawCbor(makeReq('text/plain; charset=utf-8'))).toBe('text/plain');
        });

        it('keeps JSON preferred when raw and JSON types are both listed', () => {
            expect(wantsRawCbor(makeReq('application/cbor, application/json'))).toBe(false);
        });
    });

    describe('wantsJsonForDecoding', () => {
        it('is true for default JSON behavior and false for raw CBOR opt-in', () => {
            expect(wantsJsonForDecoding(makeReq())).toBe(true);
            expect(wantsJsonForDecoding(makeReq('application/json'))).toBe(true);
            expect(wantsJsonForDecoding(makeReq('application/cbor'))).toBe(false);
        });
    });
});
