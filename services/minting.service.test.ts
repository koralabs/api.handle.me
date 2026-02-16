import { MINTING_SERVICE_URL } from '../config/constants';
import { mintMySubHandle } from './minting.service';

describe('minting.service tests', () => {
    const originalFetch = global.fetch;

    afterEach(() => {
        global.fetch = originalFetch;
        jest.restoreAllMocks();
    });

    it('should call minting service with mapped payload fields', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            status: 200,
            json: async () => ({ success: true })
        });
        global.fetch = fetchMock as any;

        const result = await mintMySubHandle({
            handle: 'sub@root',
            tx_hash: 'tx_123',
            auth_client: 'client-id',
            access_token: 'token-abc',
            subhandle_type: 'virtual',
            send_address: 'addr_test1xyz'
        });

        expect(fetchMock).toHaveBeenCalledWith(`${MINTING_SERVICE_URL}/mint-my-subhandle`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                handle: 'sub@root',
                txHash: 'tx_123',
                clientId: 'client-id',
                accessToken: 'token-abc',
                subHandleType: 'virtual',
                sendAddress: 'addr_test1xyz'
            })
        });
        expect(result).toEqual({
            status: 200,
            result: { success: true }
        });
    });

    it('should return non-200 status and response body from service', async () => {
        const fetchMock = jest.fn().mockResolvedValue({
            status: 401,
            json: async () => ({ error: 'unauthorized' })
        });
        global.fetch = fetchMock as any;

        const result = await mintMySubHandle({
            handle: 'sub@root',
            tx_hash: 'tx_456',
            auth_client: 'bad-client',
            access_token: 'bad-token',
            subhandle_type: 'nft',
            send_address: 'addr_test1xyz'
        });

        expect(result).toEqual({
            status: 401,
            result: { error: 'unauthorized' }
        });
    });
});
