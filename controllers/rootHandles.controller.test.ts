import RootHandlesController from './rootHandles.controller';
import HandlesController from './handles.controller';
import { HandlesRepository } from '../repositories/handlesRepository';

jest.mock('../repositories/handlesRepository', () => ({
    HandlesRepository: jest.fn().mockImplementation(() => ({
        getRootHandleNames: jest.fn().mockReturnValue(['root1', 'root2']),
        currentHttpStatus: jest.fn().mockReturnValue(200)
    }))
}));

const mockRequest = (overrides: Record<string, unknown> = {}) => {
    return {
        app: {
            get: jest.fn().mockReturnValue({
                handlesStore: jest.fn()
            })
        },
        query: {},
        headers: {},
        ...overrides
    } as any;
};

const mockResponse = () => {
    const res = {
        set: jest.fn(),
        status: jest.fn(),
        json: jest.fn(),
        send: jest.fn()
    } as any;
    res.set.mockReturnValue(res);
    res.status.mockReturnValue(res);
    res.json.mockReturnValue(res);
    res.send.mockReturnValue(res);
    return res;
};

describe('RootHandlesController tests', () => {
    afterEach(() => {
        jest.clearAllMocks();
        jest.restoreAllMocks();
    });

    it('should return root handles as json', async () => {
        const controller = new RootHandlesController();
        const req = mockRequest();
        const res = mockResponse();
        const next = jest.fn();

        const parseSpy = jest.spyOn(HandlesController, 'parseQueryAndSearchHandles').mockReturnValue({
            searchTotal: 2,
            handles: [
                {
                    name: 'root1',
                    utxo: 'tx#0',
                    subhandle_settings: {
                        virtual: { public_minting_enabled: true }
                    }
                },
                {
                    name: 'filtered-out',
                    utxo: ''
                }
            ] as any
        });

        await controller.index(req, res, next);

        expect(parseSpy).toHaveBeenCalledWith(req, expect.anything(), ['root1', 'root2']);
        expect(res.set).toHaveBeenCalledWith('x-handles-search-total', '2');
        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith([
            expect.objectContaining({
                name: 'root1',
                utxo: 'tx#0',
                subhandle_settings: {
                    virtual: { public_minting_enabled: true }
                }
            })
        ]);
    });

    it('should filter handles when minting_type query is present', async () => {
        const controller = new RootHandlesController();
        const req = mockRequest({ query: { minting_type: 'virtual' } });
        const res = mockResponse();
        const next = jest.fn();

        jest.spyOn(HandlesController, 'parseQueryAndSearchHandles').mockReturnValue({
            searchTotal: 3,
            handles: [
                {
                    name: 'virtual-enabled',
                    utxo: 'tx#0',
                    subhandle_settings: {
                        virtual: { public_minting_enabled: true }
                    }
                },
                {
                    name: 'nft-enabled',
                    utxo: 'tx#1',
                    subhandle_settings: {
                        nft: { public_minting_enabled: true }
                    }
                },
                {
                    name: 'private',
                    utxo: 'tx#2',
                    subhandle_settings: {
                        nft: { public_minting_enabled: false },
                        virtual: { public_minting_enabled: false }
                    }
                }
            ] as any
        });

        await controller.index(req, res, next);

        const jsonPayload = res.json.mock.calls[0][0];
        expect(jsonPayload.map((handle: any) => handle.name)).toEqual(['virtual-enabled', 'nft-enabled']);
    });

    it('should return plain text when accept header is text/plain', async () => {
        const controller = new RootHandlesController();
        const req = mockRequest({ headers: { accept: 'text/plain; charset=utf-8' } });
        const res = mockResponse();
        const next = jest.fn();

        jest.spyOn(HandlesController, 'parseQueryAndSearchHandles').mockReturnValue({
            searchTotal: 2,
            handles: [
                { name: 'root1', utxo: 'tx#0' },
                { name: 'root2', utxo: 'tx#1' }
            ] as any
        });

        await controller.index(req, res, next);

        expect(res.set).toHaveBeenCalledWith('Content-Type', 'text/plain; charset=utf-8');
        expect(res.send).toHaveBeenCalledWith('root1\nroot2');
        expect(res.json).not.toHaveBeenCalled();
    });

    it('should call next when search throws', async () => {
        const controller = new RootHandlesController();
        const req = mockRequest();
        const res = mockResponse();
        const next = jest.fn();
        const error = new Error('boom');

        jest.spyOn(HandlesController, 'parseQueryAndSearchHandles').mockImplementation(() => {
            throw error;
        });

        await controller.index(req, res, next);

        expect(next).toHaveBeenCalledWith(error);
    });
});
