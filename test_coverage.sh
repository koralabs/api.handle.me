#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

REDIS_HOST="${REDIS_HOST:-127.0.0.1}"
REDIS_PORT="${REDIS_PORT:-6380}"
NETWORK="${NETWORK:-preview}"
REPORT_FILE="$ROOT_DIR/test_coverage.report"
TMP_OUTPUT="$(mktemp)"
trap 'rm -f "$TMP_OUTPUT"' EXIT

chmod +x ./shell/local_valkey.sh
REDIS_HOST="$REDIS_HOST" REDIS_PORT="$REDIS_PORT" ./shell/local_valkey.sh

NETWORK="$NETWORK" REDIS_HOST="$REDIS_HOST" REDIS_PORT="$REDIS_PORT" \
  npx jest -c jest.critical.config.ts --forceExit --runInBand --coverage --coverageReporters=json-summary --coverageReporters=text-summary > "$TMP_OUTPUT" 2>&1

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
  echo "SOURCE_PATHS=repositories/handlesRepository.ts,services/ogmios/ogmios.service.ts,stores/redis/index.ts"
  echo "EXCLUDED_PATHS=NON_CRITICAL_RUNTIME_PATHS:covered_by_separate_suites"
  echo "LANGUAGE_SUMMARY=nodejs:lines=$LINE_COVERAGE,branches=$BRANCH_COVERAGE,tool=jest,status=$LANGUAGE_STATUS"
  echo
  echo "=== RAW_OUTPUT_JEST ==="
  cat "$TMP_OUTPUT"
  echo
  echo "=== RAW_OUTPUT_COVERAGE_SUMMARY_JSON ==="
  cat coverage/coverage-summary.json
} > "$REPORT_FILE"

if [[ "$STATUS" != "pass" ]]; then
  echo "Coverage threshold failed: lines=$LINE_COVERAGE, branches=$BRANCH_COVERAGE"
  exit 1
fi

echo "Coverage threshold met: lines=$LINE_COVERAGE, branches=$BRANCH_COVERAGE"
