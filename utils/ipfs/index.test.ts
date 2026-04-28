import * as cbor from '@koralabs/kora-labs-common/utils/cbor';
import { Logger } from '@koralabs/kora-labs-common';
import * as config from '../../config';
import * as kms from '../kms';
import { decodeCborFromIPFSFile } from './index';
import * as ipfs from './requestIpfs';

jest.mock('../../config');
jest.mock('../kms', () => ({
    hydrateKmsKeysIfNeeded: jest.fn()
}));
jest.mock('./requestIpfs');

describe('decodeCborFromIPFSFile tests', () => {
    const originalPinataGatewayToken = process.env.PINATA_GATEWAY_TOKEN;
    const originalPinataGatewayTokenEnc = process.env.PINATA_GATEWAY_TOKEN_ENC;

    afterEach(() => {
        process.env.PINATA_GATEWAY_TOKEN = originalPinataGatewayToken;
        process.env.PINATA_GATEWAY_TOKEN_ENC = originalPinataGatewayTokenEnc;
        jest.clearAllMocks();
    });

    it('should return ipfs json', async () => {
        jest.spyOn(config, 'getIpfsGateway').mockReturnValue('https://ipfs.io/ipfs/');
        jest.spyOn(ipfs, 'requestIpfs').mockResolvedValue({
            statusCode: 200,
            cbor: 'd879'
        });
        jest.spyOn(cbor, 'decodeCborToJson').mockResolvedValue({ test: 'test' });

        const result = await decodeCborFromIPFSFile('zb2rhYHWj4Ls35aM5V1odX38rSJJSFyvq3x4dyfbFPwCBRBTA');
        expect(result).toEqual({ test: 'test' });
    });

    it('should return hit the backup if first ipfs link was unsuccessful', async () => {
        jest.spyOn(config, 'getIpfsGateway').mockReturnValue('https://ipfs.io/ipfs/');
        process.env.PINATA_GATEWAY_TOKEN = 'backup-token';
        const requestIpfsSpy = jest
            .spyOn(ipfs, 'requestIpfs')
            .mockResolvedValueOnce({
                statusCode: 400,
                cbor: ''
            })
            .mockResolvedValueOnce({
                statusCode: 200,
                cbor: 'd879'
            });
        jest.spyOn(cbor, 'decodeCborToJson').mockResolvedValue({ test: 'test' });

        const cid = 'zb2rhYHWj4Ls35aM5V1odX38rSJJSFyvq3x4dyfbFPwCBRBTA';
        const result = await decodeCborFromIPFSFile(cid);
        expect(result).toEqual({ test: 'test' });
        expect(requestIpfsSpy).toBeCalledTimes(2);
        expect(requestIpfsSpy).nthCalledWith(2, `https://ipfs.io/ipfs/${cid}?pinataGatewayToken=backup-token`);
    });

    it('hydrates the pinata token lazily before calling the backup gateway', async () => {
        jest.spyOn(config, 'getIpfsGateway').mockReturnValue('https://ipfs.io/ipfs/');
        delete process.env.PINATA_GATEWAY_TOKEN;
        process.env.PINATA_GATEWAY_TOKEN_ENC = 'ciphertext';
        const hydrateSpy = kms.hydrateKmsKeysIfNeeded as jest.MockedFunction<typeof kms.hydrateKmsKeysIfNeeded>;
        hydrateSpy.mockImplementation(async () => {
            process.env.PINATA_GATEWAY_TOKEN = 'lazy-backup-token';
        });
        const requestIpfsSpy = jest
            .spyOn(ipfs, 'requestIpfs')
            .mockResolvedValueOnce({
                statusCode: 500,
                cbor: undefined
            })
            .mockResolvedValueOnce({
                statusCode: 200,
                cbor: 'd879'
            });
        jest.spyOn(cbor, 'decodeCborToJson').mockResolvedValue({ test: 'test' });

        const cid = 'zb2lazybackup';
        const result = await decodeCborFromIPFSFile(cid);

        expect(result).toEqual({ test: 'test' });
        expect(hydrateSpy).toHaveBeenCalledWith(['PINATA_GATEWAY_TOKEN']);
        expect(requestIpfsSpy).toHaveBeenLastCalledWith(`https://ipfs.io/ipfs/${cid}?pinataGatewayToken=lazy-backup-token`);
    });

    it('should unwrap constructor_0 encoded payloads', async () => {
        jest.spyOn(config, 'getIpfsGateway').mockReturnValue('https://ipfs.io/ipfs/');
        jest.spyOn(ipfs, 'requestIpfs').mockResolvedValue({
            statusCode: 200,
            cbor: 'd879'
        });
        jest.spyOn(cbor, 'decodeCborToJson').mockReturnValue({
            constructor_0: [{ fromConstructor: true }]
        } as any);

        const result = await decodeCborFromIPFSFile('zb2constructor');
        expect(result).toEqual({ fromConstructor: true });
    });

    it('should log and return undefined when request result contains error', async () => {
        jest.spyOn(config, 'getIpfsGateway').mockReturnValue('https://ipfs.io/ipfs/');
        jest.spyOn(ipfs, 'requestIpfs').mockResolvedValue({
            statusCode: 200,
            error: 'upstream error',
            cbor: undefined
        });
        const logSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());

        const result = await decodeCborFromIPFSFile('zb2error');

        expect(result).toBeUndefined();
        expect(logSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                event: 'decodeCborFromIPFSFile.error'
            })
        );
    });

    it('should log parse errors when cbor decoding fails', async () => {
        jest.spyOn(config, 'getIpfsGateway').mockReturnValue('https://ipfs.io/ipfs/');
        jest.spyOn(ipfs, 'requestIpfs').mockResolvedValue({
            statusCode: 200,
            cbor: 'd879'
        });
        jest.spyOn(cbor, 'decodeCborToJson').mockImplementation(() => {
            throw new Error('bad cbor');
        });
        const logSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());

        const result = await decodeCborFromIPFSFile('zb2badcbor');

        expect(result).toBeUndefined();
        expect(logSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                event: 'decodeCborFromIPFSFile.parseJSON.error'
            })
        );
    });

    it('should log and return undefined when backup gateway is invalid', async () => {
        const getGatewaySpy = jest
            .spyOn(config, 'getIpfsGateway')
            .mockReturnValueOnce('https://ipfs.io/ipfs/')
            .mockReturnValueOnce('invalid');
        jest.spyOn(ipfs, 'requestIpfs').mockResolvedValue({
            statusCode: 500,
            cbor: undefined
        });
        const logSpy = jest.spyOn(Logger, 'log').mockImplementation(jest.fn());

        const result = await decodeCborFromIPFSFile('zb2invalidbackup');

        expect(result).toBeUndefined();
        expect(getGatewaySpy).toBeCalledTimes(2);
        expect(logSpy).toHaveBeenCalledWith(
            expect.objectContaining({
                event: 'decodeCborFromIPFSFile.error',
                message: expect.stringContaining('Backup gateway')
            })
        );
    });
});
