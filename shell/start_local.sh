#!/bin/bash
set -eu

NETWORK_OVERRIDE="${NETWORK-}"
SOCKET_PATH_OVERRIDE="${SOCKET_PATH-}"
OGMIOS_PORT_OVERRIDE="${OGMIOS_PORT-}"
CARDANO_NODE_PORT_OVERRIDE="${CARDANO_NODE_PORT-}"
BASE_URL_OVERRIDE="${CONFIG_FILES_BASE_URL-}"
CARDANO_DB_PATH_OVERRIDE="${CARDANO_DB_PATH-}"

set -a && source .env && set +a
if [[ -n "${NETWORK_OVERRIDE}" ]]; then export NETWORK="${NETWORK_OVERRIDE}"; fi
if [[ -n "${SOCKET_PATH_OVERRIDE}" ]]; then export SOCKET_PATH="${SOCKET_PATH_OVERRIDE}"; fi
if [[ -n "${OGMIOS_PORT_OVERRIDE}" ]]; then export OGMIOS_PORT="${OGMIOS_PORT_OVERRIDE}"; fi
if [[ -n "${CARDANO_NODE_PORT_OVERRIDE}" ]]; then export CARDANO_NODE_PORT="${CARDANO_NODE_PORT_OVERRIDE}"; fi
if [[ -n "${BASE_URL_OVERRIDE}" ]]; then export CONFIG_FILES_BASE_URL="${BASE_URL_OVERRIDE}"; fi
if [[ -n "${CARDANO_DB_PATH_OVERRIDE}" ]]; then export CARDANO_DB_PATH="${CARDANO_DB_PATH_OVERRIDE}"; fi
mkdir -p tmp
export OGMIOS_VER=${OGMIOS_VER:-6.11.2}
export CARDANO_NODE_VER=${CARDANO_NODE_VER:-10.6.2}
export SOCKET_PATH=${SOCKET_PATH:-"${PWD}/tmp/node.socket"}
export OGMIOS_PORT=${OGMIOS_PORT:-1337}
export CARDANO_NODE_PORT=${CARDANO_NODE_PORT:-3000}
export BASE_URL=${CONFIG_FILES_BASE_URL:-'https://book.world.dev.cardano.org/environments'}
export CARDANO_DB_PATH=${CARDANO_DB_PATH:-"./tmp"}
export NODE_CONFIG_PATH="./tmp/${NETWORK}"
CARDANO_NODE_PID=""
OGMIOS_PID=""
MANAGED_CARDANO_NODE=false
MANAGED_OGMIOS=false
HOST=""
NODE_CONFIG=""
NODE_SOCKET=""
OGMIOS_PORT_ARG=""

cleanup() {
    if [[ "${MANAGED_CARDANO_NODE}" == "true" ]] && [[ -n "${CARDANO_NODE_PID}" ]] && kill -0 "${CARDANO_NODE_PID}" 2>/dev/null; then
        echo "Stopping cardano-node with SIGINT..."
        kill -INT "${CARDANO_NODE_PID}" || true
        wait "${CARDANO_NODE_PID}" || true
        echo "  ...CARDANO-NODE STOPPED"
    fi

    if [[ "${MANAGED_OGMIOS}" == "true" ]] && [[ -n "${OGMIOS_PID}" ]] && kill -0 "${OGMIOS_PID}" 2>/dev/null; then
        echo "Stopping ogmios..."
        kill -TERM "${OGMIOS_PID}" || true
        wait "${OGMIOS_PID}" || true
        echo "  ...OGMIOS STOPPED"
    fi

    exit 0
}

trap cleanup INT TERM QUIT ABRT

if [[ "$@" != *"--host"* ]]
then
    HOST="--host 0.0.0.0"
fi
if [[ "$@" != *"--node-config"* ]]
then
    NODE_CONFIG="--node-config ${NODE_CONFIG_PATH}/config.json"
fi
if [[ "$@" != *"--node-socket"* ]]
then
    NODE_SOCKET="--node-socket ${SOCKET_PATH}"
fi
if [[ "$@" != *"--port"* ]]
then
    OGMIOS_PORT_ARG="--port ${OGMIOS_PORT}"
fi

