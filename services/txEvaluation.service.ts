import {
    createInteractionContext,
    createTransactionSubmissionClient
} from '@cardano-ogmios/client';
import { Utxo, Value } from '@cardano-ogmios/schema';
import { LogCategory, Logger } from '@koralabs/kora-labs-common';
import { OGMIOS_HOST } from '../config';

export type EvaluateTxAsset = {
    unit: string;
    quantity: string;
};

export type EvaluateTxAdditionalUtxo = {
    txHash: string;
    outputIndex: number;
    address: string;
    amount: EvaluateTxAsset[];
};

export type EvaluateTxRequestBody = {
    txCbor: string;
    additionalUtxos?: EvaluateTxAdditionalUtxo[];
};

export type EvaluatedBudget = {
    tag: string;
    index: number;
    budget: {
        mem: number;
        steps: number;
    };
};

export type ContractResponse = {
    tag?: string;
    index?: number;
    message: string;
    raw: unknown;
};

const OGMIOS_PURPOSE_TO_TAG: Record<string, string> = {
    spend: 'SPEND',
    mint: 'MINT',
    publish: 'CERT',
    withdraw: 'REWARD',
    vote: 'VOTE',
    propose: 'PROPOSE'
};

const getErrorMessage = (error: unknown) => {
    if (error instanceof Error) {
        return error.message;
    }

    if (typeof error === 'string') {
        return error;
    }

    try {
        return JSON.stringify(error);
    } catch {
        return String(error);
    }
};

const toOgmiosValue = (amount: EvaluateTxAsset[]): Value => {
    const value: { ada: { lovelace: bigint }; [policyId: string]: any } = {
        ada: {
            lovelace: 0n
        }
    };

    for (const { unit, quantity } of amount) {
        if (unit === 'lovelace') {
            value.ada = { lovelace: BigInt(quantity) };
            continue;
        }

        const policyId = unit.slice(0, 56);
        const assetName = unit.slice(56);
        if (!value[policyId]) {
            value[policyId] = {};
        }
        value[policyId][assetName] = BigInt(quantity);
    }

    return value as unknown as Value;
};

const toOgmiosAdditionalUtxo = (additionalUtxos: EvaluateTxAdditionalUtxo[] = []): Utxo =>
    additionalUtxos.map(({ txHash, outputIndex, address, amount }) => ({
        transaction: {
            id: txHash
        },
        index: outputIndex,
        address,
        value: toOgmiosValue(amount)
    }));

const toContractResponse = (message: string, raw: unknown, tag?: string, index?: number): ContractResponse => ({
    ...(tag ? { tag } : {}),
    ...(Number.isInteger(index) ? { index } : {}),
    message,
    raw
});

const mapScriptExecutionFailure = (entry: any): ContractResponse[] => {
    const tag = OGMIOS_PURPOSE_TO_TAG[entry?.validator?.purpose] ?? undefined;
    const index = Number.isInteger(entry?.validator?.index) ? entry.validator.index : undefined;
    const failure = entry?.error;

    if (!failure || typeof failure !== 'object') {
        return [toContractResponse(entry?.message ?? 'Script validation failed', entry, tag, index)];
    }

    if (failure.code === 3012) {
        const traces = Array.isArray(failure.data?.traces) ? failure.data.traces.filter((trace: unknown) => typeof trace === 'string') : [];
        const suffix = traces.length > 0 ? ` (${traces.join(' | ')})` : '';
        return [toContractResponse(`${failure.data?.validationError ?? failure.message}${suffix}`, entry, tag, index)];
    }

    if (failure.code === 3011) {
        const missingScripts = Array.isArray(failure.data?.missingScripts) ? failure.data.missingScripts : [];
        const missingPointers = missingScripts
            .map((pointer: any) =>
                pointer?.purpose && Number.isInteger(pointer?.index) ? `${pointer.purpose}:${pointer.index}` : ''
            )
            .filter(Boolean);
        const message =
            missingPointers.length > 0
                ? `Invalid redeemer pointers: missing scripts for ${missingPointers.join(', ')}`
                : failure.message;
        return [toContractResponse(message, entry, tag, index)];
    }

    if (failure.code === 3013) {
        const outputReference = failure.data?.outputReference;
        const outputRefText =
            outputReference?.transaction?.id && Number.isInteger(outputReference?.index)
                ? `${outputReference.transaction.id}#${outputReference.index}`
                : '';
        const message = outputRefText
            ? `${failure.message}: ${outputRefText}`
            : failure.message;
        return [toContractResponse(message, entry, tag, index)];
    }

    return [toContractResponse(failure.message ?? 'Script validation failed', entry, tag, index)];
};

export const mapEvaluationFailureToContractResponses = (error: unknown): ContractResponse[] => {
    const typedError = error as {
        code?: number;
        message?: string;
        data?: any;
        error?: { code?: number; message?: string; data?: any };
    };

    const rpcError = typedError?.error && typeof typedError.error === 'object' ? typedError.error : typedError;

    if (rpcError?.code === 3010 && Array.isArray(rpcError.data) && rpcError.data.length > 0) {
        return rpcError.data.flatMap(mapScriptExecutionFailure);
    }

    if (rpcError?.code === 3002) {
        const overlappingRefs = Array.isArray(rpcError.data?.overlappingOutputReferences)
            ? rpcError.data.overlappingOutputReferences
                  .map((outputRef: any) =>
                      outputRef?.transaction?.id && Number.isInteger(outputRef?.index)
                          ? `${outputRef.transaction.id}#${outputRef.index}`
                          : ''
                  )
                  .filter(Boolean)
            : [];
        const message =
            overlappingRefs.length > 0
                ? `${rpcError.message}: ${overlappingRefs.join(', ')}`
                : rpcError.message ?? 'Evaluation failed';
        return [toContractResponse(message, error)];
    }

    if (rpcError?.code === 3004 && typeof rpcError.data?.reason === 'string') {
        return [toContractResponse(`${rpcError.message}: ${rpcError.data.reason}`, error)];
    }

    return [toContractResponse(getErrorMessage(error), error)];
};

export const evaluateTx = async ({ txCbor, additionalUtxos = [] }: EvaluateTxRequestBody): Promise<EvaluatedBudget[]> => {
    const context = await createInteractionContext(
        (error) => {
            Logger.log({
                message: `tx evaluation Ogmios websocket error: ${error.message}`,
                category: LogCategory.ERROR,
                event: 'txEvaluation.ogmios.error'
            });
        },
        (code, reason) => {
            Logger.local(`tx evaluation Ogmios websocket closed (${code}): ${String(reason)}`);
        },
        {
            connection: {
                host: new URL(OGMIOS_HOST).hostname,
                port: Number(new URL(OGMIOS_HOST).port || (new URL(OGMIOS_HOST).protocol === 'wss:' ? 443 : 80)),
                tls: new URL(OGMIOS_HOST).protocol === 'wss:'
            }
        }
    );
    const client = await createTransactionSubmissionClient(context);

    try {
        const evaluated = await client.evaluateTransaction(txCbor, toOgmiosAdditionalUtxo(additionalUtxos));
        return evaluated.map(({ validator, budget }) => ({
            tag: OGMIOS_PURPOSE_TO_TAG[validator.purpose] ?? validator.purpose.toUpperCase(),
            index: validator.index,
            budget: {
                mem: budget.memory,
                steps: budget.cpu
            }
        }));
    } finally {
        await client.shutdown();
    }
};
