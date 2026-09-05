import dotenv from 'dotenv';
dotenv.config({ path: '.env' });

process.env.NODE_ENV = 'test';
process.env.IS_LOCAL = 'true';
process.env.REDIS_USE_TLS = 'false';
process.env.ENABLE_DATUM_ENDPOINT = 'true';

const config = {
    preset: 'ts-jest/presets/default-esm',
    testEnvironment: 'node',
    globalTeardown: './repositories/tests/globalTeardown.ts',
    silent: true,
    testMatch: ['**/*.test.ts', '**/*.e2e.test.ts'],
    testTimeout: 120000,
    collectCoverage: true,
    collectCoverageFrom: [
        'repositories/handlesRepository.ts',
        'services/ogmios/ogmios.service.ts',
        'stores/redis/index.ts'
    ],
    coverageThreshold: {
        './repositories/handlesRepository.ts': {
            statements: 80,
            branches: 67,
            functions: 75,
            lines: 82
        },
        './services/ogmios/ogmios.service.ts': {
            statements: 70,
            branches: 65,
            functions: 85,
            lines: 70
        },
        './stores/redis/index.ts': {
            statements: 80,
            branches: 63,
            functions: 80,
            lines: 82
        }
    }
};

export default config;
