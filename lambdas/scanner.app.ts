import { AssetNameLabel, asyncForEach, buildHolderInfo, HANDLE_POLICIES, IndexNames, LockedLambdaReason, LogCategory, Logger, MintingData, Network, NETWORK, StoredHandle, UTxOFunctionName, UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import { WHITELISTED_API_KEYS } from '../config';
import { BlockfrostBlock, KoiosAssetUTxO, KoiosDatumInfo, KoiosTxInfo } from '../interfaces/provider.interface';
import { HandlesRepository } from '../repositories/handlesRepository';
import { getHandleNameFromAssetName } from '../services/ogmios/utils';
import { RedisHandlesStore } from '../stores/redis';
import { getApiScannerLeaseKey, getApiScannerRecoveryKey } from '../stores/redis/keys';
import { blockfrostApiCall, buildUTxOsFromKoiosTxs, defaultKoiosSettings, fetchBlockfrostDatumCbor, fetchBlockfrostTxHashes, fetchBlockfrostTxInfo, fetchKoios, fetchPaginatedResults } from '../utils/helpers';
import { buildAndStoreMptRootHash, getChainMintingDataRootHash } from '../utils/snapshotVerification';

const store = new RedisHandlesStore(); // I hate this
const handlesRepo = new HandlesRepository(store);
let initialized = false;

const SCANNER_LEASE_KEY = getApiScannerLeaseKey();
const SCANNER_RECOVERY_KEY = getApiScannerRecoveryKey();
const SCANNER_LEASE_TTL_MS = 60_000;
const SCANNER_LEASE_HEARTBEAT_MS = 20_000;
const KOIOS_RETRY_DELAYS_MS = [500, 1_500, 4_000];
const KOIOS_TX_INFO_SOFT_BODY_LIMIT = 3_000;
const KOIOS_BLOCK_TXS_SOFT_BODY_LIMIT = 3_000;
// CloudWatch failures on 2026-02-16 showed tx_info batches failing at 66-71 hashes.
const KOIOS_TX_INFO_MAX_HASHES_PER_BATCH = 35;
const scannerKoiosTxInfoSettings = { ...defaultKoiosSettings, _scripts: true, _bytecode: true };
const KOIOS_TX_INFO_MAX_RPS = 6;
const KOIOS_TX_INFO_MIN_INTERVAL_MS = Math.ceil(1000 / KOIOS_TX_INFO_MAX_RPS);
const KOIOS_TX_INFO_MAX_RETRIES = KOIOS_RETRY_DELAYS_MS.length;
const KOIOS_DATUM_INFO_SOFT_BODY_LIMIT = 3_000;
const KOIOS_DATUM_INFO_MAX_RPS = 6;
const KOIOS_DATUM_INFO_MIN_INTERVAL_MS = Math.ceil(1000 / KOIOS_DATUM_INFO_MAX_RPS);
const KOIOS_DATUM_INFO_MAX_RETRIES = KOIOS_RETRY_DELAYS_MS.length;
const KOIOS_BLOCK_TXS_MAX_RPS = 6;
const KOIOS_BLOCK_TXS_MIN_INTERVAL_MS = Math.ceil(1000 / KOIOS_BLOCK_TXS_MAX_RPS);
const KOIOS_BLOCK_TXS_MAX_RETRIES = KOIOS_RETRY_DELAYS_MS.length;
const KOIOS_ASSET_UTXOS_MAX_RPS = 6;
const KOIOS_ASSET_UTXOS_MIN_INTERVAL_MS = Math.ceil(1000 / KOIOS_ASSET_UTXOS_MAX_RPS);
const KOIOS_ASSET_UTXOS_MAX_RETRIES = KOIOS_RETRY_DELAYS_MS.length;
const SCANNER_MAX_BLOCKS_PER_INVOCATION = 720;
const SCANNER_BLOCK_PREFETCH_CHUNK_SIZE = 30;
const SCANNER_HARD_DEADLINE_MS = 12 * 60_000;

class ScannerDeadlineError extends Error {
    constructor(step: string, elapsed: number) {
        super(`Scanner hard deadline (${SCANNER_HARD_DEADLINE_MS / 1000}s) reached at ${step} after ${elapsed}ms`);
        this.name = 'ScannerDeadlineError';
    }
}

let scannerDeadline = 0;
const ensureDeadlineSet = () => { if (!scannerDeadline) scannerDeadline = Date.now() + SCANNER_HARD_DEADLINE_MS; };
const checkDeadline = (step: string) => {
    ensureDeadlineSet();
    if (Date.now() >= scannerDeadline) {
        throw new ScannerDeadlineError(step, Date.now() - (scannerDeadline - SCANNER_HARD_DEADLINE_MS));
    }
};
const ROLLBACK_20_SLOT_WINDOW = 400; // 20 blocks * ~20 seconds per block
const RECOVERY_REASON_ROLLBACK = 'rollback';
const RECOVERY_REASON_REINDEX = 'reindex';
process.env.ENABLE_OGMIOS_SCANNING = 'false';
const LOCK_REASON_SNAPSHOT = 'SNAPSHOT' as LockedLambdaReason;

const staleLockTimeouts: Partial<Record<LockedLambdaReason, number>> = {
    [LockedLambdaReason.SCANNING]: 10 * 60 * 1000,
    [LockedLambdaReason.ROLLBACK]: 10 * 60 * 1000,
    [LockedLambdaReason.REINDEX]: 10 * 60 * 1000,
    [LockedLambdaReason.UTXO_IMPORT]: 10 * 60 * 1000,
    [LOCK_REASON_SNAPSHOT]: 10 * 60 * 1000
};

const ensureInitialized = async () => {
    if (initialized) return;
    await handlesRepo.initialize();
    initialized = true;
};

const acquireScannerLease = (owner: string): boolean => {
    const result = store.redisClientCall('set', SCANNER_LEASE_KEY, owner, {
        conditionalSet: 'onlyIfDoesNotExist',
        expiry: { type: 'PX', count: SCANNER_LEASE_TTL_MS }
    });
    return result === 'OK';
};

// Atomic compare-and-pexpire via Lua. A non-atomic GET + PEXPIRE would let a
// stale owner reach in during the TOCTOU window and extend a freshly-acquired
// lease belonging to another invocation.
const LEASE_RENEW_SCRIPT = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end";
const LEASE_RELEASE_SCRIPT = "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end";

const renewScannerLease = (owner: string): boolean => {
    const result = store.redisClientCall('customCommand', [
        'EVAL', LEASE_RENEW_SCRIPT, '1', SCANNER_LEASE_KEY, owner, `${SCANNER_LEASE_TTL_MS}`
    ]);
    return Number(result) === 1;
};

const releaseScannerLease = (owner: string): void => {
    store.redisClientCall('customCommand', [
        'EVAL', LEASE_RELEASE_SCRIPT, '1', SCANNER_LEASE_KEY, owner
    ]);
};

const setRecoveryFlag = (reason: string): void => {
    store.redisClientCall('set', SCANNER_RECOVERY_KEY, reason);
};

const getRecoveryFlag = (): string | undefined => {
    return store.redisClientCall('get', SCANNER_RECOVERY_KEY);
};

const getWhitelistedApiKeys = (): string[] => WHITELISTED_API_KEYS.split(',').map((key) => key.trim()).filter(Boolean);
const getKoiosRetryDelay = (attempt: number): number => KOIOS_RETRY_DELAYS_MS[attempt];

const clearRecoveryFlag = (): void => {
    store.redisClientCall('del', [SCANNER_RECOVERY_KEY]);
};

const getUTxOIndexHandlers = () => ({
    [UTxOFunctionName.ADD_UTXO]: handlesRepo.addUTxO.bind(handlesRepo),
    [UTxOFunctionName.UPDATE_HANDLE_INDEXES]: handlesRepo.updateHandleIndexes.bind(handlesRepo)
});

const isLockStale = (reason: LockedLambdaReason, lockTimestamp?: number): boolean => {
    if (!lockTimestamp) return false;
    const timeout = staleLockTimeouts[reason];
    if (!timeout) return false;
    return Date.now() - lockTimestamp > timeout;
};

const getKoiosBatches = (
    list: string[],
    keyName: string,
    {
        maxBodyLength,
        maxItemsPerBatch = Infinity,
        payload = {} as Record<string, unknown>
    }: {
        maxBodyLength: number;
        maxItemsPerBatch?: number;
        payload?: Record<string, unknown>;
    }
) => {
    const batchedList: string[][] = [];
    let batch: string[] = [];

    for (const item of list) {
        const nextBatch = [...batch, item];
        const exceedsBodyLimit = JSON.stringify({ [keyName]: nextBatch, ...payload }).length > maxBodyLength;
        const exceedsItemLimit = nextBatch.length > maxItemsPerBatch;

        if (batch.length && (exceedsBodyLimit || exceedsItemLimit)) {
            batchedList.push(batch);
            batch = [item];
            continue;
        }

        batch = nextBatch;
    }

    if (batch.length) {
        batchedList.push(batch);
    }

    return batchedList;
};

const delayMs = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const getTxInfoBody = (hashBatch: string[]) => JSON.stringify({ _tx_hashes: hashBatch, ...scannerKoiosTxInfoSettings });

const getDatumInfoBody = (hashBatch: string[]) => JSON.stringify({ _datum_hashes: hashBatch });

const getBlockTxsBody = (hashBatch: string[]) => JSON.stringify({ _block_hashes: hashBatch });

const getKoiosDebugCurl = (path: string, body: string) => {
    const host = NETWORK.toLowerCase() === 'mainnet' ? 'api' : NETWORK.toLowerCase();
    return `curl -v --http1.1 'https://${host}.koios.rest/api/v1/${path}' -H 'Content-Type: application/json' -H 'Authorization: Bearer <YOUR_KOIOS_BEARER_TOKEN>' --data-binary '${body}'`;
};

const getEventHeader = (event: any, headerName: string): string | undefined => {
    const headers = event?.headers as Record<string, string | undefined> | undefined;
    if (!headers) return undefined;
    const searchHeader = headerName.toLowerCase();
    for (const [header, value] of Object.entries(headers)) {
        if (header.toLowerCase() === searchHeader) return value;
    }
    return undefined;
};

const isFunctionUrlEvent = (event: any): boolean => Boolean(event?.requestContext?.http);

const parseBooleanValue = (value: unknown): boolean => {
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return false;
    return ['1', 'true', 'yes'].includes(value.trim().toLowerCase());
};

const shouldTriggerReindexShortcut = (event: any): boolean => {
    if (!isFunctionUrlEvent(event)) return false;

    const path = `${event?.rawPath ?? event?.requestContext?.http?.path ?? ''}`.trim();
    if (path === '/reindex' || path === '/scanner/reindex') return true;

    if (parseBooleanValue(event?.queryStringParameters?.reindex)) return true;

    if (!event?.body) return false;

    let rawBody = `${event.body}`;
    if (event?.isBase64Encoded) {
        rawBody = Buffer.from(rawBody, 'base64').toString('utf8');
    }

    try {
        const parsedBody = JSON.parse(rawBody);
        return parseBooleanValue(parsedBody?.reindex);
    } catch {
        return false;
    }
};

const extractRepairHandlesFromEvent = (event: any): string[] | null => {
    if (!isFunctionUrlEvent(event)) return null;
    const path = `${event?.rawPath ?? event?.requestContext?.http?.path ?? ''}`.trim();
    if (path !== '/repair-handles' && path !== '/scanner/repair-handles') return null;
    if (!event?.body) return [];
    let rawBody = `${event.body}`;
    if (event?.isBase64Encoded) {
        rawBody = Buffer.from(rawBody, 'base64').toString('utf8');
    }
    try {
        const parsedBody = JSON.parse(rawBody);
        if (Array.isArray(parsedBody?.handles) && parsedBody.handles.every((h: any) => typeof h === 'string')) {
            return parsedBody.handles;
        }
    } catch { /* fall through */ }
    return null;
};

const isWhitelistedScannerShortcutRequest = (event: any): boolean => {
    const apiKey = getEventHeader(event, 'api-key');
    return !!apiKey && getWhitelistedApiKeys().includes(apiKey);
};

const buildFunctionUrlResponse = (statusCode: number, body: { message: string; [key: string]: unknown }) => {
    return {
        isBase64Encoded: false,
        statusCode,
        headers: {
            'content-type': 'application/json'
        },
        body: JSON.stringify(body)
    };
};

const isRetriableKoiosError = (error: any): boolean => {
    const message = `${error?.message ?? ''} ${error?.cause?.message ?? ''}`.toLowerCase();
    const koiosResponseMessage = `${error?.koiosResponse?.message ?? error?.koiosResponse?.error ?? ''}`.toLowerCase();
    const code = `${error?.code ?? ''}`.toLowerCase();
    const koiosCode = `${error?.koiosResponse?.code ?? ''}`.toLowerCase();
    const causeCode = `${error?.cause?.code ?? ''}`.toLowerCase();
    const status = Number(error?.status ?? error?.statusCode ?? error?.status_code ?? error?.koiosResponse?.status ?? error?.koiosResponse?.status_code);

    if ([429, 502, 503, 504].includes(status)) return true;
    if (koiosCode === 'pgrst003') return true;
    if (code === 'und_err_socket' || causeCode === 'und_err_socket') return true;
    if (message.includes('terminated')) return true;
    if (message.includes('socket')) return true;
    if (message.includes('econnreset')) return true;
    if (message.includes('fetch failed')) return true;
    if (message.includes('aborted')) return true;
    if (message.includes('timed out')) return true;
    if (message.includes('gateway timeout')) return true;
    if (message.includes('too many requests')) return true;
    if (message.includes('payload too large')) return true;
    if (message.includes('timed out acquiring connection from connection pool')) return true;
    if (koiosResponseMessage.includes('gateway timeout')) return true;
    if (koiosResponseMessage.includes('too many requests')) return true;
    if (koiosResponseMessage.includes('payload too large')) return true;
    if (koiosResponseMessage.includes('timed out acquiring connection from connection pool')) return true;

    return false;
};

const fetchTxInfoBatchWithRetryAndSplit = async (hashBatch: string[], attempt = 0): Promise<KoiosTxInfo[]> => {
    checkDeadline('tx_info_retry');
    const body = getTxInfoBody(hashBatch);
    try {
        const txInfo = (await fetchKoios(`tx_info`, 'POST', body)) as KoiosTxInfo[] | null | { [key: string]: any };
        if (!txInfo) return [];
        if (!Array.isArray(txInfo)) {
            const error: any = new Error(`Unexpected tx_info response type`);
            error.koiosResponse = txInfo;
            throw error;
        }
        return txInfo;
    } catch (error: any) {
        const retriable = isRetriableKoiosError(error);
        Logger.local({
            message: `tx_info request failed. retriable=${retriable} attempt=${attempt + 1}/${KOIOS_TX_INFO_MAX_RETRIES + 1} hashCount=${hashBatch.length} bodyLength=${body.length} firstHash=${hashBatch[0] ?? ''} lastHash=${hashBatch[hashBatch.length - 1] ?? ''} code=${error?.code ?? ''} causeCode=${error?.cause?.code ?? ''} error=${error?.message ?? error} cause=${error?.cause?.message ?? ''} curl="${getKoiosDebugCurl('tx_info', body)}"`,
            category: LogCategory.INFO,
            event: 'scannerLambda.koiosTxInfo.requestFailed'
        });

        if (!retriable) throw error;

        if (attempt < KOIOS_TX_INFO_MAX_RETRIES) {
            const backoff = getKoiosRetryDelay(attempt);
            await delayMs(backoff);
            return fetchTxInfoBatchWithRetryAndSplit(hashBatch, attempt + 1);
        }

        if (hashBatch.length <= 1) throw error;

        const midpoint = Math.ceil(hashBatch.length / 2);
        const leftBatch = hashBatch.slice(0, midpoint);
        const rightBatch = hashBatch.slice(midpoint);
        Logger.local({
            message: `Splitting tx_info batch after retries. originalCount=${hashBatch.length} leftCount=${leftBatch.length} rightCount=${rightBatch.length}`,
            category: LogCategory.INFO,
            event: 'scannerLambda.koiosTxInfo.splitBatch'
        });

        const [leftTxInfo, rightTxInfo] = [await fetchTxInfoBatchWithRetryAndSplit(leftBatch), await fetchTxInfoBatchWithRetryAndSplit(rightBatch)];
        return [...leftTxInfo, ...rightTxInfo];
    }
};

const fetchDatumInfoBatchWithRetry = async (hashBatch: string[], attempt = 0): Promise<KoiosDatumInfo[]> => {
    checkDeadline('datum_info_retry');
    const body = getDatumInfoBody(hashBatch);
    try {
        const datumInfo = (await fetchKoios(`datum_info`, 'POST', body)) as KoiosDatumInfo[] | null | { [key: string]: any };
        if (!datumInfo) return [];
        if (!Array.isArray(datumInfo)) {
            const error: any = new Error(`Unexpected datum_info response type`);
            error.koiosResponse = datumInfo;
            throw error;
        }
        return datumInfo;
    } catch (error: any) {
        const retriable = isRetriableKoiosError(error);
        Logger.local({
            message: `datum_info request failed. retriable=${retriable} attempt=${attempt + 1}/${KOIOS_DATUM_INFO_MAX_RETRIES + 1} hashCount=${hashBatch.length} bodyLength=${body.length} firstHash=${hashBatch[0] ?? ''} lastHash=${hashBatch[hashBatch.length - 1] ?? ''} code=${error?.code ?? ''} causeCode=${error?.cause?.code ?? ''} error=${error?.message ?? error} cause=${error?.cause?.message ?? ''} curl="${getKoiosDebugCurl('datum_info', body)}"`,
            category: LogCategory.INFO,
            event: 'scannerLambda.koiosDatumInfo.requestFailed'
        });

        if (!retriable) throw error;

        if (attempt < KOIOS_DATUM_INFO_MAX_RETRIES) {
            const backoff = getKoiosRetryDelay(attempt);
            await delayMs(backoff);
            return fetchDatumInfoBatchWithRetry(hashBatch, attempt + 1);
        }

        throw error;
    }
};

const getBatchedTxInfo = async (txHashes: string[]) => {
    const batchedTxHashes = getKoiosBatches(txHashes, '_tx_hashes', {
        maxBodyLength: KOIOS_TX_INFO_SOFT_BODY_LIMIT,
        maxItemsPerBatch: KOIOS_TX_INFO_MAX_HASHES_PER_BATCH,
        payload: scannerKoiosTxInfoSettings
    });
    const txs: KoiosTxInfo[] = [];
    for (const hashBatch of batchedTxHashes) {
        const txInfo = await fetchTxInfoBatchWithRetryAndSplit(hashBatch);
        txs.push(...(txInfo ?? []));
        if (KOIOS_TX_INFO_MIN_INTERVAL_MS > 0) {
            await delayMs(KOIOS_TX_INFO_MIN_INTERVAL_MS);
        }
    }
    return txs;
};

const extractDatumHashes = (txInfo: KoiosTxInfo[]): string[] => [...new Set(
    txInfo.flatMap((tx) =>
        (tx.outputs ?? []).flatMap((output) => {
            if (output.inline_datum?.bytes || !output.datum_hash) return [];
            return [output.datum_hash];
        })
    )
)];

const getBatchedDatumInfo = async (txInfo: KoiosTxInfo[]) => {
    const datumHashes = extractDatumHashes(txInfo);

    const datumInfoByHash = new Map<string, string>();
    if (!datumHashes.length) return datumInfoByHash;

    const batchedDatumHashes = getKoiosBatches(datumHashes, '_datum_hashes', {
        maxBodyLength: KOIOS_DATUM_INFO_SOFT_BODY_LIMIT
    });

    await asyncForEach(batchedDatumHashes, async (hashBatch) => {
        const datumInfo = await fetchDatumInfoBatchWithRetry(hashBatch);
        datumInfo.forEach((datum) => {
            if (datum?.datum_hash && datum?.bytes) {
                datumInfoByHash.set(datum.datum_hash, datum.bytes);
            }
        });
    }, KOIOS_DATUM_INFO_MIN_INTERVAL_MS);

    return datumInfoByHash;
};


const fetchBlockTxHashBatchWithRetry = async (hashBatch: string[], attempt = 0): Promise<string[]> => {
    checkDeadline('block_txs_retry');
    const body = getBlockTxsBody(hashBatch);
    try {
        const txs = (await fetchKoios(`block_txs`, 'POST', body)) as { tx_hash: string }[] | null;
        return txs?.map((tx) => tx.tx_hash) ?? [];
    } catch (error: any) {
        const retriable = isRetriableKoiosError(error);
        Logger.local({
            message: `block_txs request failed. retriable=${retriable} attempt=${attempt + 1}/${KOIOS_BLOCK_TXS_MAX_RETRIES + 1} hashCount=${hashBatch.length} bodyLength=${body.length} firstHash=${hashBatch[0] ?? ''} lastHash=${hashBatch[hashBatch.length - 1] ?? ''} code=${error?.code ?? ''} causeCode=${error?.cause?.code ?? ''} error=${error?.message ?? error} cause=${error?.cause?.message ?? ''} curl="${getKoiosDebugCurl('block_txs', body)}"`,
            category: LogCategory.INFO,
            event: 'scannerLambda.koiosBlockTxs.requestFailed'
        });

        if (!retriable) throw error;

        if (attempt < KOIOS_BLOCK_TXS_MAX_RETRIES) {
            const backoff = getKoiosRetryDelay(attempt);
            await delayMs(backoff);
            return fetchBlockTxHashBatchWithRetry(hashBatch, attempt + 1);
        }

        if (hashBatch.length <= 1) throw error;

        const midpoint = Math.ceil(hashBatch.length / 2);
        const leftBatch = hashBatch.slice(0, midpoint);
        const rightBatch = hashBatch.slice(midpoint);
        Logger.local({
            message: `Splitting block_txs batch after retries. originalCount=${hashBatch.length} leftCount=${leftBatch.length} rightCount=${rightBatch.length}`,
            category: LogCategory.INFO,
            event: 'scannerLambda.koiosBlockTxs.splitBatch'
        });

        const [leftTxHashes, rightTxHashes] = [await fetchBlockTxHashBatchWithRetry(leftBatch), await fetchBlockTxHashBatchWithRetry(rightBatch)];
        return [...leftTxHashes, ...rightTxHashes];
    }
};

const fetchAssetUtxoBatchWithRetry = async (assetList: [string, string][], attempt = 0): Promise<KoiosAssetUTxO[] | null> => {
    checkDeadline('asset_utxos_retry');
    const body = JSON.stringify({ _asset_list: assetList, _extended: true });
    try {
        return (await fetchKoios(`asset_utxos`, 'POST', body)) as KoiosAssetUTxO[] | null;
    } catch (error: any) {
        const retriable = isRetriableKoiosError(error);
        Logger.local({
            message: `asset_utxos request failed. retriable=${retriable} attempt=${attempt + 1}/${KOIOS_ASSET_UTXOS_MAX_RETRIES + 1} assetCount=${assetList.length} bodyLength=${body.length} code=${error?.code ?? ''} causeCode=${error?.cause?.code ?? ''} error=${error?.message ?? error} cause=${error?.cause?.message ?? ''} curl="${getKoiosDebugCurl('asset_utxos', body)}"`,
            category: LogCategory.INFO,
            event: 'scannerLambda.koiosAssetUtxos.requestFailed'
        });

        if (!retriable || attempt >= KOIOS_ASSET_UTXOS_MAX_RETRIES) throw error;

        const backoff = getKoiosRetryDelay(attempt);
        await delayMs(backoff);
        return fetchAssetUtxoBatchWithRetry(assetList, attempt + 1);
    }
};

const getBatchedTxHashes = async (blockHashes: string[]) => {
    const batchedBlockHashes = getKoiosBatches(blockHashes, '_block_hashes', {
        maxBodyLength: KOIOS_BLOCK_TXS_SOFT_BODY_LIMIT
    });
    const txHashes: string[] = [];
    for (const hashBatch of batchedBlockHashes) {
        txHashes.push(...await fetchBlockTxHashBatchWithRetry(hashBatch));
        if (KOIOS_BLOCK_TXS_MIN_INTERVAL_MS > 0) {
            await delayMs(KOIOS_BLOCK_TXS_MIN_INTERVAL_MS);
        }
    }
    return txHashes;
};

// ========== Blockfrost per-iteration fallback wrappers ==========

const getBatchedTxHashesWithFallback = async (blockHashes: string[]): Promise<string[]> => {
    try {
        return await getBatchedTxHashes(blockHashes);
    } catch (error: any) {
        Logger.log({
            message: `Koios block_txs failed, falling back to Blockfrost: ${error?.message ?? error}`,
            category: LogCategory.WARN,
            event: 'scannerLambda.koiosBlockTxs.fallbackToBlockfrost'
        });
        return fetchBlockfrostTxHashes(blockHashes);
    }
};

const getBatchedTxInfoWithFallback = async (txHashes: string[]): Promise<KoiosTxInfo[]> => {
    try {
        return await getBatchedTxInfo(txHashes);
    } catch (error: any) {
        Logger.log({
            message: `Koios tx_info failed for ${txHashes.length} txs, falling back to Blockfrost: ${error?.message ?? error}`,
            category: LogCategory.WARN,
            event: 'scannerLambda.koiosTxInfo.fallbackToBlockfrost'
        });
        const results: KoiosTxInfo[] = [];
        for (const txHash of txHashes) {
            results.push(await fetchBlockfrostTxInfo(txHash));
        }
        return results;
    }
};

const getBatchedDatumInfoWithFallback = async (txInfo: KoiosTxInfo[]): Promise<Map<string, string>> => {
    try {
        return await getBatchedDatumInfo(txInfo);
    } catch (error: any) {
        Logger.log({
            message: `Koios datum_info failed, falling back to Blockfrost: ${error?.message ?? error}`,
            category: LogCategory.WARN,
            event: 'scannerLambda.koiosDatumInfo.fallbackToBlockfrost'
        });
        const datumHashes = extractDatumHashes(txInfo);
        const datumInfoByHash = new Map<string, string>();
        for (const datumHash of datumHashes) {
            const cbor = await fetchBlockfrostDatumCbor(datumHash);
            if (cbor) datumInfoByHash.set(datumHash, cbor);
        }
        return datumInfoByHash;
    }
};

const getBatchedUTxOsWithFallback = async (txHashes: string[], txs?: KoiosTxInfo[]) => {
    const txInfo = txs ?? await getBatchedTxInfoWithFallback(txHashes);
    const datumInfoByHash = await getBatchedDatumInfoWithFallback(txInfo);
    const utxos: UTxOWithTxInfo[] = [];
    utxos.push(...buildUTxOsFromKoiosTxs(txInfo, datumInfoByHash));
    return utxos;
};

const filterUTxOToHandleNames = (utxo: UTxOWithTxInfo, handleNames: Set<string>): UTxOWithTxInfo | undefined => {
    const filterAssets = (assets?: [string, string[]][]) =>
        assets?.map(([policy, names]) => {
            const filteredNames = names.filter((assetName) => assetName && handleNames.has(getHandleNameFromAssetName(assetName).name));
            return [policy, filteredNames] as [string, string[]];
        }).filter(([, names]) => names.length > 0);

    const filteredHandles = filterAssets(utxo.handles);
    if (!filteredHandles?.length) return undefined;

    return {
        ...utxo,
        handles: filteredHandles,
        mint: filterAssets(utxo.mint) ?? []
    };
};

const getLatestChainTip = async () => {
    const latestBlockResponse = await blockfrostApiCall('blocks/latest');
    if (latestBlockResponse.ok) {
        const latestBlock = await latestBlockResponse.json();
        return {
            hash: `${latestBlock?.hash ?? ''}`,
            slot: Number(latestBlock?.slot ?? 0),
            height: Number(latestBlock?.height ?? 0)
        };
    }

    try {
        const koiosTipResponse = await fetchKoios('tip');
        const latestTip = Array.isArray(koiosTipResponse) ? koiosTipResponse[0] : koiosTipResponse;
        if (!latestTip) return null;

        return {
            hash: `${latestTip?.hash ?? ''}`,
            slot: Number(latestTip?.abs_slot ?? 0),
            height: Number(latestTip?.block_height ?? latestTip?.block_no ?? 0)
        };
    } catch {
        return null;
    }
};

// Cardano's protocol limit for chain rollbacks is 2160 blocks (k), but in practice the deepest
// rollback ever observed is only a few blocks, and the scanner/API cannot meaningfully recover
// from anything beyond ~20 blocks anyway. Scanning the full 2160-block window every periodic
// rollback check costs tens of seconds in tx_info fetches across handle-free blocks for no real
// benefit. 20 blocks matches the practical limit and keeps the periodic check sub-second.
const DEFAULT_ROLLBACK_OFFSET = 20;

const processRollback = async ({ currentSlot, rollbackOffset = DEFAULT_ROLLBACK_OFFSET, suppressNotify = false }: { currentSlot: number; rollbackOffset?: number; suppressNotify?: boolean }) => {
    const rbStartedAt = Date.now();
    const rbBreadcrumb = (step: string, extra = '') => Logger.log({
        message: `[rollback:breadcrumb] ${step} at +${Date.now() - rbStartedAt}ms${extra ? ` | ${extra}` : ''}`,
        category: LogCategory.INFO,
        event: 'scannerLambda.rollback.breadcrumb'
    });

    // ===== PHASE 1: Fetch canonical block metadata (cheap — hashes only, no tx data) =====
    rbBreadcrumb('start', `offset=${rollbackOffset} currentSlot=${currentSlot}`);
    const latestBlock = await getLatestChainTip();
    rbBreadcrumb('getLatestChainTip_done', `height=${latestBlock?.height ?? 'null'}`);
    if (!latestBlock?.height) {
        const { lastSlot = 0 } = handlesRepo.getMetrics();
        handlesRepo.setMetrics({
            lastSlot: Math.max(Number(lastSlot ?? 0), Number(currentSlot ?? 0)),
            tipBlockHash: ''
        });
        Logger.log({
            message: `Unable to fetch latest block while checking rollback. Keeping an unknown tip hash and advancing the observed tip slot lower bound.`,
            category: LogCategory.WARN,
            event: 'scannerLambda.latestBlockUnavailable'
        });
        return;
    }

    const blockHeight = latestBlock.height - rollbackOffset;
    rbBreadcrumb('fetchBlockMetadata_start', `fromHeight=${blockHeight}`);
    const blockList: BlockfrostBlock[] = await fetchPaginatedResults(`blocks/${blockHeight}/next`);
    rbBreadcrumb('fetchBlockMetadata_done', `blocks=${blockList.length}`);
    const [firstBlock] = blockList;
    if (!firstBlock) return;

    const providerBlocks = blockList.filter((b) => b.slot <= currentSlot).sort((a, b) => a.slot - b.slot);
    if (!providerBlocks.length) return;

    // ===== PHASE 2: Find candidates for repair =====
    // A stored UTxO may be stale in two ways:
    //  (1) ORPHANED: its blockHash is not on the canonical chain (chain rollback happened)
    //  (2) DRIFTED:  its blockHash IS canonical, but the chain has since moved the handle
    //                to a newer UTxO that the scanner missed (missed-update bug)
    // We detect (1) here via hash-set comparison. (2) is detected in Phase 4 by comparing
    // each handle's stored tx_hash against its current on-chain tx_hash from asset_utxos.
    // Both types share the same repair path (Phase 5).
    const canonicalBlockHashes = new Set(blockList.map((b) => b.hash));

    const utxoIds = store.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, 0, { start: firstBlock.slot }) as string[];
    const utxos = (store.pipeline(() => {
        utxoIds.forEach((utxoId) => handlesRepo.getUTxO(utxoId));
    }) as UTxOWithTxInfo[]).filter(Boolean);

    const orphanedUtxos = utxos.filter((u) => u.blockHash && !canonicalBlockHashes.has(u.blockHash));
    rbBreadcrumb('orphan_check_done', `storedUtxos=${utxos.length} orphaned=${orphanedUtxos.length}`);

    if (!utxos.length) {
        // No stored UTxOs in the window — nothing to verify. Update head and return.
        const recoveredHead = providerBlocks[providerBlocks.length - 1];
        handlesRepo.setMetrics({
            currentBlockHash: recoveredHead.hash,
            currentSlot: recoveredHead.slot,
            ...(latestBlock.hash ? { tipBlockHash: latestBlock.hash } : {}),
            ...(latestBlock.slot > 0 ? { lastSlot: latestBlock.slot } : {})
        });
        return;
    }

    // ===== PHASE 3: Compute drift candidates (delta only) =====
    // A handle's stored state can diverge from canonical in exactly two ways within the window:
    //   (a) ORPHANED — a stored UTxO's blockHash is no longer canonical.
    //   (b) MISSED-BLOCK — a canonical block in the window has no stored UTxO from us AND
    //                       contained a handle tx we never indexed.
    // We do NOT broaden to every handle with stored state in the window. On mainnet, that set was
    // ~2000 handles / ~1888 asset_utxos results and blew out the 12-min scanner hard deadline in
    // a tight loop, holding the ROLLBACK lock and stalling the region.
    const orphanedHandles = new Set<string>();
    for (const utxo of orphanedUtxos) {
        for (const assets of utxo.handles ?? []) {
            assets[1].forEach((assetName) => {
                orphanedHandles.add(getHandleNameFromAssetName(assetName).name);
            });
        }
    }

    // "Blocks we have" is the authoritative scanned-blocks ledger — a record of every block the
    // scan loop fully processed, including the majority that carry zero handle txs. Deriving this
    // from stored UTxOs would falsely flag every handle-free canonical block as "missed" and
    // trigger thousands of unnecessary tx_info fetches per check.
    const scannedInWindow = store.getScannedBlockHashesInRange(firstBlock.slot, currentSlot);
    const unseenCanonicalBlocks = providerBlocks.filter((b) => !scannedInWindow.has(b.hash));
    rbBreadcrumb('unseen_blocks_scan', `canonical=${providerBlocks.length} scanned=${scannedInWindow.size} unseen=${unseenCanonicalBlocks.length}`);

    const missedBlockHandles = new Set<string>();
    if (unseenCanonicalBlocks.length) {
        const missedTxHashes = [...new Set(await getBatchedTxHashesWithFallback(unseenCanonicalBlocks.map((b) => b.hash)))];
        if (missedTxHashes.length) {
            const missedTxInfo = await getBatchedTxInfoWithFallback(missedTxHashes);
            const collectFromAssets = (assets: { policy_id: string; asset_name: string }[] | undefined) => {
                for (const asset of assets ?? []) {
                    if (HANDLE_POLICIES.contains(NETWORK as Network, asset.policy_id)) {
                        missedBlockHandles.add(getHandleNameFromAssetName(asset.asset_name).name);
                    }
                }
            };
            for (const tx of missedTxInfo) {
                collectFromAssets(tx.assets_minted);
                for (const output of tx.outputs ?? []) {
                    collectFromAssets(output.asset_list);
                }
            }
            rbBreadcrumb('missed_block_handles_done', `txs=${missedTxHashes.length} handles=${missedBlockHandles.size}`);
        }
    }

    const candidateHandles = new Set<string>([...orphanedHandles, ...missedBlockHandles]);

    if (!candidateHandles.size) {
        // No orphans, no missed-block activity — stored state matches canonical chain.
        const recoveredHead = providerBlocks[providerBlocks.length - 1];
        handlesRepo.setMetrics({
            currentBlockHash: recoveredHead.hash,
            currentSlot: recoveredHead.slot,
            ...(latestBlock.hash ? { tipBlockHash: latestBlock.hash } : {}),
            ...(latestBlock.slot > 0 ? { lastSlot: latestBlock.slot } : {})
        });
        return;
    }

    const candidateHandleList = [...candidateHandles];
    const storedHandles = store
        .pipeline(() => {
            candidateHandleList.forEach((handleName) => handlesRepo.getHandle(handleName));
        })
        .filter(Boolean) as StoredHandle[];

    rbBreadcrumb('candidates_gathered', `orphaned=${orphanedHandles.size} missedBlock=${missedBlockHandles.size} candidates=${candidateHandles.size} stored=${storedHandles.length}`);

    // ===== PHASE 4: Query canonical state for all handles in the window =====
    // Build batched asset_utxos queries for all handles (LBL_222/100/001 for CIP67, raw hex for legacy)
    const batchedHandles: [string, string][][] = [];
    let assetNames: [string, string][] = [];
    for (const storedHandle of storedHandles) {
        const { isCip67 } = getHandleNameFromAssetName(storedHandle.hex);
        assetNames.push([storedHandle.policy, storedHandle.hex]);
        if (isCip67) {
            const hexWithoutLabel = storedHandle.hex.slice(8);
            assetNames.push([storedHandle.policy, `${AssetNameLabel.LBL_100}${hexWithoutLabel}`]);
            assetNames.push([storedHandle.policy, `${AssetNameLabel.LBL_001}${hexWithoutLabel}`]);
        }
        if (JSON.stringify({ _asset_list: assetNames, _extended: true }).length >= 4700) {
            batchedHandles.push(assetNames);
            assetNames = [];
        }
    }
    if (assetNames.length) batchedHandles.push(assetNames);

    // Fetch asset_utxos — returns current on-chain UTxO location for each handle asset
    const handleTxHashes: string[] = [];
    const canonicalTxByHandle = new Map<string, string>();
    rbBreadcrumb('fetchAssetUtxos_start', `batchCount=${batchedHandles.length} handleCount=${storedHandles.length}`);
    await asyncForEach(batchedHandles, async (batch) => {
        const koiosUtxos = await fetchAssetUtxoBatchWithRetry(batch);
        if (koiosUtxos !== null) {
            for (const utxo of koiosUtxos) {
                handleTxHashes.push(utxo.tx_hash);
                // Extract handle → canonical tx mapping for drift detection
                for (const asset of utxo.asset_list ?? []) {
                    if (HANDLE_POLICIES.contains(NETWORK as Network, asset.policy_id)) {
                        const { name } = getHandleNameFromAssetName(asset.asset_name);
                        canonicalTxByHandle.set(name, utxo.tx_hash);
                    }
                }
            }
        }
    }, KOIOS_ASSET_UTXOS_MIN_INTERVAL_MS);
    rbBreadcrumb('fetchAssetUtxos_done', `handleTxHashes=${handleTxHashes.length}`);

    // ===== PHASE 4b: Identify handles needing repair (orphaned OR drifted) =====
    // orphanedHandles was computed in Phase 3 alongside the missed-block candidate set.
    const driftedHandles = new Set<string>();
    for (const storedHandle of storedHandles) {
        const storedTx = storedHandle.utxo?.split('#')[0];
        const canonicalTx = canonicalTxByHandle.get(storedHandle.name);
        if (canonicalTx && storedTx && storedTx !== canonicalTx) {
            driftedHandles.add(storedHandle.name);
        }
    }
    const handlesToRepair = new Set<string>([...orphanedHandles, ...driftedHandles]);
    rbBreadcrumb('drift_check_done', `orphanedHandles=${orphanedHandles.size} driftedHandles=${driftedHandles.size} toRepair=${handlesToRepair.size}`);

    if (!handlesToRepair.size) {
        // No repairs needed — stored state matches canonical chain.
        const recoveredHead = providerBlocks[providerBlocks.length - 1];
        handlesRepo.setMetrics({
            currentBlockHash: recoveredHead.hash,
            currentSlot: recoveredHead.slot,
            ...(latestBlock.hash ? { tipBlockHash: latestBlock.hash } : {}),
            ...(latestBlock.slot > 0 ? { lastSlot: latestBlock.slot } : {})
        });
        return;
    }

    // ===== PHASE 5: Fetch canonical UTxO data for handles needing repair =====
    rbBreadcrumb('fetchCanonicalUtxos_start');
    const canonicalHandleUTxOs = await getBatchedUTxOsWithFallback([...new Set(handleTxHashes)]);
    rbBreadcrumb('fetchCanonicalUtxos_done', `count=${canonicalHandleUTxOs.length}`);
    const repairCanonicalUTxOs = canonicalHandleUTxOs
        .map((utxo) => filterUTxOToHandleNames(utxo, handlesToRepair))
        .filter((utxo): utxo is UTxOWithTxInfo => !!utxo);

    // ===== PHASE 6: Repair =====
    const affectedStoredHandles = storedHandles.filter((h) => handlesToRepair.has(h.name));
    const repairHandleNames = [...handlesToRepair];

    // Identify stale UTxOs to remove: orphans + drift-source stored UTxOs for affected handles
    const staleUtxoIds = new Set<string>(orphanedUtxos.map((u) => u.id));
    for (const h of affectedStoredHandles) {
        if (driftedHandles.has(h.name) && h.utxo) staleUtxoIds.add(h.utxo);
    }

    const firstStaleHeight = orphanedUtxos.length
        ? Math.min(...orphanedUtxos.map((u) => u.blockNum))
        : latestBlock.height;
    const distanceFromTip = latestBlock.height - firstStaleHeight;
    Logger.log({
        message: `Rollback repair: orphaned=${orphanedHandles.size} drifted=${driftedHandles.size} (${distanceFromTip} blocks from tip)`,
        category: suppressNotify || distanceFromTip <= 20 ? LogCategory.WARN : LogCategory.NOTIFY,
        event: 'scannerLambda.rollbackDetected'
    });

    // Remove mint data created in the orphaned range (only applies if we have orphans —
    // drift is a pure transfer miss and doesn't involve rolled-back mints).
    if (orphanedUtxos.length) {
        const rollbackStartSlot = Math.min(...orphanedUtxos.map((u) => u.slot));
        const handlesMintingData = store.pipeline(() => {
            repairHandleNames.forEach((handleName) => handlesRepo.getHandleMintingData(handleName));
        }) as Set<string>[];
        store.pipeline(() => {
            repairHandleNames.forEach((handleName, index) => {
                const mintingDataSet = handlesMintingData[index];
                if (mintingDataSet) {
                    mintingDataSet.forEach((md) => {
                        const mintingData = JSON.parse(md) as MintingData;
                        if (mintingData.created_slot >= rollbackStartSlot) {
                            store.removeValueFromIndexedSet(IndexNames.MINT, handleName, md);
                        }
                    });
                }
            });
        });
    }

    // Update holders
    const stakeAddresses = affectedStoredHandles.map((h) => buildHolderInfo(h.resolved_addresses.ada).address);
    const holderHandles = store.pipeline(() => {
        stakeAddresses.forEach((address) => store.getValuesFromIndexedSet(IndexNames.HOLDER, address));
    }) as Set<string>[];
    const holdersMap = new Map<string, Set<string>>();
    stakeAddresses.forEach((address, index) => {
        holdersMap.set(address, holderHandles[index]);
    });
    store.pipeline(() => {
        affectedStoredHandles.forEach((handle) => handlesRepo.updateHolder(handle, holdersMap));
    });

    // Remove stale UTxOs (orphaned + drift-source)
    if (staleUtxoIds.size) handlesRepo.removeUTxOs([...staleUtxoIds]);

    // Add canonical UTxOs and minting data
    handlesRepo.addUTxOsWithMintData(repairCanonicalUTxOs);
    handlesRepo.addMintDataFromUTxOs(repairCanonicalUTxOs);

    // Rebuild indexes for affected handles
    const storedHandlesMap = new Map<string, StoredHandle>(affectedStoredHandles.map((h) => [h.name, h]));
    const retrievedMintingData = store.pipeline(() => {
        repairHandleNames.forEach((handleName) => handlesRepo.getHandleMintingData(handleName));
    }) as Set<string>[];
    const mintValueIndex: Map<string, MintingData[]> = new Map();
    retrievedMintingData.forEach((md, i) => {
        mintValueIndex.set(repairHandleNames[i], Array.from(md).map((md) => JSON.parse(md)));
    });
    store.pipeline(() => {
        for (const utxo of repairCanonicalUTxOs) {
            // Rollback repair deliberately replaces a known-stale utxo pointer with the canonical
            // one, so the ordinary double-mint detection would fire on every repair — falsely
            // bumping `handle.amount` and eventually breaking the burn threshold in removeHandle().
            handlesRepo.updateHandleIndexes(utxo, mintValueIndex, storedHandlesMap, undefined, { suppressDoubleMintDetection: true });
        }
    });

    rbBreadcrumb('repair_done', `removedUtxos=${staleUtxoIds.size} addedUtxos=${repairCanonicalUTxOs.length} repairedHandles=${handlesToRepair.size}`);

    // ===== PHASE 6: Update head to last canonical block at or before currentSlot =====
    const recoveredHead = providerBlocks[providerBlocks.length - 1];
    handlesRepo.setMetrics({
        currentBlockHash: recoveredHead.hash,
        currentSlot: recoveredHead.slot,
        ...(latestBlock.hash ? { tipBlockHash: latestBlock.hash } : {}),
        ...(latestBlock.slot > 0 ? { lastSlot: latestBlock.slot } : {})
    });
};

