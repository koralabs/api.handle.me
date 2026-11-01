import { handleEraBoundaries } from '../../../config/constants';
import OgmiosService from '../ogmios.service';
import WebSocket from 'ws';

const createRepoMock = () =>
    ({
        initialize: jest.fn().mockResolvedValue(undefined),
        getMetrics: jest.fn().mockReturnValue({}),
        setMetrics: jest.fn(),
        getStartingPoint: jest.fn(),
        rollBackToGenesis: jest.fn(),
        destroy: jest.fn(),
        addUTxO: jest.fn(),
        updateHandleIndexes: jest.fn()
    }) as any;

describe('OgmiosService lifecycle tests', () => {
    const originalNetwork = process.env.NETWORK;
    const originalExit = process.exit;

    beforeEach(() => {
        process.env.NETWORK = 'preview';
    });

    afterEach(() => {
        process.env.NETWORK = originalNetwork;
        process.exit = originalExit;
        jest.useRealTimers();
        jest.restoreAllMocks();
    });

    it('initializes from genesis when starting point is missing', async () => {
        const repo = createRepoMock();
        repo.getStartingPoint.mockResolvedValue(null);
        const service = new OgmiosService(repo);
        const client = { readyState: WebSocket.OPEN, close: jest.fn(), on: jest.fn(), send: jest.fn() } as any;
        const resumeSpy = jest.spyOn(service as any, '_resume').mockResolvedValue(undefined);
        jest.spyOn(service as any, '_createWebSocketClient').mockReturnValue(client);

        await service.initialize();

        expect(repo.initialize).toHaveBeenCalled();
        expect(repo.rollBackToGenesis).toHaveBeenCalled();
        expect(resumeSpy).toHaveBeenCalledWith(handleEraBoundaries.preview);
    });

    it('initializes genesis from preview fallback when NETWORK is unset', async () => {
        delete process.env.NETWORK;
        const repo = createRepoMock();
        repo.getStartingPoint.mockResolvedValue(null);
        const service = new OgmiosService(repo);
        const client = { readyState: WebSocket.OPEN, close: jest.fn(), on: jest.fn(), send: jest.fn() } as any;
        const resumeSpy = jest.spyOn(service as any, '_resume').mockResolvedValue(undefined);
        jest.spyOn(service as any, '_createWebSocketClient').mockReturnValue(client);

        await service.initialize();

        expect(repo.rollBackToGenesis).toHaveBeenCalled();
        expect(resumeSpy).toHaveBeenCalledWith(handleEraBoundaries.preview);
    });

    it('resumes from stored starting point when available', async () => {
        const repo = createRepoMock();
        const startingPoint = { slot: 123, id: 'block_hash' };
        repo.getStartingPoint.mockResolvedValue(startingPoint);
        const service = new OgmiosService(repo);
        const client = { readyState: WebSocket.OPEN, close: jest.fn(), on: jest.fn(), send: jest.fn() } as any;
        const resumeSpy = jest.spyOn(service as any, '_resume').mockResolvedValue(undefined);
        jest.spyOn(service as any, '_createWebSocketClient').mockReturnValue(client);

        await service.initialize();

        expect(repo.rollBackToGenesis).not.toHaveBeenCalled();
        expect(resumeSpy).toHaveBeenCalledWith(startingPoint);
    });

    it('uses preview era defaults when NETWORK is not set', async () => {
        delete process.env.NETWORK;
        const repo = createRepoMock();
        repo.getMetrics.mockReturnValue(undefined);
        repo.getStartingPoint.mockResolvedValue({ slot: 123, id: 'block_hash' });
        const service = new OgmiosService(repo);
        const client = { readyState: WebSocket.OPEN, close: jest.fn(), on: jest.fn(), send: jest.fn() } as any;
        const resumeSpy = jest.spyOn(service as any, '_resume').mockResolvedValue(undefined);
        jest.spyOn(service as any, '_createWebSocketClient').mockReturnValue(client);

        await service.initialize();

        expect(repo.setMetrics).toHaveBeenCalledWith(
            expect.objectContaining({
                currentSlot: 123,
                currentBlockHash: 'block_hash',
                firstSlot: handleEraBoundaries.preview.slot
            })
        );
        expect(resumeSpy).toHaveBeenCalledWith({ slot: 123, id: 'block_hash' });
    });

    it('falls back to failed snapshot starting point when first resume returns code 1000', async () => {
        const repo = createRepoMock();
        repo.getStartingPoint
            .mockResolvedValueOnce({ slot: 123, id: 'bad_hash' })
            .mockResolvedValueOnce({ slot: 10, id: 'good_hash' });
        const service = new OgmiosService(repo);
        const client = { readyState: WebSocket.OPEN, close: jest.fn(), on: jest.fn(), send: jest.fn() } as any;
        jest.spyOn(service as any, '_createWebSocketClient').mockReturnValue(client);
        const resumeSpy = jest
            .spyOn(service as any, '_resume')
            .mockRejectedValueOnce({ code: 1000, message: 'bad point' })
            .mockResolvedValueOnce(undefined);
        process.exit = jest.fn() as any;

        await service.initialize();

        expect(repo.destroy).not.toHaveBeenCalled();
        expect(repo.getStartingPoint).toHaveBeenNthCalledWith(2, expect.anything(), true);
        expect(resumeSpy).toHaveBeenNthCalledWith(2, { slot: 10, id: 'good_hash' });
    });

    // Invariant: snapshot rejection cannot create synthetic bootstrap metrics or erase data.
    // Moving setMetrics before getStartingPoint restores a write and fails the original-image check.
    it('preserves original cache state when snapshot admission refuses', async () => {
        const state = { metrics: { currentSlot: 7, currentBlockHash: 'original' }, data: ['original-utxo'], control: 'original-owner' };
        const original = structuredClone(state);
        const repo = createRepoMock();
        repo.getMetrics.mockImplementation(() => state.metrics);
        repo.setMetrics.mockImplementation((metrics: any) => Object.assign(state.metrics, metrics));
        repo.destroy.mockImplementation(() => { state.data = []; });
        repo.getStartingPoint.mockRejectedValue(new Error('Invalid snapshot'));
        const service = new OgmiosService(repo);
        await expect(service.initialize()).rejects.toThrow('Invalid snapshot');
        expect(state).toEqual(original);
        expect(repo.rollBackToGenesis).not.toHaveBeenCalled();
    });

    it('resetClient closes open clients and clears reference', () => {
        const repo = createRepoMock();
        const service = new OgmiosService(repo);
        const close = jest.fn();
        (service as any).client = {
            readyState: WebSocket.OPEN,
            close
        };

        (service as any)._resetClient();

        expect(close).toHaveBeenCalled();
        expect((service as any).client).toBeUndefined();
    });

    it('resume recreates closed websocket and sends intersection request', async () => {
        const repo = createRepoMock();
        const service = new OgmiosService(repo);
        (service as any).client = {
            readyState: WebSocket.CLOSED,
            close: jest.fn(),
            send: jest.fn(),
            on: jest.fn()
        };
        const recreatedClient = {
            readyState: WebSocket.OPEN,
            close: jest.fn(),
            send: jest.fn(),
            on: jest.fn()
        } as any;
        jest.spyOn(service as any, '_createWebSocketClient').mockReturnValue(recreatedClient);
        const rpcSpy = jest.spyOn(service as any, '_rpcRequest').mockImplementation(jest.fn());

        await (service as any)._resume({ slot: 0, id: 'origin_hash' });

        expect(repo.setMetrics).toHaveBeenCalledWith(
            expect.objectContaining({
                firstSlot: expect.any(Number),
                currentSlot: 0,
                currentBlockHash: 'origin_hash'
            })
        );
        expect(rpcSpy).toHaveBeenCalledWith('findIntersection', { points: ['origin'] }, 'find-intersection');
    });

    it('retries initialization after websocket creation failure', async () => {
        jest.useFakeTimers();
        const repo = createRepoMock();
        repo.getStartingPoint.mockResolvedValue(null);
        const service = new OgmiosService(repo);
        const client = { readyState: WebSocket.OPEN, close: jest.fn(), on: jest.fn(), send: jest.fn() } as any;
        const createSpy = jest
            .spyOn(service as any, '_createWebSocketClient')
            .mockImplementationOnce(() => {
                throw new Error('connect failed');
            })
            .mockReturnValue(client);
        const resumeSpy = jest.spyOn(service as any, '_resume').mockResolvedValue(undefined);
        const initializePromise = service.initialize();
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(30_000);
        await initializePromise;

        expect(createSpy).toHaveBeenCalledTimes(2);
        expect(resumeSpy).toHaveBeenCalledWith(handleEraBoundaries.preview);
    });

    it('refuses both invalid stored starting points without destroying the cache', async () => {
        jest.useFakeTimers();
        const repo = createRepoMock();
        repo.getStartingPoint
            .mockResolvedValueOnce({ slot: 123, id: 'bad_hash_1' })
            .mockResolvedValueOnce({ slot: 124, id: 'bad_hash_2' });
        const service = new OgmiosService(repo);
        const client = { readyState: WebSocket.OPEN, close: jest.fn(), on: jest.fn(), send: jest.fn() } as any;
        jest.spyOn(service as any, '_createWebSocketClient').mockReturnValue(client);
        jest.spyOn(service as any, '_resume')
            .mockRejectedValueOnce({ code: 1000, message: 'bad point' })
            .mockRejectedValueOnce({ code: 1000, message: 'bad point' })
            .mockResolvedValueOnce(undefined);
        process.exit = jest.fn() as any;
        await expect(service.initialize()).rejects.toMatchObject({ code: 1000, message: 'bad point' });
        expect(repo.rollBackToGenesis).not.toHaveBeenCalled();
        expect(repo.destroy).not.toHaveBeenCalled();
        expect(repo.setMetrics).not.toHaveBeenCalled();
        expect(process.exit).not.toHaveBeenCalled();
    });

    // Invariant: a rejected recovery snapshot must escape the network reconnect loop intact.
    // Restoring the outer catch-all hangs/retries this test or writes bootstrap metrics.
    it('propagates recovery admission refusal without bootstrap or destructive cleanup', async () => {
        const repo = createRepoMock();
        repo.getStartingPoint.mockResolvedValueOnce({ slot: 123, id: 'old' }).mockRejectedValueOnce(new Error('Snapshot original image changed'));
        const service = new OgmiosService(repo);
        jest.spyOn(service as any, '_createWebSocketClient').mockReturnValue({ readyState: WebSocket.OPEN, on: jest.fn() });
        jest.spyOn(service as any, '_resume').mockRejectedValueOnce({ code: 1000, message: 'invalid intersection' });
        await expect(service.initialize()).rejects.toThrow('Snapshot original image changed');
        expect(repo.setMetrics).not.toHaveBeenCalled();
        expect(repo.destroy).not.toHaveBeenCalled();
        expect(repo.rollBackToGenesis).not.toHaveBeenCalled();
    });

    it('resume waits while websocket remains connecting', async () => {
        jest.useFakeTimers();
        const repo = createRepoMock();
        const service = new OgmiosService(repo);
        const client = {
            readyState: WebSocket.CONNECTING,
            close: jest.fn(),
            send: jest.fn(),
            on: jest.fn()
        } as any;
        (service as any).client = client;

        const rpcSpy = jest.spyOn(service as any, '_rpcRequest').mockImplementation(jest.fn());
        const resumePromise = (service as any)._resume({ slot: 1, id: 'tip_hash' });
        await Promise.resolve();
        (service as any).client.readyState = WebSocket.OPEN;
        await jest.advanceTimersByTimeAsync(30_000);
        await resumePromise;

        expect(rpcSpy).toHaveBeenCalledWith('findIntersection', { points: [{ slot: 1, id: 'tip_hash' }] }, 'find-intersection');
    });

});
