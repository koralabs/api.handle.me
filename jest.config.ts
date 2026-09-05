import dotenv from "dotenv";
dotenv.config({ path: ".env" });

process.env.NODE_ENV = 'test';
process.env.IS_LOCAL = 'true';
// Force a deterministic Maestro key for unit tests (overrides whatever the dev's .env has).
// Tests intercept fetch so this value is never sent to a real API.
process.env.MAESTRO_API_KEY = 'test-maestro-api-key';
//jest.spyOn(global.console, 'log').mockImplementation(() => jest.fn());

const config = {
    'preset': 'ts-jest/presets/default-esm',
    'testEnvironment': 'node',
    'silent': true,
    'testPathIgnorePatterns': ['\\.e2e\\.test\\.ts$']

}
export default config
