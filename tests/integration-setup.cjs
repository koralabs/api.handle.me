'use strict';
require('./network-guard.cjs');
module.exports = async () => {
    process.env.API_TEST_MODE = 'integration';
    process.env.NETWORK = 'preview';
    process.env.REDIS_HOST = '127.0.0.1';
    process.env.REDIS_PORT = '6381';
    process.env.REDIS_USE_TLS = 'false';
    await require('./valkey-harness.cjs').start();
};
