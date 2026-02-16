import request from 'supertest';
import App from '../app';

jest.mock('../services/ogmios/ogmios.service');

jest.mock('../ioc/main.registry', () => ({
    ['handlesRepo']: jest.fn().mockReturnValue({
        getHandle: (handleName: string) => {
            if (['nope'].includes(handleName)) return null;

            return {
                handle: handleName
            };
        },
        getAll: () => {
            return [
                {
                    handle: 'burritos'
                }
            ];
        },
        getAllHandleNames: () => {
            return ['burritos', 'tacos', 'barbacoa'];
        },
        getHandleStats: () => {
            const stats = {
                percentage_complete: '',
                current_memory_used: 0,
                memory_size: 0,
                ogmios_elapsed: '',
                building_elapsed: '',
                slot_date: new Date(),
                handle_count: 0,
                current_slot: 0,
                current_block_hash: '',
                schema_version: 1
            };
            return stats;
        }
    }),
    ['apiKeysRepo']: jest.fn().mockReturnValue({
        get: (key: string) => key === 'valid-key'
    })
}));

afterAll(async () => {
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 500));
});

describe('Home Routes Test', () => {
    let app: App | null;
    beforeEach(async () => {
        app = await new App().initialize();
    });
    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('[GET] /home', () => {
        it('Should return 200', async () => {
            const response = await request(app?.getServer()).get('/');
            expect(response.status).toEqual(200);
            expect(response.body).toEqual({});
        });
    });
});
