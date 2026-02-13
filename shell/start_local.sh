#!/bin/bash
set -eu
set -a && source .env && set +a
mkdir -p tmp
export OGMIOS_VER=${OGMIOS_VER:-6.11.2}
export CARDANO_NODE_VER=${CARDANO_NODE_VER:-10.5.3}
export SOCKET_PATH=${SOCKET_PATH:-"${PWD}/tmp/node.socket"}
export BASE_URL=${CONFIG_FILES_BASE_URL:-'https://book.play.dev.cardano.org/environments'}
export CARDANO_DB_PATH=${CARDANO_DB_PATH:-"./tmp"}
export NODE_CONFIG_PATH="./tmp/${NETWORK}"

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

mkdir -p  $HOME/.local/bin

if [ -d "../api.handle.me/workers" ]; then
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

if [ ! -x "$(command -v ./tmp/cardano-node/bin/cardano-node)" ]; then
    mkdir -p ./tmp/cardano-node
    (cd ./tmp/cardano-node && curl -fsSL https://github.com/IntersectMBO/cardano-node/releases/download/${CARDANO_NODE_VER}/cardano-node-${CARDANO_NODE_VER}-linux.tar.gz | tar -xz)
    chmod +x ./tmp/cardano-node/bin/cardano-node
fi

# Workaround for Mithril not outputting the protocolMagicId
cat ${NODE_CONFIG_PATH}/shelley-genesis.json | jq -r .networkMagic > ${NODE_DB}/protocolMagicId

exec ./tmp/cardano-node/bin/cardano-node run \
    --config ${NODE_CONFIG_PATH}/config.json \
    --topology ${NODE_CONFIG_PATH}/topology.json \
    --database-path ${NODE_DB} \
    --port 3000 \
    --host-addr 0.0.0.0 \
    --socket-path ${SOCKET_PATH} 2>&1 | stdbuf -oL -eL egrep --line-buffered '\b(startup:Info:|local socket:|ChainDB:Notice:|:Critical:|Validating chunk)\b' &

###############################################
#                  OGMIOS                     #
###############################################
if [ ! -x "$(command -v ./tmp/ogmios/bin/ogmios)" ]; then
    echo 'OGMIOS NOT FOUND. INSTALLING OGMIOS...';
    curl -sL https://github.com/CardanoSolutions/ogmios/releases/download/v${OGMIOS_VER}/ogmios-v${OGMIOS_VER}-x86_64-linux.zip -o ogmios.zip
    unzip ogmios.zip -d ./tmp/ogmios && rm ogmios.zip && chmod +x ./tmp/ogmios/bin/ogmios
fi

if ! pgrep -x "ogmios" > /dev/null
then
    echo "Starting Ogmios - connecting to ${SOCKET_PATH}"
    ./tmp/ogmios/bin/ogmios $HOST $NODE_CONFIG $NODE_SOCKET $@ --include-transaction-cbor --log-level Error &
fi
