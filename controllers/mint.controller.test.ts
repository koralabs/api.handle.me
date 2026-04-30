import { HandleType } from '@koralabs/kora-labs-common';
import MintController from './mint.controller'
jest.mock('../services/minting.service', () => {
    return {
        mintMySubHandle: jest.fn().mockResolvedValue({ status: 200, result: { success: true } })
    }
})
import {mintMySubHandle} from '../services/minting.service';

afterAll(async () => {
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 500));
});

const mockResponse = () => {
    const res = {json: jest.fn(), status: jest.fn()};
    res.json = jest.fn().mockReturnValue(res);
    res.status = jest.fn().mockReturnValue(res);
    return res;
}

describe('Mint Routes Test', () => {
    describe('[POST] /mint', () => {
        it('Should pass an ApiError to next() when trying to mint a regular Handle (so it picks up the canonical envelope)', async () => {
            const mintController = new MintController();
            const response = mockResponse();
            const next = jest.fn();
            const body =  {
                handle: 'test@handle',
                tx_hash: 'tx_123',
                handle_type: HandleType.HANDLE,
                auth_client: 'client-id',
                access_token: 'access-token',
                send_address: 'abc123'
            }
            await mintController.mint(
                // @ts-expect-error
                {body},
                response,
                next
            );

            expect(next).toHaveBeenCalledTimes(1);
            const err = next.mock.calls[0][0];
            expect(err).toEqual(expect.objectContaining({
                status: 400,
                code: 'handle_type_unsupported_for_mint'
            }));
        });

        it('Should mint SubHandle', async () => {
            const mintController = new MintController();
            const response = mockResponse();
            const body =  {
                handle: 'test@handle',
                tx_hash: 'tx_123',
                handle_type: HandleType.VIRTUAL_SUBHANDLE,
                auth_client: 'client-id',
                access_token: 'access-token',
                send_address: 'abc123'
            }
            await mintController.mint(
                // @ts-expect-error
                {body}, 
                response, 
                () => {}
            );
            expect(mintMySubHandle).toHaveBeenCalledWith({
                access_token: 'access-token',
                auth_client: 'client-id',
                handle: 'test@handle',
                send_address: 'abc123',
                subhandle_type: 'virtual',
                tx_hash: 'tx_123'
            });
            expect(response.status).toHaveBeenCalledWith(200);
        });

        it('Should map nft_subhandle to nft minting type', async () => {
            const mintController = new MintController();
            const response = mockResponse();
            const body =  {
                handle: 'test@handle',
                tx_hash: 'tx_456',
                handle_type: HandleType.NFT_SUBHANDLE,
                auth_client: 'client-id',
                access_token: 'access-token',
                send_address: 'abc123'
            }
            await mintController.mint(
                // @ts-expect-error
                {body},
                response,
                () => {}
            );
            expect(mintMySubHandle).toHaveBeenCalledWith({
                access_token: 'access-token',
                auth_client: 'client-id',
                handle: 'test@handle',
                send_address: 'abc123',
                subhandle_type: 'nft',
                tx_hash: 'tx_456'
            });
            expect(response.status).toHaveBeenCalledWith(200);
        });

        it('Should pass service errors to next middleware', async () => {
            const mintController = new MintController();
            const response = mockResponse();
            const next = jest.fn();
            const error = new Error('minting failed');
            (mintMySubHandle as jest.Mock).mockRejectedValueOnce(error);
            const body =  {
                handle: 'test@handle',
                tx_hash: 'tx_err',
                handle_type: HandleType.VIRTUAL_SUBHANDLE,
                auth_client: 'client-id',
                access_token: 'access-token',
                send_address: 'abc123'
            }

            await mintController.mint(
                // @ts-expect-error
                {body},
                response,
                next
            );

            expect(next).toHaveBeenCalledWith(error);
        });
    });
});
