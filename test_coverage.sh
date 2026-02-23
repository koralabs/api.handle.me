#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${REDIS_PORT:-6380}"
NETWORK="${NETWORK:-preview}"
REPORT_FILE="$ROOT_DIR/test_coverage.report"
STANDARD_TEST_OUTPUT="$(mktemp)"
COVERAGE_OUTPUT="$(mktemp)"
trap 'rm -f "$STANDARD_TEST_OUTPUT" "$COVERAGE_OUTPUT"' EXIT

chmod +x ./shell/local_valkey.sh
REDIS_HOST="$REDIS_HOST" REDIS_PORT="$REDIS_PORT" ./shell/local_valkey.sh

npm test > "$STANDARD_TEST_OUTPUT" 2>&1

NETWORK="$NETWORK" REDIS_HOST="$REDIS_HOST" REDIS_PORT="$REDIS_PORT" npx jest \
  -c jest.critical.config.ts \
  --forceExit \
  --runInBand \
  --coverage \
  --coverageReporters=json-summary \
  --coverageReporters=text-summary \
  --collectCoverageFrom='app.ts' \
  --collectCoverageFrom='config/**/*.ts' \
  --collectCoverageFrom='controllers/**/*.ts' \
  --collectCoverageFrom='ioc/**/*.ts' \
  --collectCoverageFrom='lambdas/**/*.ts' \
  --collectCoverageFrom='middlewares/**/*.ts' \
  --collectCoverageFrom='models/**/*.ts' \
  --collectCoverageFrom='repositories/**/*.ts' \
  --collectCoverageFrom='routes/**/*.ts' \
  --collectCoverageFrom='services/**/*.ts' \
  --collectCoverageFrom='stores/**/*.ts' \
  --collectCoverageFrom='utils/**/*.ts' \
  --collectCoverageFrom='!**/*.test.ts' \
  --collectCoverageFrom='!**/*.e2e.test.ts' \
  --collectCoverageFrom='!repositories/tests/**' \
  --collectCoverageFrom='!services/ogmios/tests/**' \
  --collectCoverageFrom='!scripts/**' \
  --collectCoverageFrom='!interfaces/**' \
  --collectCoverageFrom='!**/*.d.ts' \
  > "$COVERAGE_OUTPUT" 2>&1

read -r LINE_COVERAGE BRANCH_COVERAGE < <(
  node -e "
const fs = require('fs');
const summary = JSON.parse(fs.readFileSync('coverage/coverage-summary.json', 'utf8')).total;
const lines = Number(summary.lines.pct || 0);
const branches = Number(summary.branches.pct || 0);
console.log(lines + ' ' + branches);
"
)

STATUS="pass"
LANGUAGE_STATUS="pass"
if awk -v line="$LINE_COVERAGE" -v branch="$BRANCH_COVERAGE" 'BEGIN { exit !(line + 0 < 90 || branch + 0 < 90) }'; then
  STATUS="fail"
  LANGUAGE_STATUS="fail"
fi

{
  echo "FORMAT_VERSION=1"
  echo "REPO=api.handle.me"
  echo "TIMESTAMP_UTC=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "THRESHOLD_LINES=90"
  echo "THRESHOLD_BRANCHES=90"
  echo "TOTAL_LINES_PCT=$LINE_COVERAGE"
  echo "TOTAL_BRANCHES_PCT=$BRANCH_COVERAGE"
  echo "STATUS=$STATUS"
  echo "SOURCE_PATHS=app.ts;config/**/*.ts;controllers/**/*.ts;ioc/**/*.ts;lambdas/**/*.ts;middlewares/**/*.ts;models/**/*.ts;repositories/**/*.ts;routes/**/*.ts;services/**/*.ts;stores/**/*.ts;utils/**/*.ts"
  echo "EXCLUDED_PATHS=scripts/**:manual_ops_utilities;interfaces/**:type_only_contracts;**/*.test.ts:test_code;**/*.e2e.test.ts:test_code;repositories/tests/**:test_fixtures;services/ogmios/tests/**:test_fixtures;**/*.d.ts:type_declarations;express.ts:top_level_await_not_instrumented_in_current_jest_path"
  echo "LANGUAGE_SUMMARY=nodejs:lines=$LINE_COVERAGE,branches=$BRANCH_COVERAGE,tool=jest,status=$LANGUAGE_STATUS"
  echo
  echo "=== RAW_OUTPUT_STANDARD_TEST ==="
  cat "$STANDARD_TEST_OUTPUT"
  echo
  echo "=== RAW_OUTPUT_COVERAGE_JEST ==="
  cat "$COVERAGE_OUTPUT"
  echo
  echo "=== RAW_OUTPUT_COVERAGE_SUMMARY_JSON ==="
  cat coverage/coverage-summary.json
} > "$REPORT_FILE"

if [[ "$STATUS" != "pass" ]]; then
  echo "Coverage threshold failed: lines=$LINE_COVERAGE, branches=$BRANCH_COVERAGE"
  exit 1
fi

echo "Coverage threshold met: lines=$LINE_COVERAGE, branches=$BRANCH_COVERAGE"
