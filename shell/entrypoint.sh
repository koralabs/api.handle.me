#!/bin/bash
set -eu

export NODE_OPTIONS='--max-old-space-size=12288'
export NETWORK=${NETWORK:-mainnet}
export OGMIOS_HOST=${OGMIOS_HOST:-'http://0.0.0.0:1337'}
export DISABLE_HANDLES_SNAPSHOT=${DISABLE_HANDLES_SNAPSHOT:-false}
DISABLE_NODE_SNAPSHOT=${DISABLE_NODE_SNAPSHOT:-false}
ENABLE_SOCKET_REDIRECT=${ENABLE_SOCKET_REDIRECT:-false}
# api-only
# ogmios
# cardano-node
# both (cardano-node + ogmios)
# all [default] (cardano-node + ogmios + api)
MODE=${MODE:-all}
NODE_DB=${NODE_DB:-'/db'}
SOCKET_PATH=${SOCKET_PATH:-'/ipc/node.socket'}
CARDANO_NODE_PATH=${CARDANO_NODE_PATH:-'./cardano-node'}
NODE_CONFIG_PATH=${NODE_CONFIG_PATH:-"./${NETWORK}"}
OGMIOS_ARGS=("$@")
OGMIOS_PID=""
API_PID=""
CARDANO_NODE_PID=""
SOCAT_PID=""
CHILD_PIDS=()
mkdir -p "$(dirname "$SOCKET_PATH")"

function cleanup {
  local exit_code=${1:-0}
  trap - INT TERM QUIT ABRT

  if [[ -n "${API_PID}" ]] && kill -0 "${API_PID}" 2>/dev/null; then
    kill -TERM "${API_PID}" || true
  fi

  if [[ -n "${OGMIOS_PID}" ]] && kill -0 "${OGMIOS_PID}" 2>/dev/null; then
    kill -TERM "${OGMIOS_PID}" || true
  fi

  if [[ -n "${SOCAT_PID}" ]] && kill -0 "${SOCAT_PID}" 2>/dev/null; then
    kill -TERM "${SOCAT_PID}" || true
  fi

  if [[ -n "${CARDANO_NODE_PID}" ]] && kill -0 "${CARDANO_NODE_PID}" 2>/dev/null; then
    echo "Stopping cardano-node with SIGINT..."
    kill -INT "${CARDANO_NODE_PID}" || true
    wait "${CARDANO_NODE_PID}" || true
    echo "  ...CARDANO-NODE STOPPED"
  fi

  wait || true
  exit "${exit_code}"
}

function register_child {
  CHILD_PIDS+=("$1")
}

function has_argument {
  local expected="$1"
  shift
  local argument
  for argument in "$@"; do
    if [[ "${argument}" == "${expected}" ]]; then
      return 0
    fi
  done
  return 1
}

trap 'cleanup 0' INT TERM QUIT ABRT

if ! has_argument "--host" "${OGMIOS_ARGS[@]}"; then
    OGMIOS_ARGS+=("--host" "0.0.0.0")
fi
if ! has_argument "--node-config" "${OGMIOS_ARGS[@]}"; then
    OGMIOS_ARGS+=("--node-config" "${NODE_CONFIG_PATH}/config.json")
fi
if ! has_argument "--node-socket" "${OGMIOS_ARGS[@]}"; then
    OGMIOS_ARGS+=("--node-socket" "${SOCKET_PATH}")
fi

if [[ "${MODE}" == "ogmios" || "${MODE}" == "both" || "${MODE}" == "all" ]]; then
    # --include-transaction-cbor
    echo "STARTING OGMIOS..."
    ogmios --log-level Error "${OGMIOS_ARGS[@]}" &
    OGMIOS_PID=$!
    register_child "${OGMIOS_PID}"
    echo "  ...OGMIOS RUNNING"
fi

if [[ "${MODE}" == "ogmios" || "${MODE}" == "all" || "${MODE}" == "api-only" ]]; then
    echo "STARTING API..."
    # shellcheck source=/dev/null
    source "${HOME}/.nvm/nvm.sh"
    export TMPDIR=/tmp
    nvm use 21
    sed -i 's https://api.handle.me http://localhost:3141 ' swagger.yml
    sleep 5
    NODE_ENV=${NODE_ENV:-production} NETWORK=${NETWORK} OGMIOS_HOST=${OGMIOS_HOST} DISABLE_HANDLES_SNAPSHOT=${DISABLE_HANDLES_SNAPSHOT:-false} node express.js &
    API_PID=$!
    register_child "${API_PID}"
    echo "  ...API RUNNING"
