import { Logger } from '@koralabs/kora-labs-common';
import cors from 'cors';
import express from 'express';
import fs from 'fs';
import path from 'path';
import swaggerUi from 'swagger-ui-express';
import { parse } from 'yaml';
import { CREDENTIALS, NODE_ENV, ORIGIN, PORT } from './config';
import { IRegistry } from './interfaces/registry.interface';
import { DynamicLoadType } from './interfaces/util.interface';
import errorMiddleware from './middlewares/error.middleware';
import { HandlesRepository } from './repositories/handlesRepository';
import OgmiosService from './services/ogmios/ogmios.service';
import { dynamicallyLoad } from './utils/util';

class App {
    public app: express.Application;
    public env: string;
    public port: string | number;
    public startTimer: number;
    public registry: IRegistry;
    public handlesRepo: HandlesRepository | undefined;

    constructor() {
        this.app = express();
        this.registry = {} as IRegistry;
        this.env = NODE_ENV || 'development';
        this.port = PORT || 3141;
        this.startTimer = Date.now();
    }

    private _getDynamicLoadDirectories(): string[] {
        if ((this.env == 'development' || this.env == 'test') && process.env.DYNAMIC_LOAD_DIR) {
            return ['./', ...process.env.DYNAMIC_LOAD_DIR.split(';')];
        }
        return ['./'];
    }

    public async listen() {
        await this.initialize();
        this.app.set('trust proxy', 1); 
        const server = this.app.listen(this.port, () => {
            Logger.log(`🚀 ${this.env} app listening on port ${this.port}`);
        });
        server.keepAliveTimeout = 61 * 1000;
        await this.initializeOgmios();
    }

    public async lambda() {
        const app = await this.initialize();
        await this.initializeOgmios();
        return app;
    }

    public async initialize() {
        this.initializeMiddleware();
        await this.initializeDynamicHandlers();
        this.app.use(errorMiddleware);
        return this;
    }

    public getServer() {
        return this.app;
    }

    private initializeMiddleware() {
        this.app.use(cors({ origin: ORIGIN, credentials: CREDENTIALS }));
        this.app.use(express.text());
        this.app.use(express.json());
        this.app.use(express.urlencoded({ extended: true }));
    }

    private async initializeDynamicHandlers() {
        this.initializeSwagger();
        const dirs = this._getDynamicLoadDirectories();

        for (let i = 0; i < dirs.length; i++) {
            const dir = dirs[i];
            const middlewares = await dynamicallyLoad(path.resolve(`${dir}/middlewares`), DynamicLoadType.MIDDLEWARE);
            middlewares.forEach((middleware) => {
                this.app.use(middleware);
            });

            const routes = await dynamicallyLoad(path.resolve(`${dir}/routes`), DynamicLoadType.ROUTE);
            routes.forEach((route) => {
                this.app.use('/', route.router);
            });

            const registries = await dynamicallyLoad(path.resolve(`${dir}/ioc`), DynamicLoadType.REGISTRY);
            registries.forEach((registry: IRegistry) => {
                for (const [key, value] of Object.entries(registry)) {
                    this.registry[key] = value;
                }
            });
        }
        this.app.set('registry', this.registry);
    }

    private async initializeOgmios() {
        const handlesRepo = new HandlesRepository(new this.registry.handlesStore());
        if (process.env.READ_ONLY_STORE?.toLocaleLowerCase() == 'true'|| this.env === 'test') {
            await handlesRepo.initialize();
            
            // If we're running local we want the scanner to replace ogmios scanning
            if (['development', 'test'].includes(NODE_ENV) && process.env.USE_LAMBDA_SCANNER == 'true') {
                await (async () => {
                    const scanner = await import('./lambdas/scanner');
                    const rollback = await import('./lambdas/rollback');
                    setInterval(scanner.lambdaHandler, 60000);
                    setInterval(rollback.lambdaHandler, 60000);
                })();
            }

            return;
        }

        const ogmiosService = new OgmiosService(handlesRepo);
        await ogmiosService.initialize();
    }

    private initializeSwagger() {
        const options = {
            customCss: '.swagger-ui .topbar { display: none }',
            customSiteTitle: 'Handles API',
            customfavIcon: '/assets/favicon.ico'
        };

        try {
            const swaggerDoc = parse(fs.readFileSync('./swagger.yml').toString());
            this.app.use('/swagger', swaggerUi.serve, swaggerUi.setup(swaggerDoc, options));
        } catch (error: any) {
            Logger.log(`Unable to load swagger with error: ${error}`);
        }
    }
}

export default App;
