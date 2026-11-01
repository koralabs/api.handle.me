import { UTxO } from '@koralabs/kora-labs-common';

/** Public array item consumed by the marketplace BFF. Prices are in lovelace. */
export interface MarketplaceListingViewModel {
    assetName: string;
    assetNameHex: string;
    assetLabel: string;
    policyId: string;
    utxo: UTxO;
    holder: string;
    payoutAddress: string;
    price: number;
    slotNumber: number;
}

export interface MarketplaceListingFilters {
    holderAddress?: string;
    search?: string;
}
