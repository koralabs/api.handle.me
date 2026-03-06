import { hydrateKmsEnvironment } from '@koralabs/kora-labs-common';
import { handler as appHandler } from './api.app';

export const handler = async (event: AWSLambda.ALBEvent, context: AWSLambda.Context) => {
    await hydrateKmsEnvironment();
    return appHandler(event, context);
};