fi

release_host() {
    case $NETWORK in
        preprod | mainnet)
            echo -n "release-${NETWORK}";;
        preview)
            echo -n "pre-release-preview";;
    esac
}
RELEASE_HOST=$(release_host)
export RELEASE_HOST

if [[ "${MODE}" == "cardano-node" || "${MODE}" == "both" || "${MODE}" == "all" ]]; then
    echo "STARTING CARDANO-NODE..."
    if [[ -d "${NODE_DB}/immutable" ]]; then
        echo "Previous Cardano database found. Continuing scan."
    elif [[ "${DISABLE_NODE_SNAPSHOT}" == "true" ]]; then
        mkdir -p "${NODE_DB}"
        echo "No previous Cardano database found. Starting from origin."
    else
        rm -rf "${NODE_DB}"
        mkdir -p "${NODE_DB}"
        echo "Grabbing latest snapshot with Mithril."
        MITHRIL_VERSION=2603.1
        curl -fsSL "https://github.com/input-output-hk/mithril/releases/download/${MITHRIL_VERSION}/mithril-${MITHRIL_VERSION}-linux-x64.tar.gz" | tar -xz
        AGGREGATOR_ENDPOINT="https://aggregator.${RELEASE_HOST}.api.mithril.network/aggregator"
        GENESIS_VERIFICATION_KEY=$(curl -fsS "https://raw.githubusercontent.com/input-output-hk/mithril/main/mithril-infra/configuration/${RELEASE_HOST}/genesis.vkey")
        ANCILLARY_VERIFICATION_KEY=$(curl -fsS "https://raw.githubusercontent.com/input-output-hk/mithril/main/mithril-infra/configuration/${RELEASE_HOST}/ancillary.vkey")
        DIGEST=latest
        export AGGREGATOR_ENDPOINT GENESIS_VERIFICATION_KEY ANCILLARY_VERIFICATION_KEY DIGEST
        chmod +x ./mithril-client
        #curl -o - $(./mithril-client cardano-db snapshot show --json $SNAPSHOT_DIGEST | jq -r '.locations[0]') | tar --use-compress-program=unzstd -x -C ${NODE_DB}
        if [[ "${NODE_DB%db}" == "" ]]; then
            ./mithril-client cardano-db download --include-ancillary "$DIGEST"
        else
            ./mithril-client cardano-db download --download-dir "${NODE_DB%db}" --include-ancillary "$DIGEST"
        fi
        echo "Mithril snapshot downloaded and validated."
    fi
    
    echo "Starting cardano-node."

    # Workaround for Mithril not outputting the protocolMagicId
    jq -r .networkMagic "${NODE_CONFIG_PATH}/shelley-genesis.json" > "${NODE_DB}/protocolMagicId"

    "${CARDANO_NODE_PATH}" run \
        --config "${NODE_CONFIG_PATH}"/config.json \
        --topology "${NODE_CONFIG_PATH}"/topology.json \
        --database-path "${NODE_DB}" \
        --port 3000 \
        --host-addr 0.0.0.0 \
        --socket-path "${SOCKET_PATH}" &
    CARDANO_NODE_PID=$!
    register_child "${CARDANO_NODE_PID}"

    if [[ "${ENABLE_SOCKET_REDIRECT}" == "true" ]]; then
        until [ -S "${SOCKET_PATH}" ]
        do
            sleep 1
        done
        echo "Found! ${SOCKET_PATH}"
        socat TCP-LISTEN:4001,reuseaddr,fork UNIX-CONNECT:"${SOCKET_PATH}" &
        SOCAT_PID=$!
        register_child "${SOCAT_PID}"
    fi
    echo "  ...CARDANO-NODE RUNNING"
fi

if [[ ${#CHILD_PIDS[@]} -eq 0 ]]; then
    echo "No managed services started for MODE=${MODE}. Exiting."
    exit 0
fi

set +e
wait -n "${CHILD_PIDS[@]}"
EXIT_CODE=$?
set -e
echo "A managed process exited with code ${EXIT_CODE}. Stopping remaining services."
cleanup "${EXIT_CODE}"
