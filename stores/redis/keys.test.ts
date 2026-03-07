import { IndexNames } from '@koralabs/kora-labs-common';
import { extractApiIndexMember, getApiCacheKey, getApiCacheTag, getApiIndexKey, getApiIndexScanPattern, getApiMetricsKey, getApiScannerLeaseKey, getApiScannerRecoveryKey } from './keys';

describe('stores/redis/keys', () => {
    it('formats env-scoped hash tags and derived cache keys', () => {
        expect(getApiCacheTag('MAINNET')).toBe('{api:mainnet}');
        expect(getApiCacheKey('metrics', 'PREPROD')).toBe('{api:preprod}:metrics');
        expect(getApiMetricsKey('PREVIEW')).toBe('{api:preview}:metrics');
        expect(getApiScannerLeaseKey('PREVIEW')).toBe('{api:preview}:scanner:lease');
        expect(getApiScannerRecoveryKey('MAINNET')).toBe('{api:mainnet}:scanner:recovery');
    });

    it('builds scan patterns and extracts index members without breaking on the hash-tag colon', () => {
        const cacheKey = getApiIndexKey(IndexNames.UTXO, 'tx#0', 'PREVIEW');

        expect(getApiIndexScanPattern(IndexNames.UTXO, 'PREVIEW')).toBe('{api:preview}:utxo:*');
        expect(extractApiIndexMember(cacheKey, IndexNames.UTXO, 'PREVIEW')).toBe('tx#0');
    });
});
