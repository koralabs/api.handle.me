import { Metadatum, Transaction } from '@cardano-ogmios/schema';
import { AssetNameLabel, checkNameLabel, LogCategory, Logger } from '@koralabs/kora-labs-common';
import fetch from 'cross-fetch';
import v8 from 'v8';
import { NODE_ENV, OGMIOS_HOST } from '../../../config';
import { AssetDetailsFromAssetName, HealthResponseBody } from '../../../interfaces/ogmios.interfaces';

const parseCborObject = (value: any) => {
    const lastKey = Object.keys(value).pop();
    let objString = '';
    if (typeof value === 'object') {
        // We add the first curly brace
        objString += '{';
        for (const key in value) {
            if (key === 'map') {
                for (let i = 0; i < value[key].length; i++) {
                    const { k, v } = value[key][i];

                    if (v.map) {
                        objString += `"${k.string}":${parseCborObject(v)}`;
                    } else {
                        objString += `"${k.string}":${parseCborObject(v.string ?? v.int ?? v.list ?? '')}`;
                    }

                    // We add the comma
                    if (value[key].length !== i + 1) {
                        objString += ',';
                    }
                }
            } else {
                objString += `"${key}":${parseCborObject(value[key])}`;
            }

            // We add the comma
            if (key !== lastKey) {
                objString += ',';
            }
        }
        // We add the last curly brace
        objString += '}';
    } else if (typeof value === 'string') {
        objString += `"${value}"`;
    } else if (typeof value === 'number') {
        objString += `${value}`;
    } else if (typeof value === 'bigint') {
        objString += `${Number(value)}`;
    }
    return objString;
};

/**
 *
 * expecting cbor metadata after 721 or some other label
 *
 * @param metadata
 * @returns parsed metadata
 */
export const buildOnChainObject = <T>(cborData: any): T | null => {
    try {
        const stringifiedMetadata = parseCborObject(cborData);
        return JSON.parse(stringifiedMetadata) as T;
    } catch (error: any) {
        Logger.log(`Error building metadata: ${error.message}`);
        return null;
    }
};

export const getHandleNameFromAssetName = (asset: string): AssetDetailsFromAssetName => {
    let ownerTokenHex = `${asset}`;

    // check if asset name has a period. If so, it includes the policyId
    if (ownerTokenHex.includes('.')) {
        ownerTokenHex = ownerTokenHex.split('.')[1];
    }
    const { isCip67, name, assetLabel } = checkNameLabel(ownerTokenHex);
    if (isCip67) {
        // We need to return the hex of the associated Handle (not the current asset being processed)
        ownerTokenHex = `${assetLabel == AssetNameLabel.LBL_000 ? AssetNameLabel.LBL_000 : AssetNameLabel.LBL_222}${ownerTokenHex.replace(assetLabel ?? '', '')}`;
    }

    return {
        name,
        ownerTokenHex,
        isCip67,
        assetLabel
    };
};

export const fetchHealth = async (): Promise<HealthResponseBody | null> => {
    let ogmiosResults = null;
    try {
        const ogmiosResponse = await fetch(`${OGMIOS_HOST}/health`);
        ogmiosResults = await ogmiosResponse.json();
    } catch (error: any) {
        Logger.log({ message: error.message, category: LogCategory.ERROR, event: 'fetchOgmiosHealth.error' });
    }
    return ogmiosResults;
};

const canExitProcess = () => {
    return NODE_ENV !== 'test';
};

/**
 * Used to monitor memory usage and kill the process when it gets above 90%.
 */
export const memoryWatcher = () => {
    const heap = v8.getHeapStatistics();
    const usage = (heap.used_heap_size / heap.heap_size_limit) * 100;
    if (usage > 80 && usage < 90) {
        Logger.log({
            message: `Memory usage close to the limit (${usage.toFixed()}%)`,
            event: 'memoryWatcher.limit.close',
            category: LogCategory.INFO
        });
    } else if (usage > 90) {
        Logger.log({
            message: `Memory usage has reached the limit (${usage.toFixed()}%)`,
            event: 'memoryWatcher.limit.reached',
            category: LogCategory.NOTIFY
        });

        if (canExitProcess()) process.exit(1);
    }
};

export const buildOgmiosTransaction = (t: any) => {
    const tx: Transaction = {
        mint: t.assets_minted.reduce((acc: any, a: any) => {
            (acc[a.policy_id] ??= {})[a.asset_name] = BigInt(a.quantity);
            return acc;
        }, {}),
        id: t.tx_hash,
        spends: 'inputs',
        inputs: [],
        outputs: t.outputs.map((o: any) => {
            return {
                address: o.payment_addr.bech32,
                value: {
                    ada: { lovelace: BigInt(o.value) },
                    ...o.asset_list?.reduce((acc: any, a: any) => {
                        (acc[a.policy_id] ??= {})[a.asset_name] = BigInt(a.quantity);
                        return acc;
                    }, {})
                },
                datum: o.inline_datum?.bytes,
                script: o.reference_script ?? undefined
            };
        }),
        signatories: [],
        metadata: { hash: '', labels: Object.fromEntries(Object.entries(t.metadata ?? {}).map(([label, value]) => [label, { json: value as Metadatum }])) }
    };
    return tx;
};
