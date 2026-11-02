#!/usr/bin/env bash
# Local test run recorded by adahandle-deployments/common/test-evidence.sh (replaces the old Actions tests).
set -euo pipefail
( set -e; ./.github/scripts/test-deploy-env-guard.sh )
( set -e; npm ci )
( set -e; npm run test:container )
( set -e; npm run test:unit )
