export const CREDENTIALS = process.env.CREDENTIALS === 'true';
export const isDatumEndpointEnabled = () => process.env.ENABLE_DATUM_ENDPOINT === 'true';
export const {
    NODE_ENV = '',
    PORT = '',
    SECRET_KEY = '',
    LOG_FORMAT = '',
    LOG_DIR = '',
    ORIGIN = process.env.CORS_ORIGIN || '',
    OGMIOS_HOST = 'http://localhost:1337',
    NETWORK = '',
    DISABLE_HANDLES_SNAPSHOT = '',
    WHITELISTED_API_KEYS = ''
} = process.env;

export const getIpfsGateway = (backup = false) => {
    return backup
        ? process.env.IPFS_GATEWAY_BACKUP || 'https://ipfs.io/ipfs/'
        : process.env.IPFS_GATEWAY || 'https://ipfs.io/ipfs/';
};