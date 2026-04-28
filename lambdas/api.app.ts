import serverlessExpress from '@vendia/serverless-express';
import App from '../app';
import type { ApiEventSourceName, ApiLambdaEvent } from './api';

const app = new App();
process.env.ENABLE_OGMIOS_SCANNING = 'false';
let lambdaAppPromise: Promise<{ app: unknown }> | undefined;
let defaultServerlessHandler: ReturnType<typeof serverlessExpress> | undefined;
const serverlessHandlers: Partial<Record<ApiEventSourceName, ReturnType<typeof serverlessExpress>>> = {};

const getLambdaApp = async () => {
    if (!lambdaAppPromise) {
        lambdaAppPromise = app.lambda();
    }
    return lambdaAppPromise;
};

const createServerlessHandler = async (eventSourceName?: ApiEventSourceName) => {
    const { app: lambdaApp } = await getLambdaApp();
    return serverlessExpress({
        app: lambdaApp as Parameters<typeof serverlessExpress>[0]['app'],
        ...(eventSourceName ? { eventSourceName } : {})
    });
};

export const handler = async (
    event: ApiLambdaEvent,
    context: AWSLambda.Context,
    options?: { eventSourceName?: ApiEventSourceName }
) => {
    const eventSourceName = options?.eventSourceName;
    if (!eventSourceName) {
        if (!defaultServerlessHandler) {
            defaultServerlessHandler = await createServerlessHandler();
        }
        return (defaultServerlessHandler as unknown as (event: ApiLambdaEvent, context: AWSLambda.Context) => Promise<any>)(event, context);
    }

    if (!serverlessHandlers[eventSourceName]) {
        serverlessHandlers[eventSourceName] = await createServerlessHandler(eventSourceName);
    }

    return (serverlessHandlers[eventSourceName] as unknown as (event: ApiLambdaEvent, context: AWSLambda.Context) => Promise<any>)(event, context);
};
