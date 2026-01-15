import { MINTING_SERVICE_URL } from "../config/constants";

/*********************************************
 * Used by api.handle.me for SubHandle mints
 * Not intended to work elsewhere
 *********************************************/
export const mintMySubHandle = async ({
    handle,
    tx_hash,
    auth_client,
    access_token,
    subhandle_type,
    send_address
}: {
    handle: string;
    tx_hash: string;
    subhandle_type: string;
    auth_client: string;
    access_token: string;
    send_address: string;
}) => {
    const results = await fetch(`${MINTING_SERVICE_URL}/mint-my-subhandle`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            handle,
            txHash: tx_hash,
            clientId: auth_client,
            accessToken: access_token,
            subHandleType: subhandle_type,
            sendAddress: send_address
        })
    });

    return {
        status: results.status,
        result: (await results.json()) as Record<string, unknown>
    };
};