find_pid_by_arg() {
    local process_name="$1"
    local required_arg="$2"
    local match=""
    while IFS= read -r proc
    do
        if [[ "${proc}" == *"${required_arg}"* ]]; then
            match="${proc%% *}"
            break
        fi
    done < <(pgrep -a -x "${process_name}" || true)
    echo -n "${match}"
}

mkdir -p  $HOME/.local/bin

if [ -d "../api.handle.me/workers" ] && [ "$(realpath ../api.handle.me/workers)" != "$(realpath ./workers)" ]; then
    cp ../api.handle.me/workers/* ./workers/ 
fi

###############################################
#                  VALKEY                     #
###############################################
if ! pgrep -x "valkey-server" > /dev/null
then
    if grep -q "ID=amzn" /etc/os-release || [ "$(printf '%s\n' 24.04 "$(lsb_release -rs)" | sort -V | head -n1)" = "24.04" ]
    then
        echo "Starting Valkey - connecting to 6379"
        sudo apt install -y valkey
        sudo systemctl enable valkey-server
    else
        echo "You need to update your OS to Ubuntu 24.04 or Amazon Linux to install and run Valkey"
    fi
fi


###############################################
#               CARDANO NODE                  #
###############################################
echo 'Downloading cardano-node config files...'
declare -a NETWORKS=(preview preprod mainnet)
declare -a ERAS=(byron shelley alonzo conway)
for net in "${NETWORKS[@]}"; \
do \
    mkdir -p tmp/${net}
    curl -sL ${BASE_URL}/${net}/config.json -o tmp/${net}/config.json
    curl -sL ${BASE_URL}/${net}/topology.json -o tmp/${net}/topology.json
    curl -sL ${BASE_URL}/${net}/peer-snapshot.json -o tmp/${net}/peer-snapshot.json
    curl -sL ${BASE_URL}/${net}/checkpoints.json -o tmp/${net}/checkpoints.json
    for era in "${ERAS[@]}"; \
    do \
        curl -sL ${BASE_URL}/${net}/${era}-genesis.json -o tmp/${net}/${era}-genesis.json; \
    done; \
    jq '.EnableP2P = true | .PeerSharing = true' tmp/${net}/config.json > tmp/${net}/config.p2p.json
    mv tmp/${net}/config.p2p.json tmp/${net}/config.json
done

release_host() {
    case $NETWORK in
        preprod | mainnet)
            echo -n "release-${NETWORK}";;
        preview)
            echo -n "pre-release-preview";;
    esac
}
export RELEASE_HOST=$(release_host)

NODE_DB="${CARDANO_DB_PATH}/${NETWORK}/db"

if [[ -d "${NODE_DB}/immutable" ]]; then
    echo "Previous Cardano database found. Continuing scan"
else
    rm -rf ${NODE_DB}
    mkdir -p ${NODE_DB}
    mkdir -p ./tmp/mithril
    echo "Grabbing latest snapshot with Mithril."
    MITHRIL_VERSION=2603.1
    (cd ./tmp/mithril && curl -fsSL https://github.com/input-output-hk/mithril/releases/download/${MITHRIL_VERSION}/mithril-${MITHRIL_VERSION}-linux-x64.tar.gz | tar -xz)
    export AGGREGATOR_ENDPOINT=https://aggregator.${RELEASE_HOST}.api.mithril.network/aggregator
    export GENESIS_VERIFICATION_KEY=$(curl https://raw.githubusercontent.com/input-output-hk/mithril/main/mithril-infra/configuration/${RELEASE_HOST}/genesis.vkey)
    export ANCILLARY_VERIFICATION_KEY=$(curl https://raw.githubusercontent.com/input-output-hk/mithril/main/mithril-infra/configuration/${RELEASE_HOST}/ancillary.vkey)
    export DIGEST=latest
    chmod +x ./tmp/mithril/mithril-client
    #curl -o - $(./mithril-client cardano-db snapshot show --json $SNAPSHOT_DIGEST | jq -r '.locations[0]') | tar --use-compress-program=unzstd -x -C ${NODE_DB}
    if [[ "${NODE_DB%db}" == "" ]]; then
        ./tmp/mithril/mithril-client cardano-db download --include-ancillary $DIGEST
    else
        ./tmp/mithril/mithril-client cardano-db download --download-dir "${NODE_DB%db}" --include-ancillary $DIGEST
    fi
    echo "Mithril snapshot downloaded and validated."
fi

INSTALLED_CARDANO_NODE_VER=""
if [ -x ./tmp/cardano-node/bin/cardano-node ]; then
    INSTALLED_CARDANO_NODE_VER="$(./tmp/cardano-node/bin/cardano-node --version | awk 'NR==1 {print $2}')"
fi

if [ ! -x ./tmp/cardano-node/bin/cardano-node ] || [ "${INSTALLED_CARDANO_NODE_VER}" != "${CARDANO_NODE_VER}" ]; then
    echo "Installing cardano-node ${CARDANO_NODE_VER}..."
    rm -rf ./tmp/cardano-node
    mkdir -p ./tmp/cardano-node
    (cd ./tmp/cardano-node && curl -fsSL https://github.com/IntersectMBO/cardano-node/releases/download/${CARDANO_NODE_VER}/cardano-node-${CARDANO_NODE_VER}-linux-amd64.tar.gz | tar -xz)
    chmod +x ./tmp/cardano-node/bin/cardano-node
fi

# Workaround for Mithril not outputting the protocolMagicId
cat ${NODE_CONFIG_PATH}/shelley-genesis.json | jq -r .networkMagic > ${NODE_DB}/protocolMagicId

CARDANO_NODE_PID="$(find_pid_by_arg "cardano-node" "--socket-path ${SOCKET_PATH}")"
if [[ -n "${CARDANO_NODE_PID}" ]] && kill -0 "${CARDANO_NODE_PID}" 2>/dev/null
then
    if [[ ! -S "${SOCKET_PATH}" ]]
    then
        echo "cardano-node is already running but ${SOCKET_PATH} is missing."
        echo "This usually means cardano-node was started multiple times and the socket path was unlinked."
        echo "Stop existing cardano-node/ogmios processes and restart with npm run ogmios."
        exit 1
    fi
    echo "cardano-node already running. Reusing PID ${CARDANO_NODE_PID}."
else
    ./tmp/cardano-node/bin/cardano-node run \
        --config ${NODE_CONFIG_PATH}/config.json \
        --topology ${NODE_CONFIG_PATH}/topology.json \
        --database-path ${NODE_DB} \
        --port ${CARDANO_NODE_PORT} \
        --host-addr 0.0.0.0 \
        --socket-path ${SOCKET_PATH} > >(stdbuf -oL -eL egrep --line-buffered '\b(startup:Info:|local socket:|ChainDB:Notice:|:Critical:|Validating chunk)\b') 2>&1 &
    CARDANO_NODE_PID=$!
    MANAGED_CARDANO_NODE=true

    until [[ -S "${SOCKET_PATH}" ]]
    do
        sleep 1
    done
fi

###############################################
#                  OGMIOS                     #
###############################################
if [ ! -x "$(command -v ./tmp/ogmios/bin/ogmios)" ]; then
    echo 'OGMIOS NOT FOUND. INSTALLING OGMIOS...';
    curl -sL https://github.com/CardanoSolutions/ogmios/releases/download/v${OGMIOS_VER}/ogmios-v${OGMIOS_VER}-x86_64-linux.zip -o ogmios.zip
    unzip ogmios.zip -d ./tmp/ogmios && rm ogmios.zip && chmod +x ./tmp/ogmios/bin/ogmios
fi

OGMIOS_PID="$(find_pid_by_arg "ogmios" "--node-socket ${SOCKET_PATH}")"
if [[ -z "${OGMIOS_PID}" ]] || ! kill -0 "${OGMIOS_PID}" 2>/dev/null
then
    echo "Starting Ogmios - connecting to ${SOCKET_PATH}"
    ./tmp/ogmios/bin/ogmios $HOST $NODE_CONFIG $NODE_SOCKET $OGMIOS_PORT_ARG $@ --include-transaction-cbor --log-level Error &
    OGMIOS_PID=$!
    MANAGED_OGMIOS=true
else
    echo "ogmios already running. Reusing existing process."
fi

wait