const checkRollback = async () => {
    const { currentSlot = 0 } = handlesRepo.getMetrics();
    try {
        handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.ROLLBACK, lockLambdasTimestamp: Date.now() });
        // Block metadata fetch covers the full 2160-block window (cheap — hashes only).
        // Only orphaned Handle UTxOs trigger expensive provider calls (targeted).
        await processRollback({ currentSlot });
    } catch (error: any) {
        if (error instanceof ScannerDeadlineError) {
            Logger.log({
                message: `${error.message}. Rollback incomplete — next invocation will retry.`,
                category: LogCategory.INFO,
                event: 'scannerLambda.deadlineReached'
            });
            return;
        }
        if (isRetriableKoiosError(error)) {
            Logger.log({
                message: `Retriable rollback reconciliation failure (will retry next invocation): ${error?.message ?? error}`,
                category: LogCategory.INFO,
                event: 'scannerLambda.rollbackRetriable'
            });
            return;
        }
        throw error;
    } finally {
        handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.UNLOCKED });
    }
};

const processReindex = async () => {
    setRecoveryFlag(RECOVERY_REASON_REINDEX);
    // Pause the lambdas (cron lock in redis)
    handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.REINDEX, lockLambdasTimestamp: Date.now() });

    Logger.log({ message: `Repopulating indexes from UTxOs to schema version ${store.getIndexSchemaVersion()}`, category: LogCategory.INFO, event: 'getStartingPoint.repopulateIndexesFromUTxOs' });
    try {
        // This function already chunks at a rate of about 20K every 10 seconds. 300K handles should take about 5 minutes
        store.repopulateIndexesFromUTxOs(getUTxOIndexHandlers());
        await buildAndStoreMptRootHash(store);
        handlesRepo.setMetrics({ indexSchemaVersion: store.getIndexSchemaVersion() });
        clearRecoveryFlag();
    } finally {
        handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.UNLOCKED });
    }
};

