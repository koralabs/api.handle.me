import { EventEmitter } from 'events';
import https from 'https';
import { requestIpfs } from './requestIpfs';

const mockIpfsRequest = (handler: (response: EventEmitter & { statusCode?: number; destroy?: () => void }) => void) => {
    jest.spyOn(https, 'request').mockImplementation((...args: any[]) => {
        const responseCallback = args[2] as (res: EventEmitter & { statusCode?: number; destroy?: () => void }) => void;
        const response = new EventEmitter() as EventEmitter & { statusCode?: number; destroy?: () => void };
        response.statusCode = 200;
        response.destroy = jest.fn();

        const request = new EventEmitter() as EventEmitter & { end: () => void; destroy?: () => void };
        (request as any).on = function (event: string, listener: (...listenerArgs: any[]) => void) {
            EventEmitter.prototype.on.call(this, event, listener);
            return this;
        };
        request.destroy = jest.fn();
        request.end = () => {
            responseCallback(response);
            handler(response);
        };

        return request as any;
    });
};

describe('requestIpfs tests', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('should resolve cbor hex on successful response', async () => {
        mockIpfsRequest((response) => {
            response.emit('data', Buffer.from('a0', 'hex'));
            response.emit('end');
        });

        const result = await requestIpfs('https://ipfs.io/ipfs/test');

        expect(result).toEqual({
            statusCode: 200,
            cbor: 'a0'
        });
    });

    it('should resolve a deterministic error for oversized definite CBOR string payloads', async () => {
        mockIpfsRequest((response) => {
            response.emit('data', Buffer.from('5b2266435c34567800', 'hex'));
            response.emit('end');
        });

        const result = await requestIpfs('https://ipfs.io/ipfs/overflowing-cbor');

        expect(result).toEqual({
            statusCode: 422,
            error: expect.stringContaining('declared byte string length')
        });
    });

    it('should resolve a deterministic error for oversized definite CBOR arrays', async () => {
        mockIpfsRequest((response) => {
            response.emit('data', Buffer.from('9b2266435c34567800', 'hex'));
            response.emit('end');
        });

        const result = await requestIpfs('https://ipfs.io/ipfs/overflowing-array');

        expect(result).toEqual({
            statusCode: 422,
            error: expect.stringContaining('declared array length')
        });
    });

    it('should stop reading and resolve an error when response exceeds the byte limit', async () => {
        mockIpfsRequest((response) => {
            response.emit('data', Buffer.alloc((10 * 1024 * 1024) + 1));
            response.emit('end');
        });

        const result = await requestIpfs('https://ipfs.io/ipfs/too-large');

        expect(result).toEqual({
            statusCode: 413,
            error: 'IPFS response exceeded 10485760 byte limit'
        });
    });

    it('should resolve error when request emits an error', async () => {
        jest.spyOn(https, 'request').mockImplementation((...args: any[]) => {
            const request = new EventEmitter() as EventEmitter & { end: () => void };
            (request as any).on = function (event: string, listener: (...listenerArgs: any[]) => void) {
                EventEmitter.prototype.on.call(this, event, listener);
                return this;
            };
            (request as any).end = () => {
                request.emit('error', new Error('request failed'));
            };

            return request as any;
        });

        const result = await requestIpfs('https://ipfs.io/ipfs/test');

        expect(result).toEqual({
            statusCode: 500,
            error: 'request failed'
        });
    });

    it('should resolve error when response emits an error', async () => {
        jest.spyOn(https, 'request').mockImplementation((...args: any[]) => {
            const responseCallback = args[2] as (res: EventEmitter & { statusCode?: number }) => void;
            const response = new EventEmitter() as EventEmitter & { statusCode?: number };
            response.statusCode = 502;

            const request = new EventEmitter() as EventEmitter & { end: () => void };
            (request as any).on = function (event: string, listener: (...listenerArgs: any[]) => void) {
                EventEmitter.prototype.on.call(this, event, listener);
                return this;
            };
            (request as any).end = () => {
                responseCallback(response);
                response.emit('error', new Error('response failed'));
            };

            return request as any;
        });

        const result = await requestIpfs('https://ipfs.io/ipfs/test');

        expect(result).toEqual({
            statusCode: 500,
            error: 'response failed'
        });
    });

    it('should resolve error when https.request throws', async () => {
        jest.spyOn(https, 'request').mockImplementation(() => {
            throw new Error('request construction failed');
        });

        const result = await requestIpfs('https://ipfs.io/ipfs/test');

        expect(result).toEqual({
            statusCode: 500,
            error: 'request construction failed'
        });
    });
});
