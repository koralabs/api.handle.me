import { UTxOWithTxInfo } from '@koralabs/kora-labs-common';

export interface KoiosAssetUTxO {
    asset_list: { asset_name: string; policy_id: string }[];
    reference_script: {
        bytes: string;
        type: string;
    } | null;
    inline_datum: {
        bytes: string;
    } | null;
    value: string;
    address: string;
    tx_hash: string;
    tx_index: number;
    block_height: number;
}

export interface KoiosAsset {
    decimals: number;
    quantity: string;
    policy_id: string;
    asset_name: string;
    fingerprint: string;
}

export interface HandleMetadata {
    [policyId: string]: {
        [handleName: string]: any;
    };
}

export interface KoiosOutput {
    tx_hash: string;
    tx_index: number;
    datum_hash: string | null;
    stake_addr: string | null;
    value: string;
    payment_addr: {
        bech32: string;
        cred: string;
    };
    asset_list: KoiosAsset[];
    inline_datum: {
        bytes: string;
        value: Record<string, any>;
    } | null;
    reference_script: {
        bytes: string;
        type: string;
    } | null;
}

export interface KoiosTxInfo {
    block_hash: string;
    block_height: number;
    absolute_slot: number;
    reference_inputs: any[]
    outputs: KoiosOutput[];
    inputs: {
        tx_hash: string;
        tx_index: number;
    }[];
    tx_hash: string;
    assets_minted: KoiosAsset[];
    metadata: {
        [label: string]: HandleMetadata;
    };
}

export interface KoiosDatumInfo {
    datum_hash: string;
    creation_tx_hash: string;
    value: Record<string, unknown>;
    bytes: string;
}

export interface BlockfrostBlock {
    hash: string;
    height: number;
    slot: number;
    confirmations: number;
}

export interface TxInfoWithUTxOs extends KoiosTxInfo {
    utxos: UTxOWithTxInfo[];
}

export interface BlockWithTxInfo extends BlockfrostBlock {
    transactions: KoiosTxInfo[];
}
