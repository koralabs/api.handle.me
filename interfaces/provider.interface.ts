import { UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import { HandleOnChainData } from './ogmios.interfaces';

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

export interface KoiosMintedAsset {
    decimals: number,
    quantity: string,
    policy_id: string,
    asset_name: string,
    fingerprint: string
}

export interface KoiosTxInfo {
    block_hash: string;
    block_height: number;
    absolute_slot: number;
    id: any;
    outputs: {
        tx_hash: string;
        tx_index: number;
        value: string;
        payment_addr: {
            bech32: string;
        };
        asset_list: [string, string][];
        inline_datum: {
            bytes: string;
        };
        reference_script: {
            bytes: string;
            type: string;
        } | null;
    }[];
    inputs: {
        tx_hash: string;
        tx_index: number;
    }[];
    tx_hash: string;
    assets_minted: KoiosMintedAsset[];
    metadata: {
        [label: string]: HandleOnChainData;
    };
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
