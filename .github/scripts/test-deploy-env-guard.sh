#!/usr/bin/env bash
set -euo pipefail

GUARD="$(dirname "$0")/deploy-env-guard.sh"
assert_ok() {
  local expected="$1" actual
  shift
  actual=$("$GUARD" "$@") || { echo "expected success: $*" >&2; exit 1; }
  [[ "$actual" == "$expected" ]] || { echo "expected $expected, got $actual: $*" >&2; exit 1; }
}
assert_refused() {
  local output
  if output=$("$GUARD" "$@" 2>&1); then
    echo "expected refusal: $*" >&2
    exit 1
  fi
  [[ "$output" == ::error::* ]] || { echo "missing GitHub error annotation: $output" >&2; exit 1; }
}

assert_ok preview push preview auto
assert_ok mainnet workflow_dispatch mainnet mainnet
assert_refused workflow_dispatch mainnet preview
assert_ok preview workflow_dispatch preview auto
assert_refused workflow_dispatch feature/branch auto
assert_ok preprod workflow_dispatch feature/branch preprod
printf 'All deploy environment guard cases passed.\n'
