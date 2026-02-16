import serverlessExpress from '@vendia/serverless-express';
import App from '../app';
const app = new App();
process.env.ENABLE_OGMIOS_SCANNING = 'false';
export const handler = serverlessExpress({ app: (await app.lambda()).app });
