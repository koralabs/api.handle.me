import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import nodeResolve from '@rollup/plugin-node-resolve';
import multiInput from 'rollup-plugin-multi-input';
import typescript from 'rollup-plugin-typescript2';

export default (async () => ({
    input: [
        'express.ts',
        'lambdas/api.ts',
        'lambdas/scanner.ts',
        'lambdas/scanner-sideload.ts',
        'lambdas/snapshot.ts',
        'ioc/*.registry.ts',
        'middlewares/*.middleware.ts',
        'routes/*.route.ts',
        'workers/*.js'
    ],
    plugins: [
        typescript(),
        // @koralabs/kora-labs-common/mpt is bundled CJS and `require()`s the ESM-only
        // @aiken-lang/merkle-patricia-forestry (no `default` export). Without esmExternals the
        // commonjs plugin emits `import require$$0 from 'merkle-patricia-forestry'`, which crashes
        // the ESM fn at load ("does not provide an export named 'default'"). Marking MPF as an ESM
        // external makes the plugin interop its named exports (Trie) correctly. Scoped to MPF so
        // other (CJS) externals keep their default interop.
        commonjs({
            ignoreDynamicRequires: true,
            esmExternals: ['@aiken-lang/merkle-patricia-forestry']
        }),
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
