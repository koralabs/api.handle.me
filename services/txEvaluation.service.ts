import {
    ConnectionConfig,
    createInteractionContext,
    createTransactionSubmissionClient,
    JSONRPCError
} from '@cardano-ogmios/client';
import { Language, Plutus, Utxo, Value } from '@cardano-ogmios/schema';
import { LogCategory, Logger } from '@koralabs/kora-labs-common';
import { OGMIOS_HOST } from '../config';

type AssetAmount = {
    unit: string;
    quantity: string;
};

type EvaluateTxApiScript = {
    cbor: string;
    language: Language;
};

export type EvaluateTxApiUtxo = {
    txHash: string;
    outputIndex: number;
    address: string;
    amount: AssetAmount[];
    datumHash?: string;
    datum?: string;
    script?: EvaluateTxApiScript;
};

export type EvaluateTxRequestBody = {
    txCbor: string;
    additionalUtxos?: EvaluateTxApiUtxo[];
};

export type EvaluateTxResponse = {
    tag: string;
    index: number;
    budget: {
        mem: number;
        steps: number;
    };
};

export type EvaluateTxErrorResponse = {
    message: string;
    raw: unknown;
};

export class TxEvaluationRequestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TxEvaluationRequestError';
    }
}

const UNIT_PREFIX_LENGTH = 56;
const LOVELACE_UNIT = 'lovelace';

const evaluatePurposeToTag: Record<string, string> = {
    spend: 'SPEND',
    mint: 'MINT',
    publish: 'PUBLISH',
    withdraw: 'WITHDRAW',
    vote: 'VOTE',
    propose: 'PROPOSE'
};

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const parseOgmiosAddress = (host: string): ConnectionConfig['address'] => {
    const parsedUrl = new URL(host);
    const httpProtocol = parsedUrl.protocol === 'ws:' ? 'http:' : parsedUrl.protocol === 'wss:' ? 'https:' : parsedUrl.protocol;
    const websocketProtocol = parsedUrl.protocol === 'http:' ? 'ws:' : parsedUrl.protocol === 'https:' ? 'wss:' : parsedUrl.protocol;
    const basePath = parsedUrl.pathname === '/' ? '' : parsedUrl.pathname;

    return {
        http: `${httpProtocol}//${parsedUrl.host}${basePath}`,
        webSocket: `${websocketProtocol}//${parsedUrl.host}${basePath}`
    };
};

const assertValidHexUnit = (unit: string) => {
    if (unit.length < UNIT_PREFIX_LENGTH || !/^[0-9a-fA-F]+$/.test(unit)) {
        throw new TxEvaluationRequestError(`Invalid asset unit "${unit}"`);
    }
};

const buildValue = (amount: AssetAmount[]): Value => {
    return amount.reduce<Value>((acc, entry) => {
        if (!isNonEmptyString(entry?.quantity) || typeof entry?.unit !== 'string') {
            throw new TxEvaluationRequestError('Asset amount entries require string unit and quantity fields');
        }

        const quantity = BigInt(entry.quantity);
        if (entry.unit === LOVELACE_UNIT || entry.unit === '') {
            acc.ada = {
                lovelace: (acc.ada?.lovelace ?? 0n) + quantity
            };
            return acc;
        }

        assertValidHexUnit(entry.unit);
        const policyId = entry.unit.slice(0, UNIT_PREFIX_LENGTH);
        const assetName = entry.unit.slice(UNIT_PREFIX_LENGTH);
        (acc[policyId] ??= {})[assetName] = (acc[policyId]?.[assetName] ?? 0n) + quantity;
        return acc;
    }, {
        ada: {
            lovelace: 0n
        }
    });
};

const mapAdditionalUtxos = (additionalUtxos: EvaluateTxApiUtxo[] = []): Utxo => {
    return additionalUtxos.map((utxo, index) => {
        if (!isNonEmptyString(utxo?.txHash)) {
            throw new TxEvaluationRequestError(`additionalUtxos[${index}].txHash is required`);
        }
        if (typeof utxo?.outputIndex !== 'number' || !Number.isInteger(utxo.outputIndex) || utxo.outputIndex < 0) {
            throw new TxEvaluationRequestError(`additionalUtxos[${index}].outputIndex must be a non-negative integer`);
        }
        if (!isNonEmptyString(utxo?.address)) {
            throw new TxEvaluationRequestError(`additionalUtxos[${index}].address is required`);
        }
        if (!Array.isArray(utxo?.amount)) {
            throw new TxEvaluationRequestError(`additionalUtxos[${index}].amount must be an array`);
        }

        return {
            transaction: {
                id: utxo.txHash
            },
            index: utxo.outputIndex,
            address: utxo.address,
            value: buildValue(utxo.amount),
            ...(isNonEmptyString(utxo.datumHash) ? { datumHash: utxo.datumHash } : {}),
            ...(isNonEmptyString(utxo.datum) ? { datum: utxo.datum } : {}),
            ...(utxo.script ? { script: utxo.script as Plutus } : {})
        };
    });
};

