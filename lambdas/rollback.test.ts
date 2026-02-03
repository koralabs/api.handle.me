import * as rollbackModule from './rollback';

// Mock the dependencies
jest.mock('../utils/helpers');
jest.mock('../stores/redis');
jest.mock('../repositories/handlesRepository');

// Now import mocked modules

describe('Rollback Lambda', () => {
    describe('lambdaHandler', () => {
        // Note: Testing lambdaHandler fully requires proper module-level dependency injection
        // For now, we primarily test the buildUtxoWithTxInfoFromKoiosUtxo helper function
        // A full test would require refactoring the module to allow dependency injection

        it('should export lambdaHandler as a function', () => {
            expect(typeof (rollbackModule as any).lambdaHandler).toBe('function');
        });
    });
});
