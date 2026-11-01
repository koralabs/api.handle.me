#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Never erase an operator's artifacts or mix old worker/chunk files into a release.
if [[ -e dist && ( ! -d dist || -n "$(find dist -mindepth 1 -print -quit)" ) ]]; then
    echo 'Refusing to build into nonempty dist; preserve existing artifacts and provide an empty output directory.' >&2
    exit 1
fi

# Both the compiler graph and the shipped runtime graph come from the root lock.
# No sibling links, registry re-resolution, or alternate runtime manifest.
node shell/check-build-lock.mjs
npm ci --include=dev
./node_modules/.bin/rollup -c rollup.lambda.config.js
cp package.json package-lock.json docs/swagger.yml dist/
npm ci --prefix dist --omit=dev
