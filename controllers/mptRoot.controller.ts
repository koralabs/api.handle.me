import { LogCategory, Logger, NETWORK } from '@koralabs/kora-labs-common';
import { NextFunction, Request, Response } from 'express';
import { IRegistry } from '../interfaces/registry.interface';
import { getChainMintingDataRootHash } from '../utils/snapshotVerification';

class MptRootController {
    public async index(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const store = new (req.app.get('registry') as IRegistry).handlesStore();
            const mptRootHash = store.getMptRootHash();

            let chainMptRootHash: string | undefined;
            try {
                chainMptRootHash = await getChainMintingDataRootHash();
            } catch (error: any) {
                Logger.log({
                    message: `Unable to fetch chain MPT root hash: ${error?.message ?? error}`,
                    category: LogCategory.WARN,
                    event: 'mptRoot.chainFetchError'
                });
            }

            res.status(200).json({
                mpt_root_hash: mptRootHash ?? null,
                chain_mpt_root_hash: chainMptRootHash ?? null,
                verified: mptRootHash && chainMptRootHash ? mptRootHash === chainMptRootHash : null,
                network: NETWORK.toLowerCase() || 'preview'
            });
        } catch (error) {
            next(error);
        }
    }
}

export default MptRootController;
