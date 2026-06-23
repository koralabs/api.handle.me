import { HandleType, IDrep, Rarity, StoredHandle } from '@koralabs/kora-labs-common';
import { ApiError } from '../../utils/apiError';
import { isHandlePersonalized } from '../../utils/isPersonalized';

export class HandleViewModel {
    hex: string;
    name: string;
    image: string;
    standard_image: string;
    holder: string;
    holder_type: string;
    length: number;
    og_number: number;
    rarity: Rarity;
    utxo: string;
    characters: string;
    numeric_modifiers: string;
    default_in_wallet: string;
    pfp_image?: string;
    pfp_asset?: string;
    bg_image?: string;
    bg_asset?: string;
    resolved_addresses: {
        ada: string;
        [key: string]: string;
    };
    created_slot_number: number;
    updated_slot_number: number;
    has_datum: boolean;
    image_hash: string;
    standard_image_hash: string;
    svg_version: string;
    last_update_address?: string;
    version: number;
    handle_type: string;
    payment_key_hash?: string;
    pz_enabled?: boolean;
    is_personalized: boolean;

    sub_rarity?: string;
    sub_length?: number;
    sub_characters?: string;
    sub_numeric_modifiers?: string;
    last_edited_time?: number;

    original_address?: string;
    virtual?: {
        expires_time: number;
        public_mint: boolean;
    };
    drep?: IDrep;
    policy: string;

    getPzEnabled(handleType: HandleType, pz_enabled?: boolean): boolean | undefined {
        if (pz_enabled !== undefined) {
            return pz_enabled;
        }

        return handleType === HandleType.HANDLE ? true : undefined;
    }

    constructor(handle: StoredHandle) {
        if (!handle.utxo) {
            throw ApiError.handleNotFound();
        }

        this.hex = handle.hex;
        this.name = handle.name;
        this.image = handle.image;
        this.standard_image = handle.standard_image;
        this.holder = handle.holder;
        this.holder_type = handle.holder_type;
        this.length = handle.length;
        this.og_number = handle.og_number;
        this.rarity = handle.rarity;
        this.utxo = handle.utxo;
        this.characters = handle.characters;
        this.numeric_modifiers = handle.numeric_modifiers;
        this.default_in_wallet = handle.default_in_wallet;
        this.pfp_image = handle.pfp_image;
        this.pfp_asset = handle.pfp_asset?.replace('0x', '');
        this.bg_image = handle.bg_image;
        this.bg_asset = handle.bg_asset?.replace('0x', '');
        this.resolved_addresses = handle.resolved_addresses;
        this.created_slot_number = handle.created_slot_number;
        this.updated_slot_number = handle.updated_slot_number;
        this.has_datum = handle.has_datum;
        this.svg_version = handle.svg_version;
        this.image_hash = handle.image_hash?.replace('0x', '');
        this.standard_image_hash = handle.standard_image_hash?.replace('0x', '');
        this.last_update_address = handle.last_update_address;
        this.version = handle.version;
        this.handle_type = handle.handle_type;
        this.payment_key_hash = handle.payment_key_hash;
        this.pz_enabled = this.getPzEnabled(handle.handle_type, handle.pz_enabled);
        // Has this handle/sub-handle actually *been* personalized (vs. pz_enabled = allowed).
        // Same predicate as the PERSONALIZED secondary index, so field and filter agree.
        this.is_personalized = isHandlePersonalized(handle);
        this.drep = handle.drep
        this.policy = handle.policy || '';

        // SubHandle attributes
        this.sub_rarity = handle.sub_rarity;
        this.sub_length = handle.sub_length;
        this.sub_characters = handle.sub_characters;
        this.sub_numeric_modifiers = handle.sub_numeric_modifiers;

        this.virtual = handle.virtual;
        this.original_address = handle.original_address;
        this.last_edited_time = handle.last_edited_time;
    }
}
