import request from 'supertest';
import App from '../app';

jest.mock('../services/ogmios/ogmios.service');

jest.mock('../repositories/handlesRepository', () => ({
    HandlesRepository: jest.fn().mockImplementation(() => ({
        getMetrics: () => {
            return {
                handleCount: 10,
                holderCount: 5
            };
        },
        currentHttpStatus: () => {
            return 200;
        },
        isCaughtUp: () => jest.fn().mockReturnValue(true)
    }))
}
));

afterAll(async () => {
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 500));
});

describe('Stats Routes Test', () => {
    let app: App | null;
    beforeEach(async () => {
        app = await new App().initialize();
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('[GET] /stats', () => {
        it('Should return 200', async () => {
            const response = await request(app?.getServer()).get('/stats');
            expect(response.status).toEqual(200);
            expect(response.body).toEqual({ total_handles: 10, total_holders: 5 });
        });
    });
});
