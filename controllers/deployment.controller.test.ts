import * as fs from 'fs';
import DeploymentController from './deployment.controller';

jest.mock('fs', () => ({
    ...jest.requireActual('fs'),
    readFileSync: jest.fn()
}));

const mockResponse = () => {
    const res = {
        json: jest.fn(),
        status: jest.fn()
    } as any;
    res.json.mockReturnValue(res);
    res.status.mockReturnValue(res);
    return res;
};

describe('DeploymentController tests', () => {
    afterEach(() => {
        jest.clearAllMocks();
    });

    it('should return parsed deployment json', async () => {
        const controller = new DeploymentController();
        const res = mockResponse();
        const next = jest.fn();

        (fs.readFileSync as jest.Mock).mockReturnValue(Buffer.from('{"version":"1.0.0"}'));

        await controller.index({} as any, res, next);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith({ version: '1.0.0' });
    });

    it('should call next when deployment file load fails', async () => {
        const controller = new DeploymentController();
        const res = mockResponse();
        const next = jest.fn();
        const error = new Error('file missing');

        (fs.readFileSync as jest.Mock).mockImplementation(() => {
            throw error;
        });

        await controller.index({} as any, res, next);

        expect(next).toHaveBeenCalledWith(error);
    });
});