// processRollbackRecovery removed — rollbacks are handled inline in processRollback().
// A failed inline repair retries on the next invocation via the normal scan path.
// Full S3 reimports are only for schema version changes or manual resets, never for rollbacks.

const ensureUTxOsReady = async () => {
    const { currentBlockHash, currentSlot, utxoSchemaVersion = 0 } = handlesRepo.getMetrics();
    const currentUTxOSchemaVersion = Number(store.getUTxOSchemaVersion());
    if (currentUTxOSchemaVersion <= Number(utxoSchemaVersion) && currentBlockHash && currentSlot) return;

    handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.UTXO_IMPORT, lockLambdasTimestamp: Date.now() });
    Logger.log({
        message: `UTxOs are repopulating. currentBlockHash=${currentBlockHash ?? ''} currentSlot=${currentSlot ?? ''} storedUTxOSchemaVersion=${utxoSchemaVersion} targetUTxOSchemaVersion=${currentUTxOSchemaVersion}`,
        category: LogCategory.WARN,
        event: 'scannerLambda.repopulateUTxOs'
    });
    try {
        await handlesRepo.getStartingPoint(getUTxOIndexHandlers());
    } finally {
        handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.UNLOCKED });
    }
}

const clearStaleLockIfNeeded = (metrics: ReturnType<HandlesRepository['getMetrics']>) => {
    if (!metrics.lockLambdas || !isLockStale(metrics.lockLambdas, metrics.lockLambdasTimestamp)) return false;

    if (metrics.lockLambdas === LockedLambdaReason.SCANNING) {
        Logger.log({ message: `Scanner lambda has been locked for scanning for over 10 minutes, something is wrong!`, category: LogCategory.NOTIFY, event: 'scannerLambda.lockedTooLong' });
    }

    if (metrics.lockLambdas === LockedLambdaReason.ROLLBACK) {
        Logger.log({ message: `Scanner lambda has been locked for rollback for over 10 minutes, something is wrong!`, category: LogCategory.NOTIFY, event: 'scannerLambda.rollbackLockedTooLong' });
    }

    if (metrics.lockLambdas === LockedLambdaReason.REINDEX) {
        Logger.log({ message: `Scanner lambda has been locked for reindexing for over 10 minutes, something is wrong!`, category: LogCategory.NOTIFY, event: 'scannerLambda.reindexLockedTooLong' });
        setRecoveryFlag(RECOVERY_REASON_REINDEX);
    }

    if (metrics.lockLambdas === LOCK_REASON_SNAPSHOT) {
        Logger.log({ message: `Scanner lambda has been locked for snapshotting for over 10 minutes, something is wrong!`, category: LogCategory.NOTIFY, event: 'scannerLambda.snapshotLockedTooLong' });
    }

    handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.UNLOCKED });
    return true;
};

