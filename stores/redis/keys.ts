import { IndexNames, NETWORK } from '@koralabs/kora-labs-common';

const normalizeNetwork = (network = NETWORK) => `${network}`.toLowerCase();

export const getApiCacheTag = (network = NETWORK) => `{api:${normalizeNetwork(network)}}`;

export const getApiCacheKey = (suffix: string, network = NETWORK) => `${getApiCacheTag(network)}:${suffix}`;

export const getApiNamespaceScanPattern = (network = NETWORK) => `${getApiCacheTag(network)}:*`;

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

export const getApiMptRootHashKey = (network = NETWORK) => getApiCacheKey('mpt_root_hash', network);

// Set when the scan-finally MPT rebuild throws (Valkey blip, deadline overshoot, etc.). The
// next scanner invocation runs the rebuild even if currentSlot did not advance, so a stale
// stored mpt_root_hash doesn't persist past one transient failure.
export const getApiMptRebuildPendingKey = (network = NETWORK) => getApiCacheKey('mpt_rebuild_pending', network);

// WS1 asset-label registry: a derived redis hash (field = handle name, value = sorted hex label
// set) holding ONLY handles with a non-empty registry value. Lets the per-tick MPT root build read
// every label set in one HGETALL instead of fetching all handles.
export const getApiRegistryLabelsKey = (network = NETWORK) => getApiCacheKey('registry_labels', network);

// WS1 free-virtual allowance: a derived redis hash (field = ROOT handle name, value = comma-delimited
// hex free-name set) holding ONLY roots with a non-empty free-name set. Same one-HGETALL pattern as
// the label hash; composes with it into the root key's MPT value.
export const getApiRegistryFreeNamesKey = (network = NETWORK) => getApiCacheKey('registry_free_names', network);

// Sorted set: score=slot, value=blockHash. One entry per block the scanner has processed,
// whether or not that block contained handle txs. Enables processRollback to identify
// truly-missed canonical blocks (vs. blocks we correctly scanned but that had no handle
// activity, which would otherwise be false positives for missed-block drift detection).
export const getApiScannedBlocksKey = (network = NETWORK) => getApiCacheKey('scanned_blocks', network);
