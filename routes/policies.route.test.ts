import { HttpException } from '@koralabs/kora-labs-common';
import * as cbor from '@koralabs/kora-labs-common/utils/cbor';
import request from 'supertest';
import App from '../app';

jest.mock('../services/ogmios/ogmios.service');

let mockedDatum: string | null = 'd87980';
let throwNotFound = false;
let mockedStatus = 200;

jest.mock('../repositories/handlesRepository', () => ({
    HandlesRepository: jest.fn().mockImplementation(() => ({
        getHandleDatumByName: (handleName: string) => {
            if (handleName !== 'handle_policies') {
                throw new HttpException(404, 'Not found');
            }
            if (throwNotFound) {
                throw new HttpException(404, 'Not found');
            }
            return mockedDatum;
        },
        currentHttpStatus: () => mockedStatus
    }))
}));

afterAll(async () => {
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 500));
});

describe('Policies Routes Test', () => {
    let app: App | null;

    beforeEach(async () => {
        mockedDatum = 'd87980';
        throwNotFound = false;
        mockedStatus = 200;
        app = await new App().initialize();
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('[GET] /policies', () => {
        it('should return normalized handle policy settings from tuple values', async () => {
            const decodeSpy = jest.spyOn(cbor, 'decodeCborToJson').mockReturnValue({
                '0xf0ff': [47931333, 0, 0],
                '0x6c32': [151974982, 170000000, 180000000]
            } as any);

            const response = await request(app?.getServer()).get('/policies');

            expect(response.status).toEqual(200);
            expect(response.body).toEqual({
                f0ff: {
                    first_minting_slot: 47931333,
                    last_minting_slot: null,
                    sunset_slot: null
                },
                '6c32': {
                    first_minting_slot: 151974982,
                    last_minting_slot: 170000000,
                    sunset_slot: 180000000
                }
            });
            expect(decodeSpy).toHaveBeenCalledWith({
                cborString: 'd87980',
                schema: {},
                defaultKeyType: 'hex'
            });
        });

        it('should force hex key decoding even when utf8 is requested', async () => {
            const decodeSpy = jest.spyOn(cbor, 'decodeCborToJson').mockReturnValue({
                '0xf0ff': [47931333, 0, 0]
            } as any);

            const response = await request(app?.getServer()).get('/policies?default_key_type=utf8');

            expect(response.status).toEqual(200);
            expect(response.body).toEqual({
                f0ff: {
                    first_minting_slot: 47931333,
                    last_minting_slot: null,
                    sunset_slot: null
                }
            });
            expect(decodeSpy).toHaveBeenCalledWith({
                cborString: 'd87980',
                schema: {},
                defaultKeyType: 'hex'
            });
        });

        it('should normalize from array-wrapped map format used by handle_policies datum', async () => {
            jest.spyOn(cbor, 'decodeCborToJson').mockReturnValue([
                {
                    '0xf0ff': [47931333, 0, 0]
                }
            ] as any);

            const response = await request(app?.getServer()).get('/policies');

            expect(response.status).toEqual(200);
            expect(response.body).toEqual({
                f0ff: {
                    first_minting_slot: 47931333,
                    last_minting_slot: null,
                    sunset_slot: null
                }
            });
        });

        it('should return 404 when policies datum is missing', async () => {
            mockedDatum = null;

            const response = await request(app?.getServer()).get('/policies');

            expect(response.status).toEqual(404);
            expect(response.body).toEqual(expect.objectContaining({
                error: 'policies_not_found',
                message: 'Handle policies not found'
            }));
        });

        it('should return 404 when policies handle is missing', async () => {
            throwNotFound = true;

            const response = await request(app?.getServer()).get('/policies');

            expect(response.status).toEqual(404);
            expect(response.body).toEqual(expect.objectContaining({
                error: 'policies_not_found',
                message: 'Handle policies not found'
            }));
        });

        it('should return 400 when policies datum decode fails', async () => {
            jest.spyOn(cbor, 'decodeCborToJson').mockImplementation(() => {
                throw new Error('decode failed');
            });

            const response = await request(app?.getServer()).get('/policies');

            expect(response.status).toEqual(400);
            expect(response.body).toEqual(expect.objectContaining({
                error: 'policies_decode_failed',
                message: 'Unable to decode handle policies datum to json'
            }));
        });

        it('should return 202 when store is still catching up', async () => {
            mockedStatus = 202;
            jest.spyOn(cbor, 'decodeCborToJson').mockReturnValue({ policy_id_1: [1, 0, 0] } as any);

            const response = await request(app?.getServer()).get('/policies');

            expect(response.status).toEqual(202);
            expect(response.body).toEqual({
                policy_id_1: {
                    first_minting_slot: 1,
                    last_minting_slot: null,
                    sunset_slot: null
                }
            });
        });
    });
});
