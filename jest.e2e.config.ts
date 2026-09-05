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
    testMatch: ['**/*.e2e.test.ts'],
    testTimeout: 120000
};

export default config;
