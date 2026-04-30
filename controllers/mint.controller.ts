import { HandleType, INormalizedQueryParams } from '@koralabs/kora-labs-common';
import { NextFunction, Request, Response } from 'express';
import { mintMySubHandle } from '../services/minting.service';
import { ApiError } from '../utils/apiError';

/*********************************************
 * Used by api.handle.me for SubHandle mints
 * Not intended to work elsewhere
 *********************************************/
class MintController {
    public mint = async (req: Request<Request, {}, {}, INormalizedQueryParams>, res: Response, next: NextFunction ): Promise<void> => {
        try {
            const body = req.body as {
                handle: string;
                tx_hash: string;
                handle_type: HandleType;
                auth_client: string;
                access_token: string;
                send_address: string;
            };
            const { handle, tx_hash, handle_type, auth_client, access_token, send_address } = body;

            // For now, we only support minting subhandles. In the future, after DEMI, we will open this up to minting handles.
            if (handle_type == HandleType.HANDLE) {
                throw ApiError.handleTypeUnsupportedForMint();
            }

            const subHandleType = handle_type.replace('_subhandle', '');

            const results = await mintMySubHandle({
                handle,
                tx_hash,
                auth_client,
                access_token,
                subhandle_type: subHandleType,
                send_address
            });

            res.status(results.status).json(results.result);
        } catch (error) {
            next(error);
        }
    };
}

export default MintController;