const normalizeEvaluationSuccess = (result: Array<{ validator: { purpose: string; index: number }; budget: { memory: number; cpu: number } }>) => {
    return result.map<EvaluateTxResponse>(({ validator, budget }) => ({
        tag: evaluatePurposeToTag[validator.purpose] ?? validator.purpose.toUpperCase(),
        index: validator.index,
        budget: {
            mem: budget.memory,
            steps: budget.cpu
        }
    }));
};

const summarizeScriptExecutionError = (failure: any) => {
    const validationError = failure?.error?.data?.validationError;
    if (typeof validationError === 'string' && validationError.length > 0) {
        return validationError;
    }

    return failure?.error?.message ?? failure?.message ?? 'Transaction evaluation failed';
};

const normalizeOgmiosError = (error: any): { status: number; body: EvaluateTxErrorResponse[] } | null => {
    const rpcError = error instanceof JSONRPCError ? error : null;
    if (rpcError) {
        return {
            status: 503,
            body: [
                {
                    message: rpcError.message || 'Unable to connect to Ogmios',
                    raw: {
                        code: rpcError.code,
                        data: rpcError.data
                    }
                }
            ]
        };
    }

    if (error?.method === 'evaluateTransaction' && error?.error) {
        const code = Number(error.error.code);
        if (code === 3010 && Array.isArray(error.error.data)) {
            return {
                status: 400,
                body: error.error.data.map((failure: any) => ({
                    message: summarizeScriptExecutionError(failure),
                    raw: failure
                }))
            };
        }

        return {
            status: code >= 3000 && code < 4000 ? 400 : 503,
            body: [
                {
                    message: error.error.message ?? 'Transaction evaluation failed',
                    raw: error.error
                }
            ]
        };
    }

    if (error instanceof Error) {
        return {
            status: 503,
            body: [
                {
                    message: error.message || 'Unable to connect to Ogmios',
                    raw: {
                        name: error.name
                    }
                }
            ]
        };
    }

    return null;
};

export const validateEvaluateTxRequest = (body: unknown): EvaluateTxRequestBody => {
    if (!body || typeof body !== 'object') {
        throw new TxEvaluationRequestError('Request body must be a JSON object');
    }

    const { txCbor, additionalUtxos = [] } = body as EvaluateTxRequestBody;
    if (!isNonEmptyString(txCbor)) {
        throw new TxEvaluationRequestError('txCbor is required');
    }

    if (!Array.isArray(additionalUtxos)) {
        throw new TxEvaluationRequestError('additionalUtxos must be an array');
    }

    return {
        txCbor,
        additionalUtxos
    };
};

export const evaluateTransactionViaOgmios = async (
    request: EvaluateTxRequestBody,
    dependencies: {
        createInteractionContextFn?: typeof createInteractionContext;
        createTransactionSubmissionClientFn?: typeof createTransactionSubmissionClient;
    } = {}
): Promise<EvaluateTxResponse[]> => {
    const createInteractionContextFn = dependencies.createInteractionContextFn ?? createInteractionContext;
    const createTransactionSubmissionClientFn =
        dependencies.createTransactionSubmissionClientFn ?? createTransactionSubmissionClient;

    const context = await createInteractionContextFn(
        (error) => {
            Logger.log({
                message: `Ogmios tx evaluation socket error: ${error.message}`,
                category: LogCategory.ERROR,
                event: 'txEvaluation.socket.error'
            });
        },
        (code, reason) => {
            Logger.log({
                message: `Ogmios tx evaluation socket closed: ${code} ${String(reason)}`,
                category: LogCategory.ERROR,
                event: 'txEvaluation.socket.close'
            });
        },
        {
            connection: {
                address: parseOgmiosAddress(OGMIOS_HOST)
            }
        }
    );

    const client = await createTransactionSubmissionClientFn(context);

    try {
        const result = await client.evaluateTransaction(request.txCbor, mapAdditionalUtxos(request.additionalUtxos));
        return normalizeEvaluationSuccess(result);
    } catch (error) {
        const normalizedError = normalizeOgmiosError(error);
        if (normalizedError) {
            const wrappedError = new Error(normalizedError.body[0]?.message ?? 'Transaction evaluation failed') as Error & {
                status?: number;
                body?: EvaluateTxErrorResponse[];
            };
            wrappedError.status = normalizedError.status;
            wrappedError.body = normalizedError.body;
            throw wrappedError;
        }

        throw error;
    } finally {
        await client.shutdown();
    }
};
