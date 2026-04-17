import { Trie } from '@aiken-lang/merkle-patricia-forestry';
import { decodeCborToJson } from '@koralabs/kora-labs-common/utils/cbor';
import { AssetNameLabel, HANDLE_POLICIES, IndexNames, LogCategory, Logger, NETWORK, Network } from '@koralabs/kora-labs-common';
import { RedisHandlesStore } from '../stores/redis';
import { SnapshotVerification } from './verifiedSnapshot';
import { blockfrostApiCall, fetchKoios } from './helpers';

const MINTING_DATA_HANDLE_NAME = 'handle_root@handle_settings';
const EMPTY_MPT_ROOT_HASH = Buffer.alloc(32).toString('hex');

// Virtual subhandle burns that remain in the on-chain MPT because the
// current validator doesn't know how to remove them.
export const GHOST_HANDLES: Record<string, string[]> = {
    mainnet: ['watchman@ngmerchs'],
    preview: ['dynamo2@ai']
};

const fetchCurrentMintingDataDatumCbor = async () => {
    const redisHandleStore = new RedisHandlesStore();
    await redisHandleStore.initialize();
    const handle = redisHandleStore.getHashFromIndex(IndexNames.HANDLE, MINTING_DATA_HANDLE_NAME) as { datum?: string } | undefined;
    const datumCbor = `${handle?.datum ?? ''}`.trim();
    if (!datumCbor) {
        throw new Error(`Minting data datum not found for handle ${MINTING_DATA_HANDLE_NAME}`);
    }
    return datumCbor;
};

const extractMptRootFromConstructor0 = (decoded: any): string | undefined => {
    const raw = decoded?.constructor_0?.[0];
    if (typeof raw !== 'string') return undefined;
    const cleaned = raw.replace(/^0x/i, '').toLowerCase();
    return /^[0-9a-f]{64}$/.test(cleaned) ? cleaned : undefined;
};

export const getChainMintingDataRootHash = async () => {
    const datumCbor = await fetchCurrentMintingDataDatumCbor();
    const decoded = decodeCborToJson({ cborString: datumCbor, schema: {} });
    const mptRootHash = extractMptRootFromConstructor0(decoded);

    if (!mptRootHash) {
        throw new Error(`Invalid minting data root hash in datum: ${JSON.stringify(decoded)}`);
    }

    return mptRootHash;
};

export interface ProviderMptProbe {
    provider: 'koios' | 'blockfrost';
    rootHash: string;
    tipSlot: number;
}

const getMintingDataAssetNameHex = () => {
    const utf8Hex = Buffer.from(MINTING_DATA_HANDLE_NAME, 'utf8').toString('hex');
    return `${AssetNameLabel.LBL_222}${utf8Hex}`;
};

const probeKoiosRootHash = async (): Promise<ProviderMptProbe | null> => {
    const activePolicy = HANDLE_POLICIES.getActivePolicy(NETWORK.toLowerCase() as Network, false);
    if (!activePolicy) return null;
    const assetHex = getMintingDataAssetNameHex();
    const [utxos, tip] = await Promise.all([
        fetchKoios('asset_utxos', 'POST', JSON.stringify({ _asset_list: [[activePolicy, assetHex]], _extended: true })) as Promise<any[]>,
        fetchKoios('tip') as Promise<any>
    ]);
    const rootHash = extractMptRootFromConstructor0(utxos?.[0]?.inline_datum?.value);
    const tipEntry = Array.isArray(tip) ? tip[0] : tip;
    const tipSlot = Number(tipEntry?.abs_slot);
    if (!rootHash || !Number.isFinite(tipSlot)) return null;
    return { provider: 'koios', rootHash, tipSlot };
};

