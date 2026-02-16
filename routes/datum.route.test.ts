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

describe('Datum Routes Test', () => {
    let app: App | null;
    beforeEach(async () => {
        app = await new App().initialize();
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('[POST] /datum', () => {
        const social = [
            {
                color: '0x000000',
                display: 'taco'
            },
            {
                color: '0xffffff',
                display: 'burrito'
            }
        ];

        const cbor =
            '9fa245636f6c6f724300000047646973706c6179447461636fa245636f6c6f7243ffffff47646973706c6179476275727269746fff';

        it('Should return 200 and hex encoded CBOR', async () => {
            const response = await request(app?.getServer())
                .post('/datum?from=json&to=plutus_data_cbor')
                .set('Content-Type', 'application/json')
                .send(social);
            expect(response.status).toEqual(200);
            expect(response.text).toEqual(cbor);
        });

        it('Should return 200 and decoded JSON when passing in a string of CBOR', async () => {
            const response = await request(app?.getServer())
                .post('/datum?from=plutus_data_cbor&to=json')
                .set('Content-Type', 'text/plain')
                .send(cbor);
            expect(response.status).toEqual(200);

            // expect json with hex values because there was not schema provided
            expect(response.body).toEqual([
                { color: '0x000000', display: '0x7461636f' },
                { color: '0xffffff', display: '0x6275727269746f' }
            ]);
        });

        it('Should return 200 and CBOR decoded JSON', async () => {
            const response = await request(app?.getServer())
                .post('/datum?from=plutus_data_cbor&to=json')
                .set('Content-Type', 'application/json')
                .send({
                    cbor,
                    schema: {
                        '[all]': {
                            display: 'string'
                        }
                    }
                });
            expect(response.status).toEqual(200);
            expect(response.body).toEqual(social);
        });

        it('Should return 400 and CBOR is not provided', async () => {
            const response = await request(app?.getServer())
                .post('/datum?from=plutus_data_cbor&to=json')
                .set('Content-Type', 'application/json')
                .send({
                    schema: {
                        '[all]': {
                            display: 'string'
                        }
                    }
                });
            expect(response.status).toEqual(400);
            expect(response.body.message).toEqual('cbor required');
        });
    });
});
