import { MAX_PAGINATED_RESULTS } from '../config/constants';
import { HandlesRepository } from '../repositories/handlesRepository';
import { ApiError } from '../utils/apiError';
import HoldersController from './holders.controller';

jest.mock('../repositories/handlesRepository');

const MockedHandlesRepository = HandlesRepository as unknown as jest.Mock;

const buildReq = (overrides: Record<string, unknown> = {}) => ({
    app: {
        get: jest.fn().mockReturnValue({
            handlesStore: class MockStore {}
        })
    },
    params: {},
    query: {},
    ...overrides
}) as any;

const buildRes = () => {
    const res = {
        status: jest.fn(),
        json: jest.fn()
    } as any;
    res.status.mockReturnValue(res);
    res.json.mockReturnValue(res);
    return res;
};

describe('HoldersController', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('lists holders through repository pagination without per-holder handle arrays', async () => {
        const repoMock = {
            getAllHolders: jest.fn().mockReturnValue([
                {
                    handles: ['burritos', 'tacos'],
                    total_handles: 2,
                    default_handle: 'burritos',
                    address: 'addr1',
                    manually_set: false
                },
                {
                    handles: ['salsa'],
                    total_handles: 1,
                    default_handle: 'salsa',
                    address: 'addr2',
                    manually_set: true
                }
            ]),
            currentHttpStatus: jest.fn().mockReturnValue(202)
        };
        MockedHandlesRepository.mockImplementation(() => repoMock);

        const controller = new HoldersController();
        const req = buildReq({ query: { records_per_page: '2', page: '3', sort: 'asc' } });
        const res = buildRes();
        const next = jest.fn();

        await controller.getAll(req, res, next);

        expect(repoMock.getAllHolders).toHaveBeenCalledWith({
            pagination: expect.objectContaining({
                recordsPerPage: 2,
                page: 3,
                sort: 'asc'
            }),
            includeHandles: false
        });
        expect(res.status).toHaveBeenCalledWith(202);
        expect(res.json).toHaveBeenCalledWith([
            {
                total_handles: 2,
                default_handle: 'burritos',
                address: 'addr1',
                manually_set: false
            },
            {
                total_handles: 1,
                default_handle: 'salsa',
                address: 'addr2',
                manually_set: true
            }
        ]);
        expect(next).not.toHaveBeenCalled();
    });

    it('uses holder pagination defaults when no query params are supplied', async () => {
        const repoMock = {
            getAllHolders: jest.fn().mockReturnValue([]),
            currentHttpStatus: jest.fn().mockReturnValue(200)
        };
        MockedHandlesRepository.mockImplementation(() => repoMock);

        const controller = new HoldersController();
        const res = buildRes();

        await controller.getAll(buildReq(), res, jest.fn());

        expect(repoMock.getAllHolders).toHaveBeenCalledWith({
            pagination: expect.objectContaining({
                recordsPerPage: 100,
                page: 1,
                sort: 'desc'
            }),
            includeHandles: false
        });
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith([]);
    });

    it('rejects records_per_page above the API maximum before querying holders', async () => {
        const repoMock = {
            getAllHolders: jest.fn(),
            currentHttpStatus: jest.fn().mockReturnValue(200)
        };
        MockedHandlesRepository.mockImplementation(() => repoMock);

        const controller = new HoldersController();
        const res = buildRes();
        const next = jest.fn();

        await controller.getAll(
            buildReq({ query: { records_per_page: `${MAX_PAGINATED_RESULTS + 1}` } }),
            res,
            next
        );

        const error = next.mock.calls[0][0];
        expect(error).toBeInstanceOf(ApiError);
        expect(error).toEqual(expect.objectContaining({
            code: 'records_per_page_too_large',
            message: "'records_per_page' must be 250 or less"
        }));
        expect(repoMock.getAllHolders).not.toHaveBeenCalled();
        expect(res.status).not.toHaveBeenCalled();
    });

    it('forwards unexpected holder listing errors to next', async () => {
        const error = new Error('store unavailable');
        const repoMock = {
            getAllHolders: jest.fn(() => {
                throw error;
            }),
            currentHttpStatus: jest.fn().mockReturnValue(200)
        };
        MockedHandlesRepository.mockImplementation(() => repoMock);

        const controller = new HoldersController();
        const res = buildRes();
        const next = jest.fn();

        await controller.getAll(buildReq(), res, next);

        expect(next).toHaveBeenCalledWith(error);
        expect(res.status).not.toHaveBeenCalled();
    });

    it('returns holder details with the repository HTTP status', async () => {
        const details = {
            handles: ['burritos'],
            default_handle: 'burritos',
            manually_set: false
        };
        const repoMock = {
            getHolder: jest.fn().mockReturnValue(details),
            currentHttpStatus: jest.fn().mockReturnValue(202)
        };
        MockedHandlesRepository.mockImplementation(() => repoMock);

        const controller = new HoldersController();
        const res = buildRes();
        const next = jest.fn();

        await controller.getHolderAddressDetails(buildReq({ params: { address: 'addr_test1' } }), res, next);

        expect(repoMock.getHolder).toHaveBeenCalledWith('addr_test1');
        expect(res.status).toHaveBeenCalledWith(202);
        expect(res.json).toHaveBeenCalledWith(details);
        expect(next).not.toHaveBeenCalled();
    });

    it('reports missing holder details as holder_not_found', async () => {
        const repoMock = {
            getHolder: jest.fn().mockReturnValue(undefined),
            currentHttpStatus: jest.fn().mockReturnValue(200)
        };
        MockedHandlesRepository.mockImplementation(() => repoMock);

        const controller = new HoldersController();
        const res = buildRes();
        const next = jest.fn();

        await controller.getHolderAddressDetails(buildReq({ params: { address: 'missing' } }), res, next);

        const error = next.mock.calls[0][0];
        expect(error).toBeInstanceOf(ApiError);
        expect(error).toEqual(expect.objectContaining({
            code: 'holder_not_found',
            message: 'Holder not found'
        }));
        expect(res.status).not.toHaveBeenCalled();
    });
});
