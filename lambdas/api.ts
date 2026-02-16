import serverlessExpress from '@vendia/serverless-express';
import App from '../app';
const app = new App();
process.env.READ_ONLY_STORE = 'true'
export const handler = serverlessExpress({ app: (await app.lambda()).app });