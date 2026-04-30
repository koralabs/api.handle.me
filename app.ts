import { IS_LOCAL, LogCategory, Logger } from '@koralabs/kora-labs-common';
import compression from 'compression';
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
import notFoundMiddleware from './utils/notFound';
import packageJson from './package.json';
import { HandlesRepository } from './repositories/handlesRepository';
import OgmiosService from './services/ogmios/ogmios.service';
import { dynamicallyLoad } from './utils/util';

export interface AppOptions {
    disableOgmios?: boolean;
}

class App {
    public app: express.Application;
    public env: string;
    public port: string | number;
    public startTimer: number;
    public registry: IRegistry;
    public handlesRepo: HandlesRepository | undefined;
    public disableOgmios: boolean;

    constructor(options: AppOptions = {}) {
        this.app = express();
        this.registry = {} as IRegistry;
        this.env = NODE_ENV || 'development';
        this.port = PORT || 3141;
        this.startTimer = Date.now();
        this.disableOgmios = options.disableOgmios
            ?? process.env.ENABLE_OGMIOS_SCANNING?.toLocaleLowerCase() === 'false';
        // Sync env var so downstream readers (health controller, etc.) see the
        // same flag the constructor was told. Centralizes the side effect
        // here instead of letting each Lambda wrapper mutate at import time.
        if (this.disableOgmios) {
            process.env.ENABLE_OGMIOS_SCANNING = 'false';
        }
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
            Logger.log({ message: `🚀 ${this.env} app listening on port ${this.port} 🚀`, category: LogCategory.INFO, event: 'app.listen' });
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
        // Final route fall-through: distinguish 405 (path matched, method didn't)
        // from 404 (no path matched). Must come AFTER all routes are mounted.
        this.app.use(notFoundMiddleware(this.app));
        this.app.use(errorMiddleware);
        return this;
    }

    public getServer() {
        return this.app;
    }

    private initializeMiddleware() {
        this.app.use(cors({ origin: ORIGIN, credentials: CREDENTIALS }));
        this.app.use(compression());
        this.app.use(express.text());
        this.app.use(express.json());
        this.app.use(express.urlencoded({ extended: true }));
        // discoveryMiddleware (Link rel=service-doc, X-API-Version) is auto-loaded
        // from middlewares/ by initializeDynamicHandlers — no explicit mount needed.
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
        if (this.disableOgmios || this.env === 'test') {
            await handlesRepo.initialize();

            // If we're running local we want the scanner to replace ogmios scanning
            if (['development', 'test'].includes(NODE_ENV) && process.env.USE_LAMBDA_SCANNER == 'true') {
                await (async () => {
                    const scanner = await import('./lambdas/scanner');
                    scanner.lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context);
                    setInterval(() => {
                        Logger.local('Running scanner lambda...');
                        scanner.lambdaHandler({} as AWSLambda.ALBEvent, {} as AWSLambda.Context);
                    }, 60000);
                })();
            }

            return;
        }

        const ogmiosService = new OgmiosService(handlesRepo);
        await ogmiosService.initialize();
    }

    private initializeSwagger() {
        const swaggerSpecRoute = '/swagger/swagger.yml';
        const options = {
            customCss: '.swagger-ui .topbar { display: none } .swagger-ui .info .title .yaml-link { margin-left: 12px; font-size: 14px; }',
            customSiteTitle: 'Handles API',
            customfavIcon: '/assets/favicon.ico',
            customJsStr: `(() => {
                const mountLink = () => {
                    const title = document.querySelector('.swagger-ui .info .title');
                    if (!title || title.querySelector('.yaml-link')) return;
                    const link = document.createElement('a');
                    link.href = '${swaggerSpecRoute}';
                    link.className = 'yaml-link';
                    link.textContent = 'YAML';
                    link.target = '_blank';
                    link.rel = 'noopener noreferrer';
                    title.appendChild(link);
                };
                window.addEventListener('load', () => {
                    mountLink();
                    const interval = window.setInterval(() => {
                        mountLink();
                        if (document.querySelector('.swagger-ui .info .title .yaml-link')) {
                            window.clearInterval(interval);
                        }
                    }, 100);
                });
            })();`
        };

        try {
            const swaggerFile = IS_LOCAL ? './docs/swagger.yml' : './swagger.yml';
            // Substitute {{version}} so OpenAPI codegen sees a real semver, not a literal placeholder.
            const swaggerFileContent = fs.readFileSync(swaggerFile).toString().replace(/\{\{version\}\}/g, packageJson.version);
            const swaggerDoc = parse(swaggerFileContent);
            this.app.get(swaggerSpecRoute, (_req, res) => {
                res.type('application/yaml').send(swaggerFileContent);
            });
            this.app.use('/swagger', swaggerUi.serve, swaggerUi.setup(swaggerDoc, options));
        } catch (error: any) {
            Logger.log({ message: `Unable to load swagger with error: ${error?.message ?? error}`, category: LogCategory.ERROR, event: 'app.swagger.load' });
        }
    }
}

export default App;
