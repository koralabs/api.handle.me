#!/bin/bash
set -eu
set -a && source .env && set +a
REDIS_PORT=${REDIS_PORT:-6380}
REDIS_HOST=${REDIS_HOST:-127.0.0.1}
VALKEY_BIN=$(command -v valkey-server || true)
VALKEY_VERSION=${VALKEY_VERSION:-8.1.6}

if [ -z "${VALKEY_BIN}" ]
then
    VALKEY_RELEASE_OS="jammy"
    if [ "$(printf '%s\n' 24.04 "$(lsb_release -rs)" | sort -V | head -n1)" = "24.04" ]
    then
        VALKEY_RELEASE_OS="noble"
    fi

    VALKEY_RELEASE_ARCH=$(uname -m)
    case "${VALKEY_RELEASE_ARCH}" in
        x86_64|amd64)
            VALKEY_RELEASE_ARCH="x86_64"
            ;;
        aarch64|arm64)
            VALKEY_RELEASE_ARCH="arm64"
            ;;
        *)
            echo "Unsupported architecture for unattended Valkey bootstrap: ${VALKEY_RELEASE_ARCH}"
            exit 1
            ;;
    esac

    VALKEY_DOWNLOAD_DIR="${VALKEY_DOWNLOAD_DIR:-/tmp/valkey-${VALKEY_VERSION}-${VALKEY_RELEASE_OS}-${VALKEY_RELEASE_ARCH}}"
    VALKEY_ARCHIVE="${VALKEY_DOWNLOAD_DIR}.tar.gz"
    VALKEY_URL="https://download.valkey.io/releases/valkey-${VALKEY_VERSION}-${VALKEY_RELEASE_OS}-${VALKEY_RELEASE_ARCH}.tar.gz"
    VALKEY_BIN="${VALKEY_DOWNLOAD_DIR}/bin/valkey-server"

    if [ ! -x "${VALKEY_BIN}" ]
    then
        echo "Downloading Valkey ${VALKEY_VERSION} (${VALKEY_RELEASE_OS}/${VALKEY_RELEASE_ARCH})"
        rm -rf "${VALKEY_DOWNLOAD_DIR}"
        mkdir -p /tmp
        curl -fsSL "${VALKEY_URL}" -o "${VALKEY_ARCHIVE}"
        tar -xzf "${VALKEY_ARCHIVE}" -C /tmp
    fi

    if [ ! -x "${VALKEY_BIN}" ]
    then
        echo "Unable to prepare Valkey binary from ${VALKEY_URL}"
        exit 1
    fi
fi

if ! ss -lnt | grep -q ":${REDIS_PORT} "
then
    VALKEY_TMP_DIR="${VALKEY_TMP_DIR:-/tmp/api-handle-me-valkey}"
    mkdir -p "${VALKEY_TMP_DIR}"
    VALKEY_PIDFILE="${VALKEY_TMP_DIR}/valkey-${REDIS_PORT}.pid"
    VALKEY_LOGFILE="${VALKEY_TMP_DIR}/valkey-${REDIS_PORT}.log"
    echo "Starting test Valkey instance - connecting to ${REDIS_HOST}:${REDIS_PORT}"
    "${VALKEY_BIN}" \
        --bind "${REDIS_HOST}" \
        --port "${REDIS_PORT}" \
        --save "" \
        --appendonly no \
        --daemonize yes \
        --dir "${VALKEY_TMP_DIR}" \
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
