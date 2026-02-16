import serverlessExpress from '@vendia/serverless-express';
import App from '../app';
const app = new App();
process.env.ENABLE_OGMIOS_SCANNING = 'false';
let serverlessHandler: ReturnType<typeof serverlessExpress> | undefined;

export const handler = async (event: AWSLambda.ALBEvent, context: AWSLambda.Context) => {
    if (!serverlessHandler) {
        serverlessHandler = serverlessExpress({ app: (await app.lambda()).app });
    }
    return (serverlessHandler as unknown as (event: AWSLambda.ALBEvent, context: AWSLambda.Context) => Promise<any>)(event, context);
};
