#!/bin/bash
set -eu
# shellcheck source=/dev/null
set -a && source .env && set +a
REDIS_PORT=${REDIS_PORT:-6380}
REDIS_HOST=${REDIS_HOST:-127.0.0.1}

is_valkey_ready() {
    ss -lnt | grep -q ":${REDIS_PORT} "
}

find_valkey_server() {
    command -v valkey-server && return 0
    if [ -n "${HOME:-}" ] && [ -x "${HOME}/.local/bin/valkey-server" ]
    then
        printf '%s\n' "${HOME}/.local/bin/valkey-server"
        return 0
    fi
    command -v redis-server && return 0
    return 1
}

if is_valkey_ready
then
    echo "Valkey ready on ${REDIS_HOST}:${REDIS_PORT}"
    exit 0
fi

VALKEY_BIN=$(find_valkey_server || true)

if [ -z "${VALKEY_BIN}" ] && command -v lsb_release >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1
then
    if [ "$(printf '%s\n' 24.04 "$(lsb_release -rs)" | sort -V | head -n1)" = "24.04" ] && sudo -n true >/dev/null 2>&1
    then
        echo "Installing Valkey"
        sudo apt install -y valkey
        VALKEY_BIN=$(find_valkey_server || true)
    fi
fi

if [ -z "${VALKEY_BIN}" ]
then
    echo "Valkey or Redis server binary is required for e2e tests, but none was found on PATH or at ${HOME:-}/.local/bin/valkey-server"
    exit 1
fi

mkdir -p tmp
VALKEY_PIDFILE="${PWD}/tmp/valkey-${REDIS_PORT}.pid"
VALKEY_LOGFILE="${PWD}/tmp/valkey-${REDIS_PORT}.log"
echo "Starting test Valkey instance - connecting to ${REDIS_HOST}:${REDIS_PORT}"
"${VALKEY_BIN}" \
    --bind "${REDIS_HOST}" \
    --port "${REDIS_PORT}" \
    --save "" \
    --appendonly no \
    --daemonize yes \
    --dir "${PWD}/tmp" \
    --pidfile "${VALKEY_PIDFILE}" \
    --logfile "${VALKEY_LOGFILE}"

for _ in $(seq 1 30)
do
    if is_valkey_ready
    then
        break
    fi
    sleep 0.1
done

if ! is_valkey_ready
then
    echo "Unable to start Valkey on ${REDIS_HOST}:${REDIS_PORT}"
    exit 1
fi

echo "Valkey ready on ${REDIS_HOST}:${REDIS_PORT}"
