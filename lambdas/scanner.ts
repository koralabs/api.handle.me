import { hydrateKmsEnvironment } from '@koralabs/kora-labs-common/aws';

type ScannerApp = typeof import('./scanner.app');

export const lambdaHandler = async (event: any, context: any) => {
    await hydrateKmsEnvironment();
    const { lambdaHandler: scannerLambdaHandler } = await import('./scanner.app');
    return scannerLambdaHandler(event, context);
};

export const Internal = {
    checkRollback: async (...args: Parameters<ScannerApp['Internal']['checkRollback']>) => {
        await hydrateKmsEnvironment();
        const { Internal: scannerInternal } = await import('./scanner.app');
        return scannerInternal.checkRollback(...args);
    },
    processRollback: async (...args: Parameters<ScannerApp['Internal']['processRollback']>) => {
        await hydrateKmsEnvironment();
        const { Internal: scannerInternal } = await import('./scanner.app');
        return scannerInternal.processRollback(...args);
    },
    processReindex: async (...args: Parameters<ScannerApp['Internal']['processReindex']>) => {
        await hydrateKmsEnvironment();
        const { Internal: scannerInternal } = await import('./scanner.app');
        return scannerInternal.processReindex(...args);
    },
    scan: async (...args: Parameters<ScannerApp['Internal']['scan']>) => {
        await hydrateKmsEnvironment();
        const { Internal: scannerInternal } = await import('./scanner.app');
        return scannerInternal.scan(...args);
    }
};
