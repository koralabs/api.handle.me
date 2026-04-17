import { IndexNames, LogCategory, Logger, NETWORK } from '@koralabs/kora-labs-common';
import { NextFunction, Request, Response } from 'express';
import { IRegistry } from '../interfaces/registry.interface';
import { HandlesRepository } from '../repositories/handlesRepository';
import { buildHandleSetMptRootHash, getChainMintingDataRootHash, GHOST_HANDLES, probeProviderMptRootHash } from '../utils/snapshotVerification';

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
}

export default MptRootController;
