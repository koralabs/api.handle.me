import util from 'util';
import App from './app';
const app = new App();
// process.on('uncaughtException', (err) => {
//     Logger.log({message: `Uncaught Exception: ${JSON.stringify(err.message)} STACK: ${JSON.stringify(err.stack)}`, category: LogCategory.NOTIFY, event: 'uncaughtException'});
// });
// process.on('unhandledRejection', (err: Error) => {
//     Logger.log({message: `Unhandled Rejection: ${JSON.stringify(err.message)} STACK: ${JSON.stringify(err.stack)}`, category: LogCategory.NOTIFY, event: 'uncaughtException'});
//     // Log the error and potentially handle it
// });
const appPromise = util.promisify(app.listen).bind(app);
await Promise.all([appPromise()]);