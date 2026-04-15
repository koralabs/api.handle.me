import { LockedLambdaReason, Logger } from '@koralabs/kora-labs-common';
import { HandlesRepository } from '../repositories/handlesRepository';
import { fetchHealth } from '../services/ogmios/utils';
import HealthController from './health.controller';

jest.mock('../repositories/handlesRepository');
jest.mock('../services/ogmios/utils', () => ({ fetchHealth: jest.fn() }));

const MockedHandlesRepository = HandlesRepository as unknown as jest.Mock;
const mockedFetchHealth = fetchHealth as jest.Mock;

const baseMetrics = {
    firstSlot: 10,
    lastSlot: 110,
    currentSlot: 60,
    firstMemoryUsage: 1000,
    currentBlockHash: 'block_hash',
    tipBlockHash: 'tip_hash',
    memorySize: 50,
    utxoSchemaVersion: 1,
    indexSchemaVersion: 1,
    handleCount: 3,
    holderCount: 2,
    startTimestamp: Date.now() - 1000,
    lockLambdas: LockedLambdaReason.UNLOCKED
};

const buildReq = () =>
    ({
        app: {
            get: jest.fn().mockReturnValue({
                handlesStore: class MockStore {}
            })
        }
    }) as any;

const buildRes = () => {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    return { json, status } as any;
};

