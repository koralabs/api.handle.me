import dotenv from "dotenv";
dotenv.config({ path: ".env" });

process.env.NODE_ENV = 'test';
//jest.spyOn(global.console, 'log').mockImplementation(() => jest.fn());

const config = {
    'preset': 'ts-jest/presets/default-esm',
    'testEnvironment': 'node',
    'silent': true,
    'testPathIgnorePatterns': ['\\.e2e\\.test\\.ts$']

}
export default config
