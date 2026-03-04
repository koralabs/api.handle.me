import { decodeCborToJson, DefaultTextFormat } from '@koralabs/kora-labs-common/utils/cbor';

export const HANDLE_POLICIES_NAME = 'handle_policies';

export interface PolicySettings {
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

const normalizePolicyId = (policyId: string): string => policyId.replace(/^0x/i, '');

export const normalizePolicies = (decodedDatum: unknown): Record<string, PolicySettings> => {
    const settingsMap = Array.isArray(decodedDatum) ? decodedDatum[0] : decodedDatum;
    if (!settingsMap || typeof settingsMap !== 'object' || Array.isArray(settingsMap)) {
        throw new Error('Invalid policies datum format');
    }

    return Object.entries(settingsMap).reduce<Record<string, PolicySettings>>((acc, [policyId, settings]) => {
        const normalizedPolicyId = normalizePolicyId(policyId);

        if (Array.isArray(settings)) {
            acc[normalizedPolicyId] = mapPolicyTupleToSettings(settings);
            return acc;
        }

        if (settings && typeof settings === 'object' && !Array.isArray(settings)) {
            const policySettings = settings as Record<string, unknown>;
            acc[normalizedPolicyId] = {
                first_minting_slot: toNumber(policySettings.first_minting_slot ?? policySettings.firstMintingSlot ?? 0),
                last_minting_slot: toOptionalSlot(policySettings.last_minting_slot ?? policySettings.lastMintingSlot ?? 0),
                sunset_slot: toOptionalSlot(policySettings.sunset_slot ?? policySettings.sunsetSlot ?? 0)
            };
            return acc;
        }

        throw new Error('Invalid policy settings format');
    }, {});
};

export const decodePoliciesDatum = async (policiesDatum: string): Promise<Record<string, PolicySettings>> => {
    const decodedPolicies = await decodeCborToJson({
        cborString: policiesDatum,
        schema: {},
        defaultKeyType: 'hex' as DefaultTextFormat
    });
    return normalizePolicies(decodedPolicies);
};
