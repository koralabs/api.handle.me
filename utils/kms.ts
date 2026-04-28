import { hydrateKmsEnvironment } from '@koralabs/kora-labs-common';

const hydrationPromises = new Map<string, Promise<void>>();

export const hydrateKmsKeysIfNeeded = async (keys: string[]): Promise<void> => {
    const uniqueKeys = [...new Set(keys)].filter(Boolean);

    await Promise.all(uniqueKeys.map(async (key) => {
        if (process.env[key] || !process.env[`${key}_ENC`]) {
            return;
        }

        let hydration = hydrationPromises.get(key);
        if (!hydration) {
            hydration = hydrateKmsEnvironment({ keys: [key] })
                .then(() => undefined)
                .finally(() => {
                    hydrationPromises.delete(key);
                });
            hydrationPromises.set(key, hydration);
        }

        await hydration;
    }));
};
