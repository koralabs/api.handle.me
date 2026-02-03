import dotenv from "dotenv";
dotenv.config({ path: ".env" });

process.env.NODE_ENV = 'test';
//jest.spyOn(global.console, 'log').mockImplementation(() => jest.fn());

const config = {
    'preset': 'ts-jest/presets/default-esm',
    'testEnvironment': 'node',
    'globalTeardown': './repositories/tests/globalTeardown.ts',
    'silent': true

}
export default config