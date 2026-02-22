import * as common from '@koralabs/kora-labs-common';
import DatumController from './datum.controller';

describe('DatumController', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('returns 200 for unsupported conversion requests', async () => {
        const controller = new DatumController();
        const sendStatus = jest.fn();

        await controller.index(
            {
                query: { from: 'unsupported', to: 'unsupported' },
                body: {}
            } as any,
            { sendStatus } as any,
            jest.fn()
        );

        expect(sendStatus).toHaveBeenCalledWith(200);
    });

    it('forwards conversion errors to next', async () => {
        const controller = new DatumController();
        const next = jest.fn();
        jest.spyOn(common, 'encodeJsonToDatum').mockRejectedValue(new Error('encode failure'));

        await controller.index(
            {
                query: { from: 'json', to: 'plutus_data_cbor' },
                body: [{ hello: 'world' }]
            } as any,
            {
                status: jest.fn().mockReturnThis(),
                contentType: jest.fn().mockReturnThis(),
                send: jest.fn()
            } as any,
            next
        );

        expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'encode failure' }));
    });

    it('passes explicit encode options from query params', async () => {
        const controller = new DatumController();
        const encodeSpy = jest.spyOn(common, 'encodeJsonToDatum').mockResolvedValue('encoded-value');
        const res = {
            status: jest.fn().mockReturnThis(),
            contentType: jest.fn().mockReturnThis(),
            send: jest.fn()
        } as any;

        await controller.index(
            {
                query: {
                    from: 'json',
                    to: 'plutus_data_cbor',
                    numeric_keys: 'true',
                    chunk_size: '99',
                    indefinite_arrays: 'false',
                    default_to_text: 'true'
                },
                body: { hello: 'world' }
            } as any,
            res,
            jest.fn()
        );

        expect(encodeSpy).toHaveBeenCalledWith(
            { hello: 'world' },
            {
                numericKeys: true,
                chunkSize: 99,
                indefiniteArrays: false,
                defaultToText: true
            }
        );
        expect(res.send).toHaveBeenCalledWith('encoded-value');
    });

    it('uses default schema when decoding json request body with cbor only', async () => {
        const controller = new DatumController();
        const decodeSpy = jest.spyOn(common, 'decodeCborToJson').mockReturnValue({ ok: true } as any);
        const res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn()
        } as any;

        await controller.index(
            {
                query: {
                    from: 'plutus_data_cbor',
                    to: 'json',
                    default_key_type: 'string'
                },
                headers: { 'content-type': 'application/json' },
                body: { cbor: 'abcd' }
            } as any,
            res,
            jest.fn()
        );

        expect(decodeSpy).toHaveBeenCalledWith({
            cborString: 'abcd',
            schema: {},
            defaultKeyType: 'string'
        });
        expect(res.json).toHaveBeenCalledWith({ ok: true });
    });
});