const probeBlockfrostRootHash = async (): Promise<ProviderMptProbe | null> => {
    const activePolicy = HANDLE_POLICIES.getActivePolicy(NETWORK.toLowerCase() as Network, false);
    if (!activePolicy) return null;
    const assetId = `${activePolicy}${getMintingDataAssetNameHex()}`;
    const [utxosResp, tipResp] = await Promise.all([
        blockfrostApiCall(`assets/${assetId}/utxos?order=desc&count=1`),
        blockfrostApiCall('blocks/latest')
    ]);
    if (!utxosResp.ok || !tipResp.ok) return null;
    const utxos = await utxosResp.json() as any[];
    const latestUtxo = utxos?.[0];
    if (!latestUtxo?.tx_hash) return null;
    const txResp = await blockfrostApiCall(`txs/${latestUtxo.tx_hash}/utxos`);
    if (!txResp.ok) return null;
    const txUtxos = await txResp.json() as any;
    const output = (txUtxos.outputs ?? []).find((o: any) =>
        o.output_index === latestUtxo.output_index &&
        (o.amount ?? []).some((a: any) => a.unit === assetId)
    );
    const inlineDatum = output?.inline_datum;
    if (typeof inlineDatum !== 'string') return null;
    const decoded = decodeCborToJson({ cborString: inlineDatum, schema: {} });
    const rootHash = extractMptRootFromConstructor0(decoded);
    if (!rootHash) return null;
    const tip = await tipResp.json() as any;
    const tipSlot = Number(tip?.slot);
    if (!Number.isFinite(tipSlot)) return null;
    return { provider: 'blockfrost', rootHash, tipSlot };
};

/**
 * Independently fetches the minting-data MPT root hash from external providers
 * (Koios first, Blockfrost fallback). Returns null if neither provider
 * succeeds. Consumers should require probe.tipSlot >= scanner.currentSlot for
 * the comparison to be meaningful — otherwise the provider is behind us and
 * its root reflects a state older than ours.
 */
export const probeProviderMptRootHash = async (): Promise<ProviderMptProbe | null> => {
    try {
        const koios = await probeKoiosRootHash();
        if (koios) return koios;
    } catch (error: any) {
        Logger.log({
            message: `Koios MPT probe failed: ${error?.message ?? error}`,
            category: LogCategory.INFO,
            event: 'mptRoot.providerProbe.koiosFailed'
        });
    }
    try {
        const blockfrost = await probeBlockfrostRootHash();
        if (blockfrost) return blockfrost;
    } catch (error: any) {
        Logger.log({
            message: `Blockfrost MPT probe failed: ${error?.message ?? error}`,
            category: LogCategory.WARN,
            event: 'mptRoot.providerProbe.blockfrostFailed'
        });
    }
    return null;
};

export const buildHandleSetMptRootHash = async (handleNames: string[], ghostHandles: string[] = []) => {
    const normalizedHandleNames = [...new Set([...handleNames, ...ghostHandles].map((handle) => `${handle}`.trim()).filter(Boolean))].sort();
    const trie = new Trie();
    for (const handleName of normalizedHandleNames) {
        await trie.insert(handleName, '');
    }

    return trie.hash?.toString('hex') ?? EMPTY_MPT_ROOT_HASH;
};

export const buildAndStoreMptRootHash = async (store: RedisHandlesStore): Promise<string> => {
    const handleNames = store.getKeysFromIndex(IndexNames.HANDLE) as string[];
    const ghosts = GHOST_HANDLES[NETWORK.toLowerCase()] ?? [];
    const hash = await buildHandleSetMptRootHash(handleNames, ghosts);
    store.setMptRootHash(hash);
    return hash;
};

export const buildSnapshotVerification = async (handleNames: string[]): Promise<SnapshotVerification> => {
    const store = new RedisHandlesStore();
    store.initialize();
    const ghosts = GHOST_HANDLES[NETWORK.toLowerCase()] ?? [];
    const snapshotMptRootHash = store.getMptRootHash() ?? await buildHandleSetMptRootHash(handleNames, ghosts);
    const chainMptRootHash = await getChainMintingDataRootHash();

    const verifiedAgainstChain = snapshotMptRootHash === chainMptRootHash;
    if (!verifiedAgainstChain) {
        Logger.log({
            message: `Snapshot MPT root mismatch: snapshot=${snapshotMptRootHash}, chain=${chainMptRootHash}`,
            category: LogCategory.WARN,
            event: 'snapshotVerification.mptRootMismatch'
        });
    }

    return {
        verifiedAgainstChain,
        snapshotMptRootHash,
        chainMptRootHash,
        network: NETWORK.toLowerCase() || 'preview',
        verifiedAtUtc: new Date().toISOString()
    };
};
