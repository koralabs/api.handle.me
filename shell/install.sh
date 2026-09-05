#!/bin/bash
set -eu

CARDANO_NODE_VER=${CARDANO_NODE_VER:-10.5.3}
OGMIOS_VER=${OGMIOS_VER:-6.11.2}
CONFIG_FILES_BASE_URL=${CONFIG_FILES_BASE_URL:-'https://book.world.dev.cardano.org/environments'}
SOCKET_PATH=${SOCKET_PATH:-/ipc/node.socket}
if [[ "$(id -u)" -eq 0 ]]; then
    SUDO=""
else
    SUDO="sudo"
fi

${SUDO} apt update -y
${SUDO} apt install -y git curl socat jq unzip tini lz4 zstd valkey
if command -v systemctl >/dev/null 2>&1; then
    ${SUDO} systemctl enable valkey-server || true
fi
curl -fsSL "https://github.com/IntersectMBO/cardano-node/releases/download/${CARDANO_NODE_VER}/cardano-node-${CARDANO_NODE_VER}-linux.tar.gz" | tar -xz
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
rm -f ./cardano-node-"${CARDANO_NODE_VER}"-linux.tar.gz
cp ./bin/* ./
chmod +x ./cardano-node && chmod +x ./entrypoint.sh && mkdir -p "$(dirname "${SOCKET_PATH}")" && mkdir -p handles && touch handles/handles.json
BASE_URL=${CONFIG_FILES_BASE_URL}
declare -a NETWORKS=(preview preprod mainnet)
declare -a ERAS=(byron shelley alonzo conway)
for net in "${NETWORKS[@]}"
do 
    mkdir -p "${net}"
    if [ "${net}" == "mainnet" ]; then
        curl -sL "${BASE_URL}"/"${net}"/checkpoints.json -o "${net}"/checkpoints.json
    fi
    curl -sL "${BASE_URL}"/"${net}"/config.json -o "${net}"/config.json
    curl -sL "${BASE_URL}"/"${net}"/topology.json -o "${net}"/topology.json
    for era in "${ERAS[@]}"
    do
        curl -sL "${BASE_URL}"/"${net}"/"${era}"-genesis.json -o "${net}"/"${era}"-genesis.json
    done
done
curl -sL "https://github.com/CardanoSolutions/ogmios/releases/download/v${OGMIOS_VER}/ogmios-v${OGMIOS_VER}-x86_64-linux.zip" -o ogmios.zip
unzip ogmios.zip -d ./ogmios-install && rm ogmios.zip
${SUDO} cp ./ogmios-install/bin/ogmios /bin/ogmios && ${SUDO} chmod +x /bin/ogmios && rm -rf ./ogmios-install
# shellcheck source=/dev/null
source "${HOME}/.nvm/nvm.sh"
export TMPDIR=/tmp
nvm install 21
nvm use 21
echo "NodeJS Version is $(node -v)"
