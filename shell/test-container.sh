#!/usr/bin/env bash
set -euo pipefail

IMAGE_TAG="${IMAGE_TAG:-handles-public-api:smoke-$(date +%s)}"
RUN_ENTRYPOINT_CHECK="${RUN_ENTRYPOINT_CHECK:-true}"
BUILD_LAMBDA_DIST="${BUILD_LAMBDA_DIST:-true}"
ISOLATE_DOCKER_CONFIG="${ISOLATE_DOCKER_CONFIG:-true}"
DOCKER_CONFIG_TMP=""
LOG_FILE="$(mktemp /tmp/handles-container-smoke.XXXXXX.log)"

cleanup() {
    rm -f "$LOG_FILE"
    if [[ -n "$DOCKER_CONFIG_TMP" ]]; then
        rm -rf "$DOCKER_CONFIG_TMP"
    fi
}
trap cleanup EXIT

for cmd in docker npm timeout; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "Missing required command: $cmd" >&2
        exit 1
    fi
done

if [[ "$ISOLATE_DOCKER_CONFIG" == "true" ]]; then
    DOCKER_CONFIG_TMP="$(mktemp -d /tmp/handles-docker-config.XXXXXX)"
    echo '{}' > "$DOCKER_CONFIG_TMP/config.json"
    export DOCKER_CONFIG="$DOCKER_CONFIG_TMP"
fi

if command -v shellcheck >/dev/null 2>&1; then
    shellcheck shell/install.sh shell/entrypoint.sh
else
    echo "shellcheck not installed; skipping shell lint checks"
fi

if [[ "$BUILD_LAMBDA_DIST" == "true" ]]; then
    npm run build:lambda
fi

if ! find dist -maxdepth 1 -type f -name '*.js' | grep -q .; then
    echo "dist/ does not contain compiled JavaScript output. Run npm run build:lambda first." >&2
    exit 1
fi

if [[ ! -f "dist/workers/redisSync.worker.js" ]]; then
    echo "dist/workers/redisSync.worker.js is missing. Run npm run build:lambda first." >&2
    exit 1
fi

docker build -t "$IMAGE_TAG" .

# Verifies Dockerfile + install.sh produced expected runtime artifacts.
docker run --rm --entrypoint bash "$IMAGE_TAG" -lc '
set -euo pipefail
test -x /app/entrypoint.sh
test -x /app/cardano-node
command -v ogmios >/dev/null
command -v tini >/dev/null
source ~/.nvm/nvm.sh
nvm use 21 >/dev/null
node -v >/dev/null
test -f /app/mainnet/config.json
test -f /app/preprod/config.json
test -f /app/preview/config.json
'

if [[ "$RUN_ENTRYPOINT_CHECK" == "true" ]]; then
    set +e
    timeout 45s docker run --rm -e MODE=ogmios "$IMAGE_TAG" --definitely-invalid-option >"$LOG_FILE" 2>&1
    RUN_CODE=$?
    set -e

    if [[ $RUN_CODE -eq 124 ]]; then
        echo "Entrypoint smoke check timed out. Container did not exit as expected." >&2
        cat "$LOG_FILE" >&2
        exit 1
    fi

    if [[ $RUN_CODE -eq 0 ]]; then
        echo "Entrypoint smoke check unexpectedly exited with status 0." >&2
        cat "$LOG_FILE" >&2
        exit 1
    fi

    if ! grep -q "A managed process exited with code" "$LOG_FILE"; then
        echo "Entrypoint did not emit expected fail-fast message." >&2
        cat "$LOG_FILE" >&2
        exit 1
    fi
fi

echo "Container smoke tests passed."
