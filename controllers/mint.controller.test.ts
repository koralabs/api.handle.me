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
        it('Should return 404 when trying to mint regular Handle', async () => {
            const mintController = new MintController();
            const response = mockResponse();
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
                () => {}
            );
            
            expect(response.status).toHaveBeenCalledWith(400);
            expect(response.json).toHaveBeenCalledWith({
                error: "handle_type: 'handle' is not supported for minting at this time."
            });
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
    });
});
