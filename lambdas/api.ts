import { hydrateKmsKeysIfNeeded } from '../utils/kms';

export type ApiLambdaEvent = AWSLambda.ALBEvent | AWSLambda.APIGatewayProxyEventV2;
export type ApiEventSourceName = 'AWS_ALB' | 'AWS_API_GATEWAY_V2';
const API_BOOTSTRAP_KMS_KEYS = ['WHITELISTED_API_KEYS'];

const getEventSourceName = (event: ApiLambdaEvent): ApiEventSourceName | null => {
    if (event?.requestContext && 'http' in event.requestContext) {
        return 'AWS_API_GATEWAY_V2';
    }
    if (event?.requestContext && 'elb' in event.requestContext) {
        return 'AWS_ALB';
    }
    return null;
};

const buildUnsupportedEventResponse = () => {
    return {
        statusCode: 400,
        headers: {
            'content-type': 'application/json'
        },
        body: JSON.stringify({
            message: 'Unsupported event source'
        })
    };
};

export const handler = async (event: ApiLambdaEvent, context: AWSLambda.Context) => {
    const eventSourceName = getEventSourceName(event);
    if (!eventSourceName) {
        return buildUnsupportedEventResponse();
    }

    if (process.env.RATE_LIMITER_ENABLED === 'true') {
        await hydrateKmsKeysIfNeeded(API_BOOTSTRAP_KMS_KEYS);
    }

    const { handler: appHandler } = await import('./api.app');
    return appHandler(event, context, { eventSourceName });
};
