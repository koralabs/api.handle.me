import { hydrateKmsEnvironment } from '@koralabs/kora-labs-common/aws';

type ScannerApp = typeof import('./scanner.app');

const isSelfHostedScannerRuntime = () => {
    const kmsDisabled = `${process.env.KORA_KMS_DISABLED ?? ''}`.toLowerCase();
    return process.env.KORA_SCANNER_DEFER_IMPORTS?.toLowerCase() === 'true' || kmsDisabled === 'true' || kmsDisabled === '1';
};

const isFunctionUrlEvent = (event: any): boolean => Boolean(event?.requestContext?.http);

const logScannerBootstrapFailure = (error: unknown) => {
    const message = error instanceof Error ? error.message : `${error}`;
    const stack = error instanceof Error ? error.stack : undefined;
    console.error(JSON.stringify({
        category: 'ERROR',
        event: 'scannerLambda.bootstrapFailure',
        message: `Scanner bootstrap failed: ${message}`,
        stack
    }));
};

const buildScannerBootstrapFailureResponse = (event: any) => {
    if (!isFunctionUrlEvent(event)) return undefined;
    return {
        isBase64Encoded: false,
        statusCode: 500,
        headers: {
            'content-type': 'application/json'
        },
        body: JSON.stringify({ message: 'Scanner bootstrap failed' })
    };
};

const runScannerEntrypoint = async <T>(event: any, run: () => Promise<T>) => {
    try {
        return await run();
    } catch (error) {
        if (!isSelfHostedScannerRuntime()) throw error;
        logScannerBootstrapFailure(error);
        return buildScannerBootstrapFailureResponse(event);
    }
};

export const lambdaHandler = async (event: any, context: any) => runScannerEntrypoint(event, async () => {
    await hydrateKmsEnvironment();
    const { lambdaHandler: scannerLambdaHandler } = await import('./scanner.app');
    return scannerLambdaHandler(event, context);
});

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
