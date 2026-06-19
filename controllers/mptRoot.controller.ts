import { IndexNames, LogCategory, Logger, NETWORK } from '@koralabs/kora-labs-common';
import { NextFunction, Request, Response } from 'express';
import { IRegistry } from '../interfaces/registry.interface';
import { HandlesRepository } from '../repositories/handlesRepository';
import { isRegistryLabel } from '../utils/assetLabelRegistry';
import { buildHandleSetMptRootHash, buildLabelAssetProof, getChainMintingDataRootHash, GHOST_HANDLES, probeProviderMptRootHash } from '../utils/snapshotVerification';

class MptRootController {
    public async index(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const store = new (req.app.get('registry') as IRegistry).handlesStore();
            const repo = new HandlesRepository(store);

            // Scanner pre-computes and persists the handle-set MPT hash on each
            // scan cycle. Use the stored value; fall back to rebuilding from
            // the current handle set if none is persisted yet.
            let calculatedMptRootHash: string | undefined = store.getMptRootHash();
            if (!calculatedMptRootHash) {
                const handleNames = store.getKeysFromIndex(IndexNames.HANDLE) as string[];
                const ghosts = GHOST_HANDLES[NETWORK.toLowerCase()] ?? [];
                calculatedMptRootHash = await buildHandleSetMptRootHash(handleNames, ghosts);
            }

            let datumMptRootHash: string | undefined;
            try {
                datumMptRootHash = await getChainMintingDataRootHash();
            } catch (error: any) {
                Logger.log({
                    message: `Unable to decode stored handle_settings datum: ${error?.message ?? error}`,
                    category: LogCategory.WARN,
                    event: 'mptRoot.datumDecodeError'
                });
            }

            const provider = await probeProviderMptRootHash();
            const metrics = repo.getMetrics();
            const ourCurrentSlot = Number(metrics.currentSlot ?? 0);

            let verified: boolean | null = null;
            if (calculatedMptRootHash && datumMptRootHash && provider) {
                verified = calculatedMptRootHash === datumMptRootHash
                    && datumMptRootHash === provider.rootHash
                    && provider.tipSlot >= ourCurrentSlot;
            }

            res.status(200).json({
                calculated_mpt_root_hash: calculatedMptRootHash ?? null,
                datum_mpt_root_hash: datumMptRootHash ?? null,
                chain_mpt_root_hash: provider?.rootHash ?? null,
                verified,
                network: NETWORK.toLowerCase() || 'preview',
                provider: provider?.provider ?? null,
                provider_tip_slot: provider?.tipSlot ?? null,
                our_current_slot: ourCurrentSlot
            });
        } catch (error) {
            next(error);
        }
    }

    // WS1 — proof package for a 001-004 label mint(+1)/burn(-1), so the minter can ride a
    // demimntmpt MintLabelAssets/label-burn spend on the same tx. The api is our scoped reflection
    // of the chain, hence the source of truth for the proof. GET /mpt-root/proof?handle&label&amount
    public async proof(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const handle = `${req.query.handle ?? ''}`.trim();
            const label = `${req.query.label ?? ''}`.trim().toLowerCase();
            const amountRaw = `${req.query.amount ?? ''}`.trim();

            if (!handle) {
                res.status(400).json({ error: 'handle is required' });
                return;
            }
            if (!isRegistryLabel(label)) {
                res.status(400).json({ error: `label must be a tracked registry prefix (001/002/003/004), got "${label}"` });
                return;
            }
            if (amountRaw !== '1' && amountRaw !== '-1') {
                res.status(400).json({ error: 'amount must be 1 (mint) or -1 (burn)' });
                return;
            }

            const store = new (req.app.get('registry') as IRegistry).handlesStore();
            try {
                const result = await buildLabelAssetProof(store, handle, label, BigInt(amountRaw));
                res.status(200).json(result);
            } catch (e: any) {
                // prove() throws if the handle key is absent (not indexed / wrong name); applyLabel
                // throws on an invalid delta (add an already-present label / remove an absent one).
                res.status(409).json({ error: e?.message ?? `${e}`, handle, label, amount: amountRaw });
            }
        } catch (error) {
            next(error);
        }
    }

    // WS1 — the per-handle label sets (only handles with a non-empty set appear). The minter merges
    // this with its handle list to build a registry-aware trie whose root matches the chain, so its
    // demimntmpt-spend proofs are valid. The api is the source of truth; the minter's own trie is not.
    // GET /mpt-root/registry-labels
    public async registryLabels(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const store = new (req.app.get('registry') as IRegistry).handlesStore();
            const labels = store.getAllHandleRegistryLabels?.() ?? {};
            res.status(200).json({
                network: NETWORK.toLowerCase() || 'preview',
                current_root: store.getMptRootHash() ?? null,
                count: Object.keys(labels).length,
                labels
            });
        } catch (error) {
            next(error);
        }
    }
}

export default MptRootController;
