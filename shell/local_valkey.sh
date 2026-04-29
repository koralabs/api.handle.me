#!/bin/bash
set -eu
set -a && source .env && set +a
REDIS_PORT=${REDIS_PORT:-6380}
REDIS_HOST=${REDIS_HOST:-127.0.0.1}
VALKEY_BIN=$(command -v valkey-server || true)
STATE_DIR=${TMPDIR:-/tmp}/api-handle-me-valkey

if [ -z "${VALKEY_BIN}" ] && [ -x /tmp/kora-redis/bin/valkey-server ]
then
    VALKEY_BIN=/tmp/kora-redis/bin/valkey-server
    export LD_LIBRARY_PATH="/tmp/kora-redis/root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
fi

if [ -z "${VALKEY_BIN}" ]
then
    VALKEY_BIN=$(command -v redis-server || true)
fi

if [ -z "${VALKEY_BIN}" ] && [ -x /tmp/kora-redis/root/usr/bin/redis-server ]
then
    VALKEY_BIN=/tmp/kora-redis/root/usr/bin/redis-server
    export LD_LIBRARY_PATH="/tmp/kora-redis/root/usr/lib/x86_64-linux-gnu${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
fi

if [ -z "${VALKEY_BIN}" ]
then
    if [ "$(printf '%s\n' 24.04 "$(lsb_release -rs)" | sort -V | head -n1)" = "24.04" ]
    then
        echo "Installing Valkey"
        sudo apt install -y valkey
        VALKEY_BIN=$(command -v valkey-server || true)
    else
        echo "You need to update your version of Ubuntu to at least 24.04 to install and run Valkey"
        exit 1
    fi
fi

if ! ss -lnt | grep -q ":${REDIS_PORT} "
then
    mkdir -p "${STATE_DIR}"
    VALKEY_PIDFILE="${STATE_DIR}/valkey-${REDIS_PORT}.pid"
    VALKEY_LOGFILE="${STATE_DIR}/valkey-${REDIS_PORT}.log"
    echo "Starting test Valkey instance - connecting to ${REDIS_HOST}:${REDIS_PORT}"
    "${VALKEY_BIN}" \
        --bind "${REDIS_HOST}" \
        --port "${REDIS_PORT}" \
        --save "" \
        --appendonly no \
        --daemonize yes \
        --dir "${STATE_DIR}" \
        --pidfile "${VALKEY_PIDFILE}" \
        --logfile "${VALKEY_LOGFILE}"

    for _ in $(seq 1 30)
    do
        if ss -lnt | grep -q ":${REDIS_PORT} "
        then
            break
        fi
        sleep 0.1
    done
fi

if ! ss -lnt | grep -q ":${REDIS_PORT} "
then
    echo "Unable to start Valkey on ${REDIS_HOST}:${REDIS_PORT}"
    exit 1
fi

echo "Valkey ready on ${REDIS_HOST}:${REDIS_PORT}"