/**
 * Window-agnostic repair for a specific list of handle names.
 *
 * Unlike processRollback (which is scoped to a 2160-block window and catches
 * orphaned + drifted UTxOs within that window), this function repairs handles
 * regardless of how old their stored state is. It's used by the one-time
 * full-chain verification script to fix handles whose stored tx has drifted
 * further back than the rollback window reaches.
 *
 * Flow: load stored handles → asset_utxos for canonical locations → identify
 * drift → fetch tx_info → apply the same repair as processRollback.
 */
const repairHandles = async (handleNames: string[]): Promise<{ checked: number; repaired: number; notFound: number; inserted: number }> => {
    if (!handleNames.length) return { checked: 0, repaired: 0, notFound: 0, inserted: 0 };

    const storedHandles = store
        .pipeline(() => {
            handleNames.forEach((name) => handlesRepo.getHandle(name));
        })
        .filter(Boolean) as StoredHandle[];

    const storedByName = new Map(storedHandles.map((h) => [h.name, h]));
    const missingNames = handleNames.filter((n) => !storedByName.has(n));

    // Build asset_utxos batches for all target handles — both drift-check for
    // existing ones and broad lookup for missing ones.
    const networkKey = NETWORK.toLowerCase() as Network;
    const activePolicies = Object.keys(HANDLE_POLICIES[networkKey] ?? {});
    const batchedAssets: [string, string][][] = [];
    let assetNames: [string, string][] = [];
    const pushAsset = (policy: string, hex: string) => {
        assetNames.push([policy, hex]);
        if (JSON.stringify({ _asset_list: assetNames, _extended: true }).length >= 4700) {
            batchedAssets.push(assetNames);
            assetNames = [];
        }
    };
    for (const storedHandle of storedHandles) {
        const { isCip67 } = getHandleNameFromAssetName(storedHandle.hex);
        pushAsset(storedHandle.policy, storedHandle.hex);
        if (isCip67) {
            const hexWithoutLabel = storedHandle.hex.slice(8);
            pushAsset(storedHandle.policy, `${AssetNameLabel.LBL_100}${hexWithoutLabel}`);
            pushAsset(storedHandle.policy, `${AssetNameLabel.LBL_001}${hexWithoutLabel}`);
        }
    }
    // Missing handles: we don't know the asset form, so try every variant on
    // every active policy. Koios ignores non-existent assets cheaply.
    for (const name of missingNames) {
        const utf8hex = Buffer.from(name, 'utf8').toString('hex');
        for (const policy of activePolicies) {
            pushAsset(policy, utf8hex); // legacy (no label)
            pushAsset(policy, `${AssetNameLabel.LBL_222}${utf8hex}`); // CIP68 owner
            pushAsset(policy, `${AssetNameLabel.LBL_100}${utf8hex}`); // CIP68 reference
            pushAsset(policy, `${AssetNameLabel.LBL_000}${utf8hex}`); // virtual subhandle
        }
    }
    if (assetNames.length) batchedAssets.push(assetNames);

    // Query canonical state
    const canonicalTxHashes: string[] = [];
    const canonicalTxByHandle = new Map<string, string>();
    await asyncForEach(batchedAssets, async (batch) => {
        const koiosUtxos = await fetchAssetUtxoBatchWithRetry(batch);
        if (koiosUtxos !== null) {
            for (const utxo of koiosUtxos) {
                canonicalTxHashes.push(utxo.tx_hash);
                for (const asset of utxo.asset_list ?? []) {
                    if (HANDLE_POLICIES.contains(NETWORK as Network, asset.policy_id)) {
                        const { name } = getHandleNameFromAssetName(asset.asset_name);
                        canonicalTxByHandle.set(name, utxo.tx_hash);
                    }
                }
            }
        }
    }, KOIOS_ASSET_UTXOS_MIN_INTERVAL_MS);

    // Classify each target: drifted (stored tx ≠ canonical) | missing-and-on-chain (insert) | ok | not-on-chain
    const driftedHandles = storedHandles.filter((h) => {
        const storedTx = h.utxo?.split('#')[0];
        const canonical = canonicalTxByHandle.get(h.name);
        return canonical && storedTx && storedTx !== canonical;
    });
    const insertNames = missingNames.filter((n) => canonicalTxByHandle.has(n));
    const handlesToTouch = new Set<string>([...driftedHandles.map((h) => h.name), ...insertNames]);

    if (!handlesToTouch.size) {
        return { checked: handleNames.length, repaired: 0, notFound: handleNames.length - storedHandles.length, inserted: 0 };
    }

    // Fetch full tx_info for the canonical UTxOs we care about
    const canonicalHandleUTxOs = await getBatchedUTxOsWithFallback([...new Set(canonicalTxHashes)]);
    const touchedUTxOs = canonicalHandleUTxOs
        .map((utxo) => filterUTxOToHandleNames(utxo, handlesToTouch))
        .filter((utxo): utxo is UTxOWithTxInfo => !!utxo);

    // For drifted handles only, collect stale stored UTxO ids to remove
    const staleUtxoIds = new Set<string>();
    for (const h of driftedHandles) {
        if (h.utxo) staleUtxoIds.add(h.utxo);
    }

    // Update holders for drifted handles (missing ones will be holder-indexed inside updateHandleIndexes)
    if (driftedHandles.length) {
        const stakeAddresses = driftedHandles.map((h) => buildHolderInfo(h.resolved_addresses.ada).address);
        const holderHandles = store.pipeline(() => {
            stakeAddresses.forEach((address) => store.getValuesFromIndexedSet(IndexNames.HOLDER, address));
        }) as Set<string>[];
        const holdersMap = new Map<string, Set<string>>();
        stakeAddresses.forEach((address, index) => holdersMap.set(address, holderHandles[index]));
        store.pipeline(() => {
            driftedHandles.forEach((handle) => handlesRepo.updateHolder(handle, holdersMap));
        });
    }

    // Remove stale UTxOs, apply canonical state (this is insert-friendly: new UTxOs go in cleanly)
    if (staleUtxoIds.size) handlesRepo.removeUTxOs([...staleUtxoIds]);
    handlesRepo.addUTxOsWithMintData(touchedUTxOs);
    handlesRepo.addMintDataFromUTxOs(touchedUTxOs);

    // Rebuild handle indexes — updateHandleIndexes tolerates existingHandle=undefined
    const touchedNames = [...handlesToTouch];
    const storedHandlesMap = new Map<string, StoredHandle>(driftedHandles.map((h) => [h.name, h]));
    const retrievedMintingData = store.pipeline(() => {
        touchedNames.forEach((name) => handlesRepo.getHandleMintingData(name));
    }) as Set<string>[];
    const mintValueIndex: Map<string, MintingData[]> = new Map();
    retrievedMintingData.forEach((md, i) => {
        mintValueIndex.set(touchedNames[i], Array.from(md).map((m) => JSON.parse(m)));
    });
    store.pipeline(() => {
        for (const utxo of touchedUTxOs) {
            // Same repair semantics as processRollback: suppress the double-mint bump so repeated
            // drift repair doesn't inflate `handle.amount` past the burn threshold in removeHandle().
            handlesRepo.updateHandleIndexes(utxo, mintValueIndex, storedHandlesMap, undefined, { suppressDoubleMintDetection: true });
        }
    });

    const logNames = touchedNames.slice(0, 10).join(', ');
    const logSuffix = touchedNames.length > 10 ? ` (+${touchedNames.length - 10})` : '';
    Logger.log({
        message: `Repaired handles — drifted=${driftedHandles.length}, inserted=${insertNames.length}: ${logNames}${logSuffix}`,
        category: LogCategory.NOTIFY,
        event: 'scannerLambda.repairHandles'
    });

    return {
        checked: handleNames.length,
        repaired: driftedHandles.length,
        notFound: missingNames.length - insertNames.length,
        inserted: insertNames.length
    };
};

