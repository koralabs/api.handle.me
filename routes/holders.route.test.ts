import { ERROR_TEXT, HttpException } from '@koralabs/kora-labs-common';
import request from 'supertest';
import App from '../app';

jest.mock('../services/ogmios/ogmios.service');

jest.mock('../repositories/handlesRepository', () => ({
    HandlesRepository: jest.fn().mockImplementation(() => ({
        getHolderAddressDetails: (key: string) => {
            if (key === 'nope') {
                throw new HttpException(404, 'Not found');
            }

            return {
                handles: ['burritos'],
                default_handle: 'burritos',
                manually_set: false
            };
        },
        getAllHolders: () => {
            return [
                {
                    handles: ['burritos', 'tacos'],
                    total_handles: 1001,
                    default_handle: 'my_default',
                    manually_set: false,
                    address: 'addr1',
                    known_owner_name: 'funnable.token',
                    type: 'script'
                }
            ];
        },
        getHolder: (key: string) => {
            if (key !== 'nope') {
                return {
                    handles: ['burritos'],
                    default_handle: 'burritos',
                    manually_set: false
                }
            }
        },
        currentHttpStatus: () => {
            return 200;
        }
    }))
}));

afterAll(async () => {
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 500));
});

describe('Testing Holders Routes', () => {
    let app: App | null;
    beforeEach(async () => {
        app = await new App().initialize();
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('[GET] /holders', () => {
        it('should throw error if records_per_page is invalid', async () => {
            const response = await request(app?.getServer()).get('/holders?records_per_page=two');
            expect(response.status).toEqual(400);
            expect(response.body.message).toEqual(ERROR_TEXT.HANDLE_LIMIT_INVALID_FORMAT);
        });

        it('should throw error if sort is invalid', async () => {
            const response = await request(app?.getServer()).get('/holders?records_per_page=1&sort=hmm');

            expect(response.status).toEqual(400);
            expect(response.body.message).toEqual(ERROR_TEXT.HANDLE_SORT_INVALID);
        });

        it('should throw error if records_per_page exceeds 250', async () => {
            const response = await request(app?.getServer()).get('/holders?records_per_page=251');

            expect(response.status).toEqual(400);
            expect(response.body.message).toEqual("'records_per_page' must be 250 or less");
        });

        it('should return holders', async () => {
            const response = await request(app?.getServer()).get('/holders?records_per_page=1&sort=asc');

            expect(response.status).toEqual(200);
            expect(response.body).toEqual([{
                total_handles: 1001,
                default_handle: 'my_default',
                manually_set: false,
                address: 'addr1',
                known_owner_name: 'funnable.token',
                type: 'script'
            }]);
        });
    });

    describe('[GET] /holders/:address', () => {
        it('should throw error if address does not exist', async () => {
            const response = await request(app?.getServer()).get('/holders/nope');
            expect(response.status).toEqual(404);
            expect(response.body).toEqual(expect.objectContaining({
                error: 'holder_not_found',
                message: 'Holder not found'
            }));
        });

        it('should return valid handle', async () => {
            const response = await request(app?.getServer()).get('/holders/address');
            expect(response.status).toEqual(200);
            expect(response.body).toEqual({
                handles: ['burritos'],
                default_handle: 'burritos',
                manually_set: false
            });
        });
    });
});
