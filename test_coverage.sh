#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${REDIS_PORT:-6380}"
NETWORK="${NETWORK:-preview}"

chmod +x ./shell/local_valkey.sh
REDIS_HOST="$REDIS_HOST" REDIS_PORT="$REDIS_PORT" ./shell/local_valkey.sh

NETWORK="$NETWORK" REDIS_HOST="$REDIS_HOST" REDIS_PORT="$REDIS_PORT" \
  npx jest -c jest.critical.config.ts --forceExit --runInBand --coverage --coverageReporters=json-summary --coverageReporters=text-summary

cp coverage/coverage-summary.json test_coverage.report

node -e "
const fs = require('fs');
const summary = JSON.parse(fs.readFileSync('test_coverage.report', 'utf8')).total;
const lines = Number(summary.lines.pct || 0);
const branches = Number(summary.branches.pct || 0);
if (lines < 90 || branches < 90) {
  console.error('Coverage threshold failed: lines=' + lines + ', branches=' + branches);
  process.exit(1);
}
console.log('Coverage threshold met: lines=' + lines + ', branches=' + branches);
"
