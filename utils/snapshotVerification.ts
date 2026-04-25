import { Trie } from '@aiken-lang/merkle-patricia-forestry';
import { decodeCborToJson } from '@koralabs/kora-labs-common/utils/cbor';
import { AssetNameLabel, HANDLE_POLICIES, IndexNames, LogCategory, Logger, NETWORK, Network } from '@koralabs/kora-labs-common';
import { getHandlesStore, RedisHandlesStore } from '../stores/redis';
import { SnapshotVerification } from './verifiedSnapshot';
import { blockfrostApiCall, fetchKoios } from './helpers';

const MINTING_DATA_HANDLE_NAME = 'handle_root@handle_settings';
const EMPTY_MPT_ROOT_HASH = Buffer.alloc(32).toString('hex');

// Virtual subhandle burns that remain in the on-chain MPT because the
// current validator doesn't know how to remove them. Mainnet's set was
// emptied 2026-04-24 after demi v2 redeployed the on-chain trie without
// the prior ghost. Preview still carries `dynamo2@ai` — verified
// empirically against the preview chain root on 2026-04-25.
export const GHOST_HANDLES: Record<string, string[]> = {
    mainnet: [],
    preview: ['dynamo2@ai']
};

const fetchCurrentMintingDataDatumCbor = async () => {
    const redisHandleStore = getHandlesStore();
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

// HANDLE_POLICIES.getActivePolicy(net, false) is broken upstream in kora-labs-common
// (undefined == false never matches so it returns undefined for every network).
// Pick the non-DeMi policy directly.
const getMainHandlePolicy = (): string | undefined => {
    const entry = Object.entries(HANDLE_POLICIES[NETWORK.toLowerCase() as Network] ?? {}).find(
        ([, v]) => v && typeof v === 'object' && 'firstMintingSlot' in (v as any) && !(v as { isDeMi?: boolean }).isDeMi
    );
    return entry?.[0];
};

const probeKoiosRootHash = async (): Promise<ProviderMptProbe | null> => {
    const activePolicy = getMainHandlePolicy();
    if (!activePolicy) return null;
    const assetHex = getMintingDataAssetNameHex();
    const [utxos, tip] = await Promise.all([
        fetchKoios('asset_utxos', 'POST', JSON.stringify({ _asset_list: [[activePolicy, assetHex]], _extended: true })) as Promise<any[]>,
        fetchKoios('tip') as Promise<any>
    ]);
    // Koios returns inline_datum as { bytes: <cbor hex>, value: { constructor, fields } }.
    // Route through decodeCborToJson on the raw CBOR so the extractor sees the
    // same shape as Blockfrost's path.
    const koiosInlineCbor: string | undefined = utxos?.[0]?.inline_datum?.bytes;
    const decoded = koiosInlineCbor ? decodeCborToJson({ cborString: koiosInlineCbor, schema: {} }) : undefined;
    const rootHash = extractMptRootFromConstructor0(decoded);
    const tipEntry = Array.isArray(tip) ? tip[0] : tip;
    // Koios sometimes returns 200 with an empty body for /tip; Number(undefined?.abs_slot) is NaN,
    // but Number(null?.abs_slot ?? 0) would be 0 — a finite value that poisons the tipSlot check
    // and lets a zero-slot probe masquerade as valid. Require a real tipEntry before reading.
    if (!tipEntry) return null;
    const tipSlot = Number(tipEntry.abs_slot);
    if (!rootHash || !Number.isFinite(tipSlot) || tipSlot <= 0) return null;
    return { provider: 'koios', rootHash, tipSlot };
};

const probeBlockfrostRootHash = async (): Promise<ProviderMptProbe | null> => {
    const activePolicy = getMainHandlePolicy();
    if (!activePolicy) return null;
    const assetId = `${activePolicy}${getMintingDataAssetNameHex()}`;
    // Blockfrost has no /assets/{id}/utxos endpoint (confirmed against its
    // OpenAPI spec). Two-call path: /assets/{asset}/addresses -> /addresses/{addr}/utxos/{asset}.
    const [addressesResp, tipResp] = await Promise.all([
        blockfrostApiCall(`assets/${assetId}/addresses?count=1`),
        blockfrostApiCall('blocks/latest')
    ]);
    if (!addressesResp.ok || !tipResp.ok) return null;
    const addresses = await addressesResp.json() as { address: string; quantity: string }[];
    const holder = addresses?.[0];
    if (!holder?.address) return null;
    const utxosResp = await blockfrostApiCall(`addresses/${encodeURIComponent(holder.address)}/utxos/${assetId}?count=1`);
    if (!utxosResp.ok) return null;
    const utxos = await utxosResp.json() as any[];
    const latestUtxo = utxos?.[0];
    const inlineDatum = latestUtxo?.inline_datum;
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
    // Bulk constructor instead of N serial `await trie.insert(...)` calls.
    // The per-insert loop re-hashed intermediate state on every step, costing
    // ~1.5ms × ~300k handles = ~8 minutes per scan tick on mainnet. fromList
    // builds the structure in one pass with the same final hash; bootstrap +
    // build-true-root + build-api-root all use it and verify against on-chain.
    const trie = await Trie.fromList(normalizedHandleNames.map((key) => ({ key, value: '' })));
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
    const store = getHandlesStore();
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
