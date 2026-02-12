import { EventEmitter } from 'events';
import https from 'https';
import { requestIpfs } from './requestIpfs';

describe('requestIpfs tests', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('should resolve cbor hex on successful response', async () => {
        jest.spyOn(https, 'request').mockImplementation((...args: any[]) => {
            const responseCallback = args[2] as (res: EventEmitter & { statusCode?: number }) => void;
            const response = new EventEmitter() as EventEmitter & { statusCode?: number };
            response.statusCode = 200;

            const request = new EventEmitter() as EventEmitter & { end: () => void };
            (request as any).on = function (event: string, listener: (...listenerArgs: any[]) => void) {
                EventEmitter.prototype.on.call(this, event, listener);
                return this;
            };
            (request as any).end = () => {
                responseCallback(response);
                response.emit('data', Buffer.from('d879', 'hex'));
                response.emit('end');
            };

            return request as any;
        });

        const result = await requestIpfs('https://ipfs.io/ipfs/test');

        expect(result).toEqual({
            statusCode: 200,
            cbor: 'd879'
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
