import { buildHolderInfo, decodeAddress, NETWORK } from '@koralabs/kora-labs-common';
import { NextFunction, Request, Response } from 'express';
import { IRegistry } from '../interfaces/registry.interface';
import { HandlesRepository } from '../repositories/handlesRepository';
import { getMarketplaceValidatorHashes } from '../services/scripts.service';
import { ApiError } from '../utils/apiError';

const stringParam = (value: unknown, name: string): string | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim()) {
        throw new ApiError(400, 'bad_request', `${name} must be a non-empty string`);
    }
    return value;
};

const sellerAddress = (value: string): string => {
    const hex = decodeAddress(value);
    const type = hex ? Number.parseInt(hex[0], 16) : -1;
    const isMainnet = NETWORK.toLowerCase() === 'mainnet';
    const prefix = type === 14 || type === 15 ? (isMainnet ? 'stake1' : 'stake_test1') : (isMainnet ? 'addr1' : 'addr_test1');
    const validLength = hex && ((type >= 0 && type <= 3 && hex.length === 114) || ([6, 7, 14, 15].includes(type) && hex.length === 58));
    if (!validLength || hex?.[1] !== (isMainnet ? '1' : '0') || !value.startsWith(prefix)) {
        throw new ApiError(400, 'bad_request', 'holder_address must be a base, enterprise, or stake address for this network');
    }
    return buildHolderInfo(value).address;
};

class MarketplaceController {
    public getListings = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const holder = stringParam(req.query.holder_address, 'holder_address');
            const search = stringParam(req.query.search, 'search')?.trim().toLowerCase();
            if (search !== undefined && search.length < 3) {
                throw new ApiError(400, 'bad_request', 'search must contain at least 3 characters');
            }
            const filters = { holderAddress: holder ? sellerAddress(holder) : undefined, search };
            const repo = new HandlesRepository(new (req.app.get('registry') as IRegistry).handlesStore());
            const listings = repo.getMarketplaceListings(getMarketplaceValidatorHashes(repo), filters);
            res.set('X-Total-Count', String(listings.length));
            res.status(repo.currentHttpStatus()).json(listings);
        } catch (error) {
            next(error);
        }
    };
}

export default MarketplaceController;
