const INDEX_NAMES = {
    ADDRESS: 'ADDRESS',
    CHARACTER: 'CHARACTER',
    HASH_OF_STAKE_KEY_HASH: 'HASH_OF_STAKE_KEY_HASH',
    PAYMENT_KEY_HASH: 'PAYMENT_KEY_HASH',
    LENGTH: 'LENGTH',
    NUMERIC_MODIFIER: 'NUMERIC_MODIFIER',
    OG: 'OG',
    PERSONALIZED: 'PERSONALIZED',
    RARITY: 'RARITY',
    SUBHANDLE: 'SUBHANDLE',
    HANDLE_TYPE: 'HANDLE_TYPE',
    HANDLE: 'HANDLE',
    HOLDER: 'HOLDER',
    SLOT: 'SLOT'
};

describe('config/constants', () => {
    afterEach(() => {
        jest.resetModules();
    });

    it('builds mainnet host and rate limiter enabled flag', () => {
        process.env.RATE_LIMITER_ENABLED = 'true';

        jest.isolateModules(() => {
            jest.doMock('@koralabs/kora-labs-common', () => ({
                IndexNames: INDEX_NAMES,
                NETWORK: 'mainnet'
            }));

            const constants = require('./constants');

            expect(constants.RATE_LIMITER_ENABLED).toBe(true);
            expect(constants.NETWORK_HOST).toBe('');
            expect(constants.MINTING_SERVICE_URL).toBe('https://minting.handle.me');
        });
    });

    it('builds non-mainnet host and disabled rate limiter flag', () => {
        process.env.RATE_LIMITER_ENABLED = 'false';

        jest.isolateModules(() => {
            jest.doMock('@koralabs/kora-labs-common', () => ({
                IndexNames: INDEX_NAMES,
                NETWORK: 'preview'
            }));

            const constants = require('./constants');

            expect(constants.RATE_LIMITER_ENABLED).toBe(false);
            expect(constants.NETWORK_HOST).toBe('preview.');
            expect(constants.MINTING_SERVICE_URL).toBe('https://preview.minting.handle.me');
        });
    });
});
