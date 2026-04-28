import { LogCategory, Logger } from '@koralabs/kora-labs-common';
import { decodeCborToJson } from '@koralabs/kora-labs-common/utils/cbor';
import { getIpfsGateway } from '../../config';
import { hydrateKmsKeysIfNeeded } from '../kms';
import { requestIpfs } from './requestIpfs';

export const decodeCborFromIPFSFile = async (cid: string, schema?: any): Promise<any> => {
    let ipfsGateway = getIpfsGateway();

    try {
        let result = await requestIpfs(`${ipfsGateway}${cid}`).catch((error: any) => {return {
            statusCode: 500,
            error: error.message,
            cbor: undefined
        }});

        if (result.statusCode !== 200) {
            ipfsGateway = getIpfsGateway(true);
            if (ipfsGateway.length > 12) {
                await hydrateKmsKeysIfNeeded(['PINATA_GATEWAY_TOKEN']);
                const pinataGatewayToken = process.env.PINATA_GATEWAY_TOKEN?.trim();
                const backupGatewayUrl = pinataGatewayToken
                    ? `${ipfsGateway}${cid}?pinataGatewayToken=${pinataGatewayToken}`
                    : `${ipfsGateway}${cid}`;
                result = await requestIpfs(backupGatewayUrl).catch((error: any) => {return {
                    statusCode: 500,
                    error: error.message,
                    cbor: undefined
                }});
            } else {
                throw new Error(`Status from primary gateway resulted in status ${result.statusCode}. Backup gateway "${ipfsGateway}" is invalid`);
            }
        }

        const { cbor, error } = result;

        if (error) {
            Logger.log({
                message: `Error getting data from ${ipfsGateway}${cid} with error ${error}`,
                category: LogCategory.ERROR,
                event: 'decodeCborFromIPFSFile.error'
            });
            return;
        }

        if (cbor) {
            try {
                const json = decodeCborToJson({ cborString: cbor, schema });
                // eslint-disable-next-line no-prototype-builtins
                if (json.hasOwnProperty('constructor_0')) {
                    const [data] = json.constructor_0;
                    return data;
                }

                return json;
            } catch (error: any) {
                Logger.log({
                    message: `Error parsing json from ${ipfsGateway}${cid} with error ${error.message}`,
                    category: LogCategory.ERROR,
                    event: 'decodeCborFromIPFSFile.parseJSON.error'
                });
            }
        }
    } catch (error: any) {
        Logger.log({
            message: `Error getting data from ${ipfsGateway}${cid} data with error ${error.message}`,
            category: LogCategory.ERROR,
            event: 'decodeCborFromIPFSFile.error'
        });
    }
};