describe('HealthController', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        process.env.NETWORK = 'PREVIEW';
        delete process.env.ENABLE_OGMIOS_SCANNING;
    });

    it('returns current status when storage is caught up and ogmios scanning is disabled', async () => {
        const repoMock = {
            getMetrics: jest.fn().mockReturnValue(baseMetrics),
            isCaughtUp: jest.fn().mockReturnValue(true)
        };
        MockedHandlesRepository.mockImplementation(() => repoMock);
        process.env.ENABLE_OGMIOS_SCANNING = 'false';

        const controller = new HealthController();
        const req = buildReq();
        const res = buildRes();
        const next = jest.fn();
        await controller.index(req, res, next);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                status: 'current',
                stats: expect.objectContaining({
                    handle_count: 3,
                    holder_count: 2,
                    last_slot: 110,
                    tip_block_hash: 'tip_hash',
                    lock_lambdas: LockedLambdaReason.UNLOCKED
                })
            })
        );
        expect(res.json.mock.calls[0][0].ogmios).toBeUndefined();
        expect(next).not.toHaveBeenCalled();
    });

    it('renders the correct preprod slot_date', async () => {
        const repoMock = {
            getMetrics: jest.fn().mockReturnValue({
                ...baseMetrics,
                currentSlot: 117334474
            }),
            isCaughtUp: jest.fn().mockReturnValue(true)
        };
        MockedHandlesRepository.mockImplementation(() => repoMock);
        process.env.ENABLE_OGMIOS_SCANNING = 'false';
        process.env.NETWORK = 'PREPROD';

        const controller = new HealthController();
        const req = buildReq();
        const res = buildRes();
        await controller.index(req, res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                stats: expect.objectContaining({
                    slot_date: new Date('2026-03-09T00:54:34.000Z')
                })
            })
        );
    });

    it('returns storage_behind when repo is not caught up', async () => {
        const repoMock = {
            getMetrics: jest.fn().mockReturnValue(baseMetrics),
            isCaughtUp: jest.fn().mockReturnValue(false)
        };
        MockedHandlesRepository.mockImplementation(() => repoMock);
        process.env.ENABLE_OGMIOS_SCANNING = 'false';

        const controller = new HealthController();
        const req = buildReq();
        const res = buildRes();
        await controller.index(req, res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(202);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'storage_behind' }));
    });

    it('returns ogmios_behind when synchronization is behind', async () => {
        const repoMock = {
            getMetrics: jest.fn().mockReturnValue(baseMetrics),
            isCaughtUp: jest.fn().mockReturnValue(true)
        };
        MockedHandlesRepository.mockImplementation(() => repoMock);
        mockedFetchHealth.mockResolvedValue({ networkSynchronization: 0.4, connectionStatus: 'connected' });

        const controller = new HealthController();
        const req = buildReq();
        const res = buildRes();
        await controller.index(req, res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(202);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                status: 'ogmios_behind',
                ogmios: expect.objectContaining({ connectionStatus: 'connected' })
            })
        );
    });

    it('returns storage_behind when stored tip does not match live ogmios tip', async () => {
        const repoMock = {
            getMetrics: jest.fn().mockReturnValue({
                ...baseMetrics,
                currentSlot: 100,
                lastSlot: 100,
                currentBlockHash: 'stale_hash',
                tipBlockHash: 'stale_hash'
            }),
            isCaughtUp: jest.fn().mockReturnValue(true)
        };
        MockedHandlesRepository.mockImplementation(() => repoMock);
        mockedFetchHealth.mockResolvedValue({
            networkSynchronization: 1,
            connectionStatus: 'connected',
            lastKnownTip: { slot: 2000, id: 'real_tip_hash' }
        });

        const controller = new HealthController();
        const req = buildReq();
        const res = buildRes();
        await controller.index(req, res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(202);
        expect(res.json).toHaveBeenCalledWith(
            expect.objectContaining({
                status: 'storage_behind',
                ogmios: expect.objectContaining({
                    lastKnownTip: expect.objectContaining({ id: 'real_tip_hash', slot: 2000 })
                })
            })
        );
    });

    it('returns waiting_on_cardano_node and logs warning when node is disconnected', async () => {
        const repoMock = {
            getMetrics: jest.fn().mockReturnValue(baseMetrics),
            isCaughtUp: jest.fn().mockReturnValue(true)
        };
        MockedHandlesRepository.mockImplementation(() => repoMock);
        mockedFetchHealth.mockResolvedValue({ networkSynchronization: 1, connectionStatus: 'disconnected' });

        const logSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());
        const controller = new HealthController();
        const req = buildReq();
        const res = buildRes();
        await controller.index(req, res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(503);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'waiting_on_cardano_node' }));
        expect(logSpy).toHaveBeenCalledWith(expect.objectContaining({ event: 'healthcheck.failure' }));
    });

    it('returns updating when lock reason is rollback/reindex', async () => {
        const repoMock = {
            getMetrics: jest.fn().mockReturnValue({
                ...baseMetrics,
                lockLambdas: LockedLambdaReason.REINDEX
            }),
            isCaughtUp: jest.fn().mockReturnValue(true)
        };
        MockedHandlesRepository.mockImplementation(() => repoMock);
        process.env.ENABLE_OGMIOS_SCANNING = 'false';

        const controller = new HealthController();
        const req = buildReq();
        const res = buildRes();
        await controller.index(req, res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(202);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'updating' }));
    });

    it('keeps updating status precedence over waiting node when lock is active', async () => {
        const repoMock = {
            getMetrics: jest.fn().mockReturnValue({
                ...baseMetrics,
                lockLambdas: LockedLambdaReason.ROLLBACK
            }),
            isCaughtUp: jest.fn().mockReturnValue(true)
        };
        MockedHandlesRepository.mockImplementation(() => repoMock);
        mockedFetchHealth.mockResolvedValue({ networkSynchronization: 0.2, connectionStatus: 'disconnected' });

        const controller = new HealthController();
        const req = buildReq();
        const res = buildRes();
        await controller.index(req, res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(202);
        expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ status: 'updating' }));
    });

    it('handles empty metric payloads with safe defaults', async () => {
        const repoMock = {
            getMetrics: jest.fn().mockReturnValue({}),
            isCaughtUp: jest.fn().mockReturnValue(true)
        };
        MockedHandlesRepository.mockImplementation(() => repoMock);
        process.env.ENABLE_OGMIOS_SCANNING = 'false';

        const controller = new HealthController();
        const req = buildReq();
        const res = buildRes();
        await controller.index(req, res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(200);
        const payload = res.json.mock.calls[0][0];
        expect(payload.status).toBe('current');
        expect(payload.stats.handle_count).toBe(0);
        expect(payload.stats.holder_count).toBe(0);
        expect(Number.isNaN(payload.stats.percentage_complete)).toBe(true);
    });

    it('forwards errors to next when repository access throws', async () => {
        const error = new Error('boom');
        const repoMock = {
            getMetrics: jest.fn(() => {
                throw error;
            }),
            isCaughtUp: jest.fn().mockReturnValue(true)
        };
        MockedHandlesRepository.mockImplementation(() => repoMock);

        const controller = new HealthController();
        const req = buildReq();
        const res = buildRes();
        const next = jest.fn();
        await controller.index(req, res, next);

        expect(next).toHaveBeenCalledWith(error);
    });
});
