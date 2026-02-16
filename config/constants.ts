import { Point } from '@cardano-ogmios/schema';
import { IndexNames, NETWORK } from '@koralabs/kora-labs-common';

export interface EraBoundaries {
    [network: string]: Point;
}

export const handleEraBoundaries: EraBoundaries = {
    mainnet: {
        slot: 48194528,
        id: 'e7e68f6516485154ebbe5a0072a7c5c28d935610f722c53f6f058e2456574249'
    },
    testnet: {
        slot: 42971872,
        id: 'b5b276cb389ee36e624c66c632b0e983027609e7390fa7072a222261077117d6'
    },
    preprod: {
        slot: 0, //19783872,
        id: '' //'46a069ecc79659fcfc98e03e31bd29ee7f05b88623cc606d8b9658d804728842'
    },
    preview: {
        slot: 1470343, 
        id: '82e74d8a1fe161fa9f601548c4440df9b3b7151e85a94a571ee4731c79868446'
    }
};

export const SETS = [
    IndexNames.ADDRESS,
    IndexNames.CHARACTER,
    IndexNames.HASH_OF_STAKE_KEY_HASH,
    IndexNames.PAYMENT_KEY_HASH,
    IndexNames.LENGTH,
    IndexNames.NUMERIC_MODIFIER,
    IndexNames.OG,
    IndexNames.PERSONALIZED,
    IndexNames.RARITY,
    IndexNames.SUBHANDLE,
    IndexNames.HANDLE_TYPE
]

export const RATE_LIMITER_ENABLED = process.env.RATE_LIMITER_ENABLED == 'true';

export const HASHES = [IndexNames.HANDLE]
export const ZSETS = [IndexNames.SLOT]
// Used for storing the IDs of another index
export const META_INDEXES = [IndexNames.HANDLE, IndexNames.SUBHANDLE, IndexNames.HOLDER]
export const ORDERED_SLOTS: string[] = []
export const MAX_SETS_PER_PIPE = 5_000;
export const MAX_ZSETS_PER_PIPE = 5_000;
export const MAX_HASHES_PER_PIPE = 5_000;
export const ACCEPTABLE_TIP_PROXIMITY = 1200; // ~20 mins (memory store writes a file every 10 mins + 10 mins to restart)

export const enum ScanningMode {
    BACKFILL,
    TIP
}

export const TWELVE_HOURS_SLOT_TIME = 43200; // value comes from the securityParam here: https://cips.cardano.org/cips/cip9/#nonupdatableparameters then converted to slots

export const NETWORK_HOST = NETWORK.toLocaleLowerCase() == 'mainnet' ? '' : `${NETWORK.toLowerCase()}.`;
export const MINTING_SERVICE_URL = `https://${NETWORK_HOST}minting.handle.me`;
