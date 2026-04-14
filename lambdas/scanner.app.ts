import { AssetNameLabel, asyncForEach, buildHolderInfo, IndexNames, LockedLambdaReason, LogCategory, Logger, MintingData, NETWORK, StoredHandle, UTxOFunctionName, UTxOWithTxInfo } from '@koralabs/kora-labs-common';
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
    [LockedLambdaReason.ROLLBACK_20]: 5 * 60 * 1000,
    [LockedLambdaReason.ROLLBACK_2160]: 10 * 60 * 1000,
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

const renewScannerLease = (owner: string): boolean => {
    const currentOwner = store.redisClientCall('get', SCANNER_LEASE_KEY);
    if (currentOwner !== owner) return false;
    const updated = store.redisClientCall('pexpire', SCANNER_LEASE_KEY, SCANNER_LEASE_TTL_MS);
    return !!updated;
};

const releaseScannerLease = (owner: string): void => {
    const currentOwner = store.redisClientCall('get', SCANNER_LEASE_KEY);
    if (currentOwner === owner) {
        store.redisClientCall('del', [SCANNER_LEASE_KEY]);
    }
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

const isWhitelistedScannerShortcutRequest = (event: any): boolean => {
    const apiKey = getEventHeader(event, 'api-key');
    return !!apiKey && getWhitelistedApiKeys().includes(apiKey);
};

const buildFunctionUrlResponse = (statusCode: number, body: { message: string }) => {
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

const getBatchedDatumInfo = async (txInfo: KoiosTxInfo[]) => {
    const datumHashes = [...new Set(
        txInfo.flatMap((tx) =>
            (tx.outputs ?? []).flatMap((output) => {
                if (output.inline_datum?.bytes || !output.datum_hash) {
                    return [];
                }

                return [output.datum_hash];
            })
        )
    )];

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

const getBatchedUTxOs = async (txHashes: string[], txs?: KoiosTxInfo[]) => {
    const txInfo = txs ?? await getBatchedTxInfo(txHashes);
    const datumInfoByHash = await getBatchedDatumInfo(txInfo);
    const utxos: UTxOWithTxInfo[] = [];
    utxos.push(...buildUTxOsFromKoiosTxs(txInfo, datumInfoByHash));
    return utxos;
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
        const datumHashes = [...new Set(
            txInfo.flatMap((tx) =>
                (tx.outputs ?? []).flatMap((output) => {
                    if (output.inline_datum?.bytes || !output.datum_hash) return [];
                    return [output.datum_hash];
                })
            )
        )];
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

const processRollback = async ({ currentSlot, rollbackOffset = 20, suppressNotify = false }: { currentSlot: number; rollbackOffset: number; suppressNotify?: boolean }) => {
    const rbStartedAt = Date.now();
    const rbBreadcrumb = (step: string, extra = '') => Logger.log({
        message: `[rollback:breadcrumb] ${step} at +${Date.now() - rbStartedAt}ms${extra ? ` | ${extra}` : ''}`,
        category: LogCategory.INFO,
        event: 'scannerLambda.rollback.breadcrumb'
    });
    rbBreadcrumb('start', `offset=${rollbackOffset} currentSlot=${currentSlot}`);
    Logger.local(`Running rollback check - ${rollbackOffset}`);
    const latestBlock = await getLatestChainTip();
    rbBreadcrumb('getLatestChainTip_done', `height=${latestBlock?.height ?? 'null'}`);
    if (!latestBlock?.height) {
        const { lastSlot = 0 } = handlesRepo.getMetrics();
        handlesRepo.setMetrics({
            lastSlot: Math.max(Number(lastSlot ?? 0), Number(currentSlot ?? 0)),
            tipBlockHash: ''
        });
        Logger.log({
            message: `Unable to fetch latest block while checking rollback_${rollbackOffset}. Keeping an unknown tip hash and advancing the observed tip slot lower bound.`,
            category: LogCategory.WARN,
            event: 'scannerLambda.latestBlockUnavailable'
        });
        return;
    }

    const blockHeight = latestBlock.height - rollbackOffset;

    // Get all blocks/txs/UTxOs from Bf/Ko
    rbBreadcrumb('fetchPaginatedResults_start', `fromHeight=${blockHeight}`);
    const blockList: BlockfrostBlock[] = await fetchPaginatedResults(`blocks/${blockHeight}/next`);
    rbBreadcrumb('fetchPaginatedResults_done', `blocks=${blockList.length}`);
    const [firstBlock] = blockList;
    if (!firstBlock) return;

    const providerBlocks = blockList.filter((b) => b.slot <= currentSlot).sort((a, b) => a.slot - b.slot);
    if (!providerBlocks.length) return;

    // Get all of the UTxOs from db after that slot
    // Using the firstBlock.slot, we might get a UTxO that does not have Handles.
    const utxoIds = store.getValuesFromOrderedSet(IndexNames.UTXO_SLOT, 0, { start: firstBlock.slot }) as string[];
    const utxos = store.pipeline(() => {
        utxoIds.forEach((utxoId) => handlesRepo.getUTxO(utxoId));
    }) as UTxOWithTxInfo[];

    const providerUTxOs: UTxOWithTxInfo[] = [];
    for (let i = 0; i < providerBlocks.length; i += SCANNER_BLOCK_PREFETCH_CHUNK_SIZE) {
        checkDeadline(`rollback_provider_chunk offset=${i}/${providerBlocks.length}`);
        const chunk = providerBlocks.slice(i, i + SCANNER_BLOCK_PREFETCH_CHUNK_SIZE);
        rbBreadcrumb('provider_chunk_start', `offset=${i}/${providerBlocks.length} chunkSize=${chunk.length}`);
        const txHashes = [...new Set(await getBatchedTxHashesWithFallback(chunk.map((b) => b.hash)))];
        const chunkUTxOs = await getBatchedUTxOsWithFallback(txHashes);
        providerUTxOs.push(...chunkUTxOs);
        rbBreadcrumb('provider_chunk_done', `offset=${i} txCount=${txHashes.length} handleUtxos=${chunkUTxOs.length}`);
    }
    rbBreadcrumb('provider_chunks_complete', `totalUtxos=${providerUTxOs.length}`);
    // sort provider UTxOs by slot ascending
    providerUTxOs.sort((a, b) => a.slot - b.slot);

    const handleNames: Set<string> = new Set();
    for (const utxo of [...providerUTxOs, ...utxos]) {
        for (const assets of utxo?.handles ?? []) {
            assets[1].forEach((assetName) => {
                const { name } = getHandleNameFromAssetName(assetName);
                handleNames.add(name);
            });
        }
    }
    
    const handles = [...handleNames];

    const storedHandles = store
        .pipeline(() => {
            handles.forEach((handleName) => {
                handlesRepo.getHandle(handleName);
            });
        })
        .filter(Boolean) as StoredHandle[];

    const batchedHandles: [string, string][][] = [];
    let storedHandlesIndex = 0;
    let assetNames: [string, string][] = [];
    while (storedHandlesIndex < storedHandles.length) {
        // TODO: deal with virtual subHandles
        const storedHandle = storedHandles[storedHandlesIndex];
        const { isCip67 } = getHandleNameFromAssetName(storedHandle.hex);

        assetNames.push([storedHandles[storedHandlesIndex].policy, storedHandles[storedHandlesIndex].hex]);

        if (isCip67) {
            const hexWithoutLabel = storedHandles[storedHandlesIndex].hex.slice(8);
            assetNames.push([storedHandles[storedHandlesIndex].policy, `${AssetNameLabel.LBL_100}${hexWithoutLabel}`]);
            assetNames.push([storedHandles[storedHandlesIndex].policy, `${AssetNameLabel.LBL_001}${hexWithoutLabel}`]);
        }

        if (JSON.stringify({ _asset_list: assetNames, _extended: true }).length >= 4700) {
            // Max possible ",[policy,handle]" length is 96
            batchedHandles.push(assetNames);
            assetNames = [];
        }
        storedHandlesIndex++;
        // last check if last handle
        if (storedHandlesIndex == storedHandles.length && assetNames.length) {
            batchedHandles.push(assetNames);
        }
    }

    const handleTxHashes: string[] = [];
    // This is a separate set of UTxOs representing the current Handle values (potentially different from above UTxOs)
    rbBreadcrumb('fetchAssetUtxos_start', `batchCount=${batchedHandles.length} handleCount=${storedHandles.length}`);
    await asyncForEach(batchedHandles, async (handleNames) => {
        const koiosUtxos = await fetchAssetUtxoBatchWithRetry(handleNames);
        if (koiosUtxos !== null) {
            // go through each asset and grab the data we need to test, tx_hash, tx_index, address
            for (const utxo of koiosUtxos) {
                handleTxHashes.push(utxo.tx_hash);
            }
        } else {
            // Handle not found in provider, we need to remove it from our store.
            // this can happen if a mint was rolled back and didn't return
            // Mostly possible with DEMI and Manually added Handles because handle.me uses Blockfrost
        }
    }, KOIOS_ASSET_UTXOS_MIN_INTERVAL_MS);
    rbBreadcrumb('fetchAssetUtxos_done', `handleTxHashes=${handleTxHashes.length}`);

    rbBreadcrumb('latestUTxOs_start');
    const latestUTxOsForAffectedHandles = await getBatchedUTxOsWithFallback(handleTxHashes);
    rbBreadcrumb('latestUTxOs_done', `count=${latestUTxOsForAffectedHandles.length}`);
    const rollbackHandleSet = new Set(handles);
    const relevantLatestUTxOsForAffectedHandles = latestUTxOsForAffectedHandles
        .map((utxo) => filterUTxOToHandleNames(utxo, rollbackHandleSet))
        .filter((utxo): utxo is UTxOWithTxInfo => !!utxo);

    // find the intersection of providerUTxOs and latestUTxOsForAffectedHandles to get the latest UTxOs for the affected handles
    const latestIds = relevantLatestUTxOsForAffectedHandles.filter((u) => u.slot >= firstBlock.slot && u.slot <= currentSlot).map((u) => u.id);
    const latestProviderUTxOsForAffectedHandles = providerUTxOs.filter(p => latestIds.includes(p.id));
    // then find the differences between that and the utxos from our store to find any discrepancies
    const [latestProviderIds, apiIds] = [new Set(latestProviderUTxOsForAffectedHandles.map((u) => u.id)), new Set(utxos.map((u) => u.id))];
    const differences = [...latestProviderIds.symmetricDifference(apiIds)].map((id) => {
        return [...latestProviderUTxOsForAffectedHandles, ...utxos].find((u) => u.id === id);
    });

    if (differences.length) {
        const rollbackStartSlot = Math.min(...differences.map((u) => u?.slot ?? Infinity));
        if (!Number.isFinite(rollbackStartSlot)) return;

        const providerRollbackUTxOs = providerUTxOs.filter((utxo) => utxo.slot >= rollbackStartSlot);

        const firstMissingHeight = Math.min(...differences.map((u) => u?.blockNum ?? Infinity));
        const distanceFromTip = latestBlock.height - firstMissingHeight;
        Logger.log(`Rollback detected from slot ${rollbackStartSlot}${distanceFromTip === null ? '' : ` (${distanceFromTip} blocks from tip)`}`);

        const apiRollbackUtxos = utxos.filter((utxo): utxo is UTxOWithTxInfo => !!utxo && utxo.slot >= rollbackStartSlot);

        // This should be a notify since we are very rarely expecting in this range
        // and may need to adjust the number 20 above accordingly
        if (!suppressNotify && distanceFromTip! > 20) Logger.log({ category: LogCategory.NOTIFY, message: `Rollback at ${distanceFromTip} blocks detected! Block: ${firstMissingHeight}`, event: 'RollbackLambda' });
        // Replay the affected range inline. Only escalate to a full reimport
        // if the repair fails with a non-retriable error — a transient Koios
        // timeout should retry the rollback next invocation, not trigger a
        // 265K-handle S3 reimport that can OOM/timeout at normal memory.
        // build the minting data for all handles in this range
        const handlesMintingData = store.pipeline(() => {
            handles.forEach((handleName) => handlesRepo.getHandleMintingData(handleName));
        }) as Set<string>[];

        // gets Handles and remove mints that happened in this range
        store.pipeline(() => {
            handles.forEach((handleName, index) => {
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

        const stakeAddresses = storedHandles.map((h) => buildHolderInfo(h.resolved_addresses.ada).address);

        // get a full list of holders so we can pass it into the updateHolder function later
        const holderHandles = store.pipeline(() => {
            stakeAddresses.forEach((address) => store.getValuesFromIndexedSet(IndexNames.HOLDER, address));
        }) as Set<string>[]; // array of sets of handle names for each holder address

        const holdersMap = new Map<string, Set<string>>();
        stakeAddresses.forEach((address, index) => {
            holdersMap.set(address, holderHandles[index]);
        });

        // update handle holders
        store.pipeline(() => {
            storedHandles.forEach((handle) => {
                handlesRepo.updateHolder(handle, holdersMap);
            });
        });

        // delete all UTxOs after that slot and replay them all
        const utxoIdsToRemove = apiRollbackUtxos.map((utxo) => utxo.id);
        if (utxoIdsToRemove.length) {
            handlesRepo.removeUTxOs(utxoIdsToRemove);
        }

        // repopulate utxo store and minting data from Bf/Ko
        handlesRepo.addUTxOsWithMintData(providerRollbackUTxOs);

        const storedHandlesMap = new Map<string, StoredHandle>(storedHandles.map((h) => [h.name, h]));

        handlesRepo.addMintDataFromUTxOs(relevantLatestUTxOsForAffectedHandles);

        const retrievedMintingData = store.pipeline(() => {
            handles.forEach((handleName) => {
                handlesRepo.getHandleMintingData(handleName);
            });
        }) as Set<string>[];

        const mintValueIndex: Map<string, MintingData[]> = new Map();
        retrievedMintingData.forEach((md, i) => {
            const handleName = handles[i];
            mintValueIndex.set(
                handleName,
                Array.from(md).map((md) => JSON.parse(md))
            );
        });

        store.pipeline(() => {
            for (const utxo of relevantLatestUTxOsForAffectedHandles) {
                handlesRepo.updateHandleIndexes(utxo, mintValueIndex, storedHandlesMap);
            }
        });
    }

    const recoveredHead = providerBlocks[providerBlocks.length - 1];
    const recoveredMetrics: Partial<{ currentBlockHash: string; currentSlot: number; tipBlockHash: string; lastSlot: number }> = {
        currentBlockHash: recoveredHead.hash,
        currentSlot: recoveredHead.slot
    };
    const latestSlot = Number(latestBlock?.slot ?? 0);
    if (latestBlock?.hash) recoveredMetrics.tipBlockHash = latestBlock.hash;
    if (latestSlot > 0) recoveredMetrics.lastSlot = latestSlot;
    handlesRepo.setMetrics(recoveredMetrics);
};

const checkRollback = async () => {
    const { currentSlot = 0 } = handlesRepo.getMetrics();
    try {
        handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.ROLLBACK_20, lockLambdasTimestamp: Date.now() });
        // 20 confirmation range once a minute
        // Get "20 ago block" (Blockfrost supports get by height/number)
        await processRollback({ currentSlot, rollbackOffset: 20 });

        // if (Date.now() - (handlesRepo.getMetrics().lastMaxRollbackCheck ?? 0) > 60 * 60 * 1000) {
        //     // Get "2160 ago block" (Blockfrost supports get by height/number)
        //     handlesRepo.setMetrics({ lockLambdas: LockedLambdaReason.ROLLBACK_2160, lockLambdasTimestamp: Date.now() });
        //     await processRollback({ currentSlot, rollbackOffset: 2160 });
        //     // Update last2160check
        //     handlesRepo.setMetrics({ lastMaxRollbackCheck: Date.now() });
        // }
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

    if ([LockedLambdaReason.ROLLBACK_20, LockedLambdaReason.ROLLBACK_2160].includes(metrics.lockLambdas)) {
        Logger.log({ message: `Scanner lambda has been locked for rollback for over 5 minutes, something is wrong!`, category: LogCategory.NOTIFY, event: 'scannerLambda.rollbackLockedTooLong' });
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
                const rollbackOffset = latestSlot - currentSlot > ROLLBACK_20_SLOT_WINDOW ? 2160 : 20;
                scanBreadcrumb('staleHead_rollback_start', `rollbackOffset=${rollbackOffset} latestSlot=${latestSlot} currentSlot=${currentSlot} gap=${latestSlot - currentSlot}`);
                await processRollback({ currentSlot, rollbackOffset, suppressNotify: true });
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
            }
        }

        scanBreadcrumb('buildMptRootHash_start');
        await buildAndStoreMptRootHash(store);
        scanBreadcrumb('buildMptRootHash_done');
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
    const leaseOwner = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const leaseAcquired = acquireScannerLease(leaseOwner);
    if (!leaseAcquired && !isReindexShortcut) {
        logBreadcrumb('lease_not_acquired_skipping');
        return;
    }
    if (!leaseAcquired && isReindexShortcut) {
        logBreadcrumb('lease_not_acquired_but_reindex_shortcut');
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
    scan
};
