import { IndexNames, NETWORK } from '@koralabs/kora-labs-common';

const normalizeNetwork = (network = NETWORK) => `${network}`.toLowerCase();

export const getApiCacheTag = (network = NETWORK) => `{api:${normalizeNetwork(network)}}`;

export const getApiCacheKey = (suffix: string, network = NETWORK) => `${getApiCacheTag(network)}:${suffix}`;

export const getApiIndexRootKey = (index: IndexNames, network = NETWORK) => getApiCacheKey(index, network);

export const getApiIndexKey = (index: IndexNames, key: string | number, network = NETWORK) => getApiCacheKey(`${index}:${key}`, network);

export const getApiIndexScanPattern = (index: IndexNames, network = NETWORK) => `${getApiIndexRootKey(index, network)}:*`;

export const extractApiIndexMember = (cacheKey: string, index: IndexNames, network = NETWORK) => {
    const prefix = `${getApiIndexRootKey(index, network)}:`;
    if (!cacheKey.startsWith(prefix)) return undefined;
    return cacheKey.slice(prefix.length);
};

export const getApiMetricsKey = (network = NETWORK) => getApiCacheKey('metrics', network);

export const getApiScannerLeaseKey = (network = NETWORK) => getApiCacheKey('scanner:lease', network);

export const getApiScannerRecoveryKey = (network = NETWORK) => getApiCacheKey('scanner:recovery', network);
