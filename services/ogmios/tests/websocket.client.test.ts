import { LogCategory, Logger } from '@koralabs/kora-labs-common';
import OgmiosService from '../ogmios.service';

jest.mock('fastq', () => ({
    __esModule: true,
    default: {
        promise: (fn: CallableFunction) => ({ push: fn })
    }
}));

jest.mock('ws', () => {
    class MockWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;

        readyState = MockWebSocket.OPEN;
        handlers: Record<string, CallableFunction> = {};
        url: string;
        options: any;

        constructor(url: string, options: any) {
            this.url = url;
            this.options = options;
        }

        on(event: string, callback: CallableFunction) {
            this.handlers[event] = callback;
            return this;
        }

        send = jest.fn();
        close = jest.fn();

        emit(event: string, payload: any) {
            return this.handlers[event]?.(payload);
        }
    }

    return { __esModule: true, default: MockWebSocket };
});

const createRepoMock = () =>
    ({
        setMetrics: jest.fn(),
        getMetrics: jest.fn().mockReturnValue({ currentSlot: 0 })
    }) as any;

describe('OgmiosService websocket client branches', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('queues 100 nextBlock requests after find-intersection and one trailing request', async () => {
        const repo = createRepoMock();
        const service = new OgmiosService(repo);
        const rpcSpy = jest.spyOn(service as any, '_rpcRequest').mockImplementation(jest.fn());
        const client = (service as any)._createWebSocketClient() as any;

        await client.emit('message', JSON.stringify({ id: 'find-intersection' }));

        expect(rpcSpy).toHaveBeenCalledTimes(101);
        expect(rpcSpy).toHaveBeenNthCalledWith(1, 'nextBlock', {}, 'next-block');
        expect(rpcSpy).toHaveBeenLastCalledWith('nextBlock', {}, 'next-block');
    });

    it('logs rollback notices for backward direction and keeps polling', async () => {
        const repo = createRepoMock();
        const service = new OgmiosService(repo);
        const rpcSpy = jest.spyOn(service as any, '_rpcRequest').mockImplementation(jest.fn());
        const loggerSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());
        const client = (service as any)._createWebSocketClient() as any;

        await client.emit(
            'message',
            JSON.stringify({
                id: 'next-block',
                result: {
                    direction: 'backward',
                    point: { slot: 5, id: 'rollback_hash' }
                }
            })
        );

        expect(loggerSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                event: 'OgmiosService.rollBackward',
                category: LogCategory.INFO
            })
        );
        expect(rpcSpy).toHaveBeenCalledWith('nextBlock', {}, 'next-block');
    });

    it('handles forward praos blocks and updates metrics', async () => {
        const repo = createRepoMock();
        const service = new OgmiosService(repo);
        const processBlockSpy = jest.spyOn(service as any, 'processBlock').mockImplementation(jest.fn());
        const rpcSpy = jest.spyOn(service as any, '_rpcRequest').mockImplementation(jest.fn());
        const client = (service as any)._createWebSocketClient() as any;
        const block = {
            type: 'praos',
            slot: 123,
            id: 'block_hash',
            transactions: []
        };

        await client.emit(
            'message',
            JSON.stringify({
                id: 'next-block',
                result: {
                    direction: 'forward',
                    block,
                    tip: {
                        id: 'tip_hash',
                        slot: 124
                    }
                }
            })
        );

        expect(processBlockSpy).toHaveBeenCalledWith(block);
        expect(repo.setMetrics).toHaveBeenCalledWith({
            currentSlot: 123,
            currentBlockHash: 'block_hash',
            tipBlockHash: 'tip_hash',
            lastSlot: 124
        });
        expect(rpcSpy).toHaveBeenCalledWith('nextBlock', {}, 'next-block');
    });

    it('continues polling on next-block messages with unknown direction', async () => {
        const repo = createRepoMock();
        const service = new OgmiosService(repo);
        const rpcSpy = jest.spyOn(service as any, '_rpcRequest').mockImplementation(jest.fn());
        const client = (service as any)._createWebSocketClient() as any;

        await client.emit(
            'message',
            JSON.stringify({
                id: 'next-block',
                result: {
                    direction: 'sideways'
                }
            })
        );

        expect(rpcSpy).toHaveBeenCalledWith('nextBlock', {}, 'next-block');
        expect(repo.setMetrics).not.toHaveBeenCalled();
    });

    it('logs forward-processing errors for unsupported block types', async () => {
        const repo = createRepoMock();
        const service = new OgmiosService(repo);
        const loggerSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());
        const client = (service as any)._createWebSocketClient() as any;
        (service as any).client = client;

        await client.emit(
            'message',
            JSON.stringify({
                id: 'next-block',
                result: {
                    direction: 'forward',
                    block: {
                        type: 'bft',
                        slot: 9,
                        id: 'bad_block',
                        transactions: []
                    },
                    tip: {
                        id: 'tip_hash',
                        slot: 10
                    }
                }
            })
        );

        expect(repo.setMetrics).not.toHaveBeenCalled();
        expect(loggerSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                event: 'OgmiosService.processBlock',
                category: LogCategory.NOTIFY
            })
        );
    });

    it('logs malformed next-block payload errors from message handler', async () => {
        const repo = createRepoMock();
        const service = new OgmiosService(repo);
        const loggerSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());
        const client = (service as any)._createWebSocketClient() as any;
        (service as any).client = client;

        await client.emit('message', JSON.stringify({ id: 'next-block' }));

        expect(loggerSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                event: 'OgmiosClient.Message',
                category: LogCategory.ERROR
            })
        );
    });

    it('logs websocket error events', () => {
        const repo = createRepoMock();
        const service = new OgmiosService(repo);
        const loggerSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());
        const client = (service as any)._createWebSocketClient() as any;

        client.emit('error', new Error('socket exploded'));

        expect(loggerSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                event: 'OgmiosClient.Error',
                category: LogCategory.ERROR
            })
        );
    });

    it('rpc request sends jsonrpc payload to active client', () => {
        const repo = createRepoMock();
        const service = new OgmiosService(repo);
        const send = jest.fn();
        (service as any).client = { send };

        (service as any)._rpcRequest('nextBlock', { foo: 'bar' }, 'abc');

        expect(send).toHaveBeenCalledWith(
            JSON.stringify({
                jsonrpc: '2.0',
                method: 'nextBlock',
                params: { foo: 'bar' },
                id: 'abc'
            })
        );
    });
});
