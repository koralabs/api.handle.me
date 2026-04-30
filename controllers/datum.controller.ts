import { decodeCborToJson, encodeJsonToDatum, KeyType } from '@koralabs/kora-labs-common';
import { NextFunction, Request, Response } from 'express';
import { ApiError } from '../utils/apiError';

class DatumController {
    public async index (req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            if (req.query.from === 'json' && req.query.to === 'plutus_data_cbor') {
                const encoded = await encodeJsonToDatum(req.body, { 
                    numericKeys: req.query.numeric_keys == 'true',
                    chunkSize: req.query.chunk_size ? parseInt(req.query.chunk_size.toString()) : 64,
                    indefiniteArrays: req.query.indefinite_arrays ? req.query.indefinite_arrays == 'true' : true,
                    defaultToText: req.query.default_to_text ? req.query.default_to_text == 'true' : false
                });
                res.status(200).contentType('text/plain; charset=utf-8').send(encoded);
                return;
            }

            if (req.query.from === 'plutus_data_cbor' && req.query.to === 'json') {
                if (req.headers?.['content-type']?.startsWith('text/plain')) {
                    const decoded = decodeCborToJson({ cborString: req.body, schema: {}, defaultKeyType: req.query.default_key_type as KeyType });
                    res.status(200).json(decoded);
                    return;
                }

                const { cbor, schema = {} } = req.body;
                if (!cbor) {
                    throw ApiError.cborRequired();
                }

                const decoded = decodeCborToJson({ cborString: cbor, schema, defaultKeyType: req.query.default_key_type as KeyType });
                res.status(200).json(decoded);
                return;
            }

            res.sendStatus(200);
        } catch (error) {
            next(error);
        }
    };
}

export default DatumController;
