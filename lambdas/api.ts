import { hydrateKmsEnvironment } from '@koralabs/kora-labs-common';

export const handler = async (event: AWSLambda.ALBEvent, context: AWSLambda.Context) => {
    await hydrateKmsEnvironment();
    const { handler: appHandler } = await import('./api.app');
    return appHandler(event, context);
};
