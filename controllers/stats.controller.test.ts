import { HandlesRepository } from '../repositories/handlesRepository';
import StatsController from './stats.controller';

jest.mock('../repositories/handlesRepository');

const MockedHandlesRepository = HandlesRepository as unknown as jest.Mock;

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

describe('StatsController', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('returns stats with fallback counts and repository HTTP status', async () => {
        const repoMock = {
            getMetrics: jest.fn().mockReturnValue({ handleCount: undefined, holderCount: 7 }),
            currentHttpStatus: jest.fn().mockReturnValue(202)
        };
        MockedHandlesRepository.mockImplementation(() => repoMock);

        const controller = new StatsController();
        const req = buildReq();
        const res = buildRes();
        const next = jest.fn();
        await controller.index(req, res, next);

        expect(res.status).toHaveBeenCalledWith(202);
        expect(res.json).toHaveBeenCalledWith({
            total_handles: 0,
            total_holders: 7
        });
        expect(repoMock.currentHttpStatus).toHaveBeenCalledWith({ handleCount: undefined, holderCount: 7 });
        expect(next).not.toHaveBeenCalled();
    });

    it('falls back total_holders to zero when holderCount is absent', async () => {
        const repoMock = {
            getMetrics: jest.fn().mockReturnValue({ handleCount: 5, holderCount: undefined }),
            currentHttpStatus: jest.fn().mockReturnValue(200)
        };
        MockedHandlesRepository.mockImplementation(() => repoMock);

        const controller = new StatsController();
        const req = buildReq();
        const res = buildRes();
        await controller.index(req, res, jest.fn());

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({
            total_handles: 5,
            total_holders: 0
        });
        expect(repoMock.currentHttpStatus).toHaveBeenCalledWith({ handleCount: 5, holderCount: undefined });
    });

    it('forwards unexpected repository errors to next', async () => {
        const error = new Error('repo failure');
        const repoMock = {
            getMetrics: jest.fn(() => {
                throw error;
            }),
            currentHttpStatus: jest.fn().mockReturnValue(200)
        };
        MockedHandlesRepository.mockImplementation(() => repoMock);

        const controller = new StatsController();
        const req = buildReq();
        const res = buildRes();
        const next = jest.fn();
        await controller.index(req, res, next);

        expect(next).toHaveBeenCalledWith(error);
    });
});