const scan = async () => {
    Logger.local(`Running scan...`);
    const metrics = handlesRepo.getMetrics();
    const scanStartedAt = Date.now();
    const scanBreadcrumb = (step: string, extra = '') => Logger.log({
        message: `[scan:breadcrumb] ${step} at +${Date.now() - scanStartedAt}ms${extra ? ` | ${extra}` : ''}`,
        category: LogCategory.INFO,
        event: 'scannerLambda.scan.breadcrumb'
    });
    const existingLastSlot = Number(metrics.lastSlot ?? 0);
    const startingCurrentSlot = Number(metrics.currentSlot ?? 0);
    // Is scanning fast enough to do this without MAX_TIP_SLOTS? Or a much higher one?
    handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.SCANNING, lockLambdasTimestamp: Date.now() });
    try {
        scanBreadcrumb('fetchPaginatedResults_start', `from=${metrics.currentBlockHash}`);
        let bResp: { hash: string; slot: number; confirmations: number }[] = await fetchPaginatedResults(
            `blocks/${metrics.currentBlockHash}/next`,
            SCANNER_MAX_BLOCKS_PER_INVOCATION + 1
        );
        scanBreadcrumb('fetchPaginatedResults_done', `blocks=${bResp.length}`);
        bResp.sort((a, b) => b.confirmations - a.confirmations);
        if (bResp.length > SCANNER_MAX_BLOCKS_PER_INVOCATION) {
            Logger.local({
                message: `Large scanner backlog detected (${bResp.length} blocks). Processing first ${SCANNER_MAX_BLOCKS_PER_INVOCATION} blocks this invocation.`,
                category: LogCategory.INFO,
                event: 'scannerLambda.chunkedBacklog'
            });
            bResp = bResp.slice(0, SCANNER_MAX_BLOCKS_PER_INVOCATION);
        }
        if (!bResp.length) {
            const currentSlot = Number(metrics.currentSlot ?? 0);
            scanBreadcrumb('getLatestChainTip_start', 'no forward blocks');
            const latestBlock = await getLatestChainTip();
            scanBreadcrumb('getLatestChainTip_done', `tip=${latestBlock?.slot ?? 'null'}`);
            if (!latestBlock?.slot) {
                handlesRepo.setMetrics({
                    lastSlot: Math.max(existingLastSlot, currentSlot),
                    tipBlockHash: ''
                });
                Logger.log({
                    message: 'Unable to fetch latest block while checking scanner head. Keeping an unknown tip hash and advancing the observed tip slot lower bound.',
                    category: LogCategory.WARN,
                    event: 'scannerLambda.latestBlockUnavailable'
                });
                return;
            }
            const latestSlot = latestBlock.slot;
            handlesRepo.setMetrics({
                lastSlot: latestSlot,
                tipBlockHash: `${latestBlock?.hash ?? ''}`
            });

            if (latestSlot > currentSlot && metrics.currentBlockHash && currentSlot > 0) {
                scanBreadcrumb('staleHead_rollback_start', `latestSlot=${latestSlot} currentSlot=${currentSlot} gap=${latestSlot - currentSlot}`);
                // Stale-head recovery: currentBlockHash is no longer on the canonical chain and
                // forward scan returned nothing. We need a deeper sweep than the periodic check's
                // default, because the canonical predecessor could be further back. 2160 is the
                // Cardano protocol's rollback limit; anything deeper requires a full S3 reimport.
                await processRollback({ currentSlot, rollbackOffset: 2160, suppressNotify: true });
                scanBreadcrumb('staleHead_rollback_done');
                return;
            }

            Logger.local(`No new blocks to process from ${metrics.currentBlockHash}`);
            return;
        }
        let tipBlockHash = '';
        let lastSlot = Math.max(existingLastSlot, bResp[bResp.length - 1].slot);
        scanBreadcrumb('getLatestChainTip_start', 'for tip metrics');
        const latestBlock = await getLatestChainTip();
        scanBreadcrumb('getLatestChainTip_done', `tip=${latestBlock?.slot ?? 'null'}`);
        if (latestBlock?.slot) {
            tipBlockHash = `${latestBlock?.hash ?? ''}`;
            lastSlot = Number(latestBlock.slot ?? lastSlot);
        } else {
            Logger.log({
                message: `Unable to fetch latest block while scanning from ${metrics.currentBlockHash}. Keeping an unknown tip hash and advancing the observed tip slot lower bound to ${lastSlot}.`,
                category: LogCategory.WARN,
                event: 'scannerLambda.latestBlockUnavailable'
            });
        }
        for (let blockIndex = 0; blockIndex < bResp.length; blockIndex += SCANNER_BLOCK_PREFETCH_CHUNK_SIZE) {
            checkDeadline(`scan_chunk offset=${blockIndex}/${bResp.length}`);
            const blockChunk = bResp.slice(blockIndex, blockIndex + SCANNER_BLOCK_PREFETCH_CHUNK_SIZE);
            scanBreadcrumb('chunk_start', `offset=${blockIndex}/${bResp.length} chunkSize=${blockChunk.length}`);
            scanBreadcrumb('getBatchedTxHashes_start');
            const txHashes = [...new Set(await getBatchedTxHashesWithFallback(blockChunk.map((block) => block.hash)))];
            scanBreadcrumb('getBatchedTxHashes_done', `txCount=${txHashes.length}`);
            scanBreadcrumb('getBatchedTxInfo_start');
            const txList = await getBatchedTxInfoWithFallback(txHashes);
            scanBreadcrumb('getBatchedTxInfo_done', `txInfoCount=${txList.length}`);
            scanBreadcrumb('getBatchedDatumInfo_start');
            const datumInfoByHash = await getBatchedDatumInfoWithFallback(txList);
            scanBreadcrumb('getBatchedDatumInfo_done', `datumCount=${datumInfoByHash.size}`);
            const txInfoByBlockHash = new Map<string, KoiosTxInfo[]>();
            for (const tx of txList) {
                const blockHash = tx?.block_hash;
                if (!blockHash) continue;
                const existing = txInfoByBlockHash.get(blockHash) ?? [];
                existing.push(tx);
                txInfoByBlockHash.set(blockHash, existing);
            }
            for (const b of blockChunk) {
                const block = { id: b.hash, slot: b.slot, confirmations: b.confirmations };
                const blockTxList = txInfoByBlockHash.get(b.hash) ?? [];
                const builtUTxOs = buildUTxOsFromKoiosTxs(blockTxList, datumInfoByHash);

                const handleNames = builtUTxOs.flatMap((u) => u.handles?.flatMap((h) => h[1].map((assetName) => getHandleNameFromAssetName(assetName).name)) ?? []) ?? [];
                Logger.local(`Processing block ${block.id} at slot ${block.slot} with ${builtUTxOs.length} UTxOs containing ${handleNames.join(', ')} handles from ${blockTxList.length} transactions`);

                builtUTxOs.forEach((utxo) => {
                    // ********** BURNS ************* //
                    const burnHandles = (store.pipeline(() => {
                        utxo.burn
                            ?.flatMap((b) => b[1])
                            .forEach((hex) => {
                                handlesRepo.getHandle(getHandleNameFromAssetName(hex).name);
                            });
                    }) as (StoredHandle | undefined)[]).filter((burned): burned is StoredHandle => !!burned);

                    const uniqueBurnHandles = Array.from(new Map(burnHandles.map((handle) => [handle.name, handle])).values());
                    store.pipeline(() => {
                        uniqueBurnHandles.forEach((burned) => {
                            handlesRepo.removeHandle(burned);
                        });
                    });
                });

                // ********* UPDATES ************ //
                handlesRepo.addUTxOsWithMintDataAndUpdateIndexes(builtUTxOs);

                // ******** SPENT UTxOs *********** //
                const spentUtxoIds = blockTxList.flatMap((tx) => tx.inputs).map((input) => `${input.tx_hash}#${input.tx_index}`);
                if (spentUtxoIds.length) handlesRepo.removeUTxOs(spentUtxoIds);

                handlesRepo.setMetrics({
                    currentSlot: block.slot,
                    currentBlockHash: block.id,
                    tipBlockHash,
                    lastSlot
                });

                // Record the block we just processed, independent of whether it had handle txs.
                // processRollback's missed-block drift check relies on this ledger being a true
                // record of what we've scanned — deriving it from stored UTxO blockHashes would
                // miss the large fraction of blocks with zero handle activity.
                store.recordScannedBlock(block.slot, block.id);
            }
        }
        // Keep enough history to cover the deepest rollback check window with margin. 3000
        // entries at ~20s/block is ~16 hours — safely larger than any practical rollback depth.
        store.trimScannedBlocksToRecent(3000);

    } catch (error: any) {
        if (error instanceof ScannerDeadlineError) {
            Logger.log({
                message: `${error.message}. Pausing this invocation — next invocation will resume from last saved block.`,
                category: LogCategory.INFO,
                event: 'scannerLambda.deadlineReached'
            });
            return;
        }
        if (isRetriableKoiosError(error)) {
            Logger.log({
                message: `Retriable Koios scanner failure (will retry next invocation): ${error?.message ?? error}`,
                category: LogCategory.INFO,
                event: 'scannerLambda.retriable'
            });
            return false;
        }
        if (error?.message?.startsWith('No minting data found for')) {
            Logger.log({
                message: `Store integrity violation during scan: ${error.message}`,
                category: LogCategory.NOTIFY,
                event: 'scannerLambda.storeIntegrityViolation'
            });
            return false;
        }
        Logger.log({ message: `Error in scanner lambda: ${error.message}`, category: LogCategory.ERROR, event: 'scannerLambda.error' });
        throw error;
    } finally {
        // Rebuild whenever currentSlot changed this invocation — the scan loop
        // advances currentSlot and IndexNames.HANDLE per-block, so any exit
        // path (including a deadline-terminated one) that committed blocks
        // must refresh stored mpt_root_hash, or /mpt-root will report a hash
        // from an earlier handle-set state.
        const endingCurrentSlot = Number(handlesRepo.getMetrics().currentSlot ?? 0);
        if (endingCurrentSlot !== startingCurrentSlot) {
            try {
                scanBreadcrumb('buildMptRootHash_start');
                await buildAndStoreMptRootHash(store);
                scanBreadcrumb('buildMptRootHash_done');
            } catch (mptError: any) {
                Logger.log({
                    message: `Failed to rebuild mpt_root_hash in scan finally: ${mptError?.message ?? mptError}`,
                    category: LogCategory.ERROR,
                    event: 'scannerLambda.buildMptRootHash.error'
                });
            }
        }
        handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.UNLOCKED });
    }
};

