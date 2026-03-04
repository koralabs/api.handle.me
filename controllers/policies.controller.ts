import { HttpException } from '@koralabs/kora-labs-common';
import { decodeCborToJson, DefaultTextFormat } from '@koralabs/kora-labs-common/utils/cbor';
import { NextFunction, Request, Response } from 'express';
import { IRegistry } from '../interfaces/registry.interface';
import { HandlesRepository } from '../repositories/handlesRepository';

const HANDLE_POLICIES_NAME = 'handle_policies';

interface PolicySettings {
    first_minting_slot: number;
    last_minting_slot: number | null;
    sunset_slot: number | null;
}

const toNumber = (value: unknown): number => {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) {
        throw new Error('Invalid policy settings format');
    }
    return numberValue;
};

const toOptionalSlot = (value: unknown): number | null => {
    const numberValue = toNumber(value);
    return numberValue <= 0 ? null : numberValue;
};

const mapPolicyTupleToSettings = (tuple: unknown[]): PolicySettings => {
    if (tuple.length < 3) {
        throw new Error('Invalid policy tuple format');
    }

    return {
        first_minting_slot: toNumber(tuple[0]),
        last_minting_slot: toOptionalSlot(tuple[1]),
        sunset_slot: toOptionalSlot(tuple[2])
    };
};

const normalizePolicies = (decodedDatum: unknown): Record<string, PolicySettings> => {
    const settingsMap = Array.isArray(decodedDatum) ? decodedDatum[0] : decodedDatum;
    if (!settingsMap || typeof settingsMap !== 'object' || Array.isArray(settingsMap)) {
        throw new Error('Invalid policies datum format');
    }

    return Object.entries(settingsMap).reduce<Record<string, PolicySettings>>((acc, [policyId, settings]) => {
        if (Array.isArray(settings)) {
            acc[policyId] = mapPolicyTupleToSettings(settings);
            return acc;
        }

        if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
            const policySettings = settings as Record<string, unknown>;
            acc[policyId] = {
                first_minting_slot: toNumber(policySettings.first_minting_slot ?? policySettings.firstMintingSlot ?? 0),
                last_minting_slot: toOptionalSlot(policySettings.last_minting_slot ?? policySettings.lastMintingSlot ?? 0),
                sunset_slot: toOptionalSlot(policySettings.sunset_slot ?? policySettings.sunsetSlot ?? 0)
            };
            return acc;
        }

        throw new Error('Invalid policy settings format');
    }, {});
};

class PoliciesController {
    public async index(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const handleRepo = new HandlesRepository(new (req.app.get('registry') as IRegistry).handlesStore());
            let policiesDatum: string | null;

            try {
                policiesDatum = handleRepo.getHandleDatumByName(HANDLE_POLICIES_NAME);
            } catch (error) {
                if (error instanceof HttpException && error.status === 404) {
                    res.status(404).json({ message: 'Handle policies not found' });
                    return;
                }
                throw error;
            }

            if (!policiesDatum) {
                res.status(404).json({ message: 'Handle policies not found' });
                return;
            }

            try {
                const decodedPolicies = await decodeCborToJson({
                    cborString: policiesDatum,
                    schema: {},
                    defaultKeyType: req.query.default_key_type as DefaultTextFormat
                });
                res.status(handleRepo.currentHttpStatus()).json(normalizePolicies(decodedPolicies));
                return;
            } catch {
                res.status(400).json({ message: 'Unable to decode handle policies datum to json' });
                return;
            }
        } catch (error) {
            next(error);
        }
    }
}

export default PoliciesController;
