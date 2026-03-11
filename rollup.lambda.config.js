import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import nodeResolve from '@rollup/plugin-node-resolve';
import multiInput from 'rollup-plugin-multi-input';
import typescript from 'rollup-plugin-typescript2';

export default (async () => ({
    input: [
        'lambdas/api.ts',
        'lambdas/scanner.ts',
        'lambdas/snapshot.ts',
        'ioc/*.registry.ts',
        'middlewares/*.middleware.ts',
        'routes/*.route.ts',
        'workers/*.js'
    ],
    plugins: [
        typescript(),
        commonjs({ignoreDynamicRequires: true}),
        nodeResolve(),
        json(),
        multiInput()
    ],
    output: {
        dir: 'dist',
        format: 'es'
    },
    external: [
        'aws-sdk',
        'forever',
        'swagger-ui-express',
        '@valkey/valkey-glide',
        '@aiken-lang/merkle-patricia-forestry',
        'level',
        'classic-level',
        'browser-level',
        'node-gyp-build'
    ]
}))();
