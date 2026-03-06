import { hydrateKmsEnvironment } from '@koralabs/kora-labs-common';
import { Internal as scannerInternal, lambdaHandler as scannerLambdaHandler } from './scanner.app';

export const lambdaHandler = async (event: any, context: any) => {
    await hydrateKmsEnvironment();
    return scannerLambdaHandler(event, context);
};

export const Internal = {
    checkRollback: async (...args: Parameters<typeof scannerInternal.checkRollback>) => {
        await hydrateKmsEnvironment();
        return scannerInternal.checkRollback(...args);
    },
    processRollback: async (...args: Parameters<typeof scannerInternal.processRollback>) => {
        await hydrateKmsEnvironment();
        return scannerInternal.processRollback(...args);
    },
    processReindex: async (...args: Parameters<typeof scannerInternal.processReindex>) => {
        await hydrateKmsEnvironment();
        return scannerInternal.processReindex(...args);
    },
    scan: async (...args: Parameters<typeof scannerInternal.scan>) => {
        await hydrateKmsEnvironment();
        return scannerInternal.scan(...args);
    }
};
