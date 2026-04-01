import { Trie } from '@aiken-lang/merkle-patricia-forestry';
import { decodeCborToJson } from '@koralabs/kora-labs-common/utils/cbor';
import { IndexNames, LogCategory, Logger, NETWORK } from '@koralabs/kora-labs-common';
import { RedisHandlesStore } from '../stores/redis';
import { SnapshotVerification } from './verifiedSnapshot';

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

export const getChainMintingDataRootHash = async () => {
    const datumCbor = await fetchCurrentMintingDataDatumCbor();
    const decoded = decodeCborToJson({ cborString: datumCbor, schema: {} }) as { constructor_0?: [string] };
    const mptRootHash = `${decoded.constructor_0?.[0] ?? ''}`.replace(/^0x/i, '').toLowerCase();

    if (!/^[0-9a-f]{64}$/.test(mptRootHash)) {
        throw new Error(`Invalid minting data root hash in datum: ${JSON.stringify(decoded)}`);
    }

    return mptRootHash;
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