export const lambdaHandler = async (event: AWSLambda.ALBEvent | AWSLambda.APIGatewayProxyEventV2, context: AWSLambda.Context) => {
    scannerDeadline = Date.now() + SCANNER_HARD_DEADLINE_MS;
    const handlerStartedAt = Date.now();
    const logBreadcrumb = (step: string, extra = '') => Logger.log({
        message: `[scanner:breadcrumb] ${step} at +${Date.now() - handlerStartedAt}ms${extra ? ` | ${extra}` : ''}`,
        category: LogCategory.INFO,
        event: 'scannerLambda.breadcrumb'
    });
    logBreadcrumb('handler_start', `timeout=${context?.getRemainingTimeInMillis?.() ?? 'unknown'}ms`);
    store.initialize();
    logBreadcrumb('store_initialized');
    const isReindexShortcut = shouldTriggerReindexShortcut(event);
    const isRepairShortcut = extractRepairHandlesFromEvent(event) !== null;
    const leaseOwner = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const leaseAcquired = acquireScannerLease(leaseOwner);
    if (!leaseAcquired) {
        // Lease is held by another scanner invocation. Scheduled cron ticks just skip.
        // Shortcut paths (reindex / repair) used to proceed without the lease, which let
        // them race with the scanner on the same Valkey keys (correctness-spiral V3).
        // Refuse with a 409 instead so the operator retries after the active scan exits;
        // the lease TTL is 60s, so retries are cheap.
        if (isReindexShortcut || isRepairShortcut) {
            logBreadcrumb(`lease_not_acquired_${isReindexShortcut ? 'reindex' : 'repair'}_shortcut_refused`);
            return buildFunctionUrlResponse(409, {
                message: 'Scanner is currently active. Retry shortly.',
                shortcut: isReindexShortcut ? 'reindex' : 'repair'
            });
        }
        logBreadcrumb('lease_not_acquired_skipping');
        return;
    }

    let heartbeat: NodeJS.Timeout | undefined;
    try {
        if (leaseAcquired) {
            heartbeat = setInterval(() => {
                try {
                    if (!renewScannerLease(leaseOwner)) {
                        Logger.local('Scanner lease renewal failed, another invocation may take over soon');
                    }
                } catch (error: any) {
                    Logger.log({ message: `Scanner lease heartbeat failed: ${error.message}`, category: LogCategory.ERROR, event: 'scannerLambda.leaseHeartbeat' });
                }
            }, SCANNER_LEASE_HEARTBEAT_MS);
            heartbeat.unref?.();
        }

        logBreadcrumb('ensure_initialized_start');
        await ensureInitialized();
        logBreadcrumb('ensure_initialized_done');
        if (shouldTriggerReindexShortcut(event)) {
            if (!isWhitelistedScannerShortcutRequest(event)) {
                Logger.local({
                    message: 'Rejected scanner reindex shortcut request due to missing/invalid api-key header',
                    category: LogCategory.INFO,
                    event: 'scannerLambda.reindexShortcut.unauthorized'
                });
                return buildFunctionUrlResponse(401, { message: 'Unauthorized' });
            }

            Logger.log({
                message: 'Running scanner reindex shortcut from function URL request',
                category: LogCategory.NOTIFY,
                event: 'scannerLambda.reindexShortcut'
            });
            await processReindex();
            return buildFunctionUrlResponse(200, { message: 'Reindex complete' });
        }

        const repairList = extractRepairHandlesFromEvent(event);
        if (repairList !== null) {
            if (!isWhitelistedScannerShortcutRequest(event)) {
                return buildFunctionUrlResponse(401, { message: 'Unauthorized' });
            }
            Logger.log({
                message: `Running handle repair shortcut for ${repairList.length} handles`,
                category: LogCategory.INFO,
                event: 'scannerLambda.repairShortcut'
            });
            const result = await repairHandles(repairList);
            return {
                isBase64Encoded: false,
                statusCode: 200,
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(result)
            };
        }

        const metrics = handlesRepo.getMetrics();
        if (metrics.lockLambdas) {
            Logger.local(`Lambda is locked with: ${metrics.lockLambdas}, skipping`);
            if (!clearStaleLockIfNeeded(metrics)) return;
        }

        const recoveryFlag = getRecoveryFlag();
        if (recoveryFlag) {
            if (recoveryFlag === RECOVERY_REASON_ROLLBACK) {
                // Stale rollback flag from a previous failed inline repair.
                // Clear it and let the normal scan path handle rollback detection.
                Logger.log({
                    message: `Clearing stale recovery flag '${recoveryFlag}'. Rollback will be retried via normal scan path.`,
                    category: LogCategory.INFO,
                    event: 'scannerLambda.clearStaleRollbackFlag'
                });
                clearRecoveryFlag();
            } else {
                Logger.log({
                    message: `Recovery flag '${recoveryFlag}' detected. Running index repair before scan.`,
                    category: LogCategory.NOTIFY,
                    event: 'scannerLambda.recoveryFlag'
                });
                await processReindex();
                return;
            }
        }

        // ******** REINDEXING CHECK ********* //
        logBreadcrumb('ensure_utxos_ready_start');
        await ensureUTxOsReady();
        logBreadcrumb('ensure_utxos_ready_done');
        if (Number(store.getIndexSchemaVersion()) > (handlesRepo.getMetrics().indexSchemaVersion ?? 0)) {
            logBreadcrumb('reindex_start');
            await processReindex();
            logBreadcrumb('reindex_done');
            return;
        }

        logBreadcrumb('scan_start');
        await scan();
        logBreadcrumb('scan_done');

        logBreadcrumb('mpt_root_check_start');
        if (handlesRepo.isCaughtUp()) {
            const storedMptRoot = store.getMptRootHash();
            try {
                const chainMptRoot = await getChainMintingDataRootHash();
                if (storedMptRoot && storedMptRoot !== chainMptRoot) {
                    Logger.log({
                        message: `MPT root mismatch at tip: computed=${storedMptRoot}, chain=${chainMptRoot}`,
                        category: LogCategory.NOTIFY,
                        event: 'scannerLambda.mptRootMismatchAtTip'
                    });
                }
            } catch (error: any) {
                Logger.log({
                    message: `Unable to verify MPT root at tip: ${error?.message ?? error}`,
                    category: LogCategory.WARN,
                    event: 'scannerLambda.mptRootVerifyError'
                });
            }
        }

        logBreadcrumb('rollback_check_start');
        const postScanMetrics = handlesRepo.getMetrics();
        const slotsBelow = Number(postScanMetrics.lastSlot ?? 0) - Number(postScanMetrics.currentSlot ?? 0);
        if (slotsBelow > ROLLBACK_20_SLOT_WINDOW) {
            Logger.log({
                message: `Scanner is ${slotsBelow} slots behind tip, skipping rollback check until caught up`,
                category: LogCategory.INFO,
                event: 'scannerLambda.rollbackCheckDeferred'
            });
        } else {
            await checkRollback();
        }
        logBreadcrumb('rollback_check_done');

        return {
            isBase64Encoded: false,
            statusCode: 200,
            body: ''
        };
    } catch (error: any) {
        if (error instanceof ScannerDeadlineError) {
            Logger.log({
                message: `${error.message}. Exiting gracefully — next invocation will resume from last saved block.`,
                category: LogCategory.WARN,
                event: 'scannerLambda.deadlineReached'
            });
            return;
        }
        throw error;
    } finally {
        if (heartbeat) clearInterval(heartbeat);
        if (leaseAcquired) {
            try {
                releaseScannerLease(leaseOwner);
            } catch (error: any) {
                Logger.log({ message: `Failed to release scanner lease: ${error.message}`, category: LogCategory.ERROR, event: 'scannerLambda.leaseRelease' });
            }
        }
    }
};

export const Internal = {
    checkRollback,
    processRollback,
    processReindex,
    scan,
    acquireScannerLease,
    renewScannerLease,
    releaseScannerLease
};
