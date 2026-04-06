# Decentralized Public API for Handles

<p align="center">
  <img src="./docs/handles-api.jpeg" />
</p>

This API uses Ogmios to scan Cardano chain data for Handle-related transactions and stores the indexed state in Valkey for fast reads. Snapshot artifacts are generated from that index and can be loaded at startup to reduce catch-up time.

Snapshot uploads are chain-verified before they are written to S3, startup ignores snapshots that do not carry that verification metadata, and the snapshot lambda keeps the latest fixed snapshot plus up to 5 days of archived snapshots in S3.

&nbsp;

# Documentation
- Index: `docs/index.md`
- Product docs: `docs/product/index.md`
- Technical spec: `docs/spec/index.md`
- Runtime entrypoints: `docs/spec/runtime-entrypoints.md`
- OpenAPI contract: `docs/swagger.yml`

## Deployment Ownership

- This repo contains the application source, local runtime scripts, and Lambda entrypoints for `api.handle.me`.
- Deployment orchestration is handled by the sibling repo `../adahandle-deployments`.
- Per the local ecosystem docs, `api.handle.me` deploys directly from `adahandle-deployments`, including the complementary Docker Hub deployment `handles-public-api`.
- Changes in this repo may still require corresponding updates in `adahandle-deployments` before they are actually shipped.

&nbsp;

# Getting Started

## Local Development

### Start local chain services
```sh
npm install
npm run ogmios
```

- `npm run ogmios` runs `shell/start_local.sh`.
- It sources `.env`, downloads network config into `./tmp`, installs or reuses local `cardano-node` and Ogmios binaries, and starts/reuses local chain services for the configured `NETWORK`.
- The app expects Valkey locally. For normal local development this means the default Valkey port `6379`.

### Start the API
```sh
npm run api
```

- This starts the Express API from `express.ts` and will initialize Ogmios scanning unless `ENABLE_OGMIOS_SCANNING=false`.
- Read-only local mode is also available:
```sh
npm run readonly
```

### Local runtime notes
- `USE_LAMBDA_SCANNER=true` only applies in local `development` or `test` mode when in-process Ogmios scanning is disabled. In that mode the app invokes the scanner Lambda entrypoint on a 60-second loop.
- Local e2e and critical tests use a separate Valkey instance on `127.0.0.1:6380` so they do not wipe a live local scan on `6379`.

&nbsp;

### Prerequisites
- Install Docker - https://docs.docker.com/get-docker/

## Container Runtime

### Run the following
```sh
docker pull koralabs/handles-api
docker run -p 3141:3141 -v db:/db -v handles:/app/handles koralabs/handles-api
```
- The `-v db:/db` and `-v handles:/app/handles` mounts can be omitted, but keeping them preserves the cardano-node DB and other on-disk app state across restarts.
- You can also map a volume to the node socket with `-v <path_to_socket_folder>:/ipc`. This lets you use the cardano-node with other apps outside the container.

&nbsp;

### If you already have a cardano-node running, you can use the ogmios-only version
```sh
docker pull koralabs/handles-api
docker run -p 3141:3141 -v <path_to_node.socket_folder>:/ipc -v handles:/app/handles -e MODE=ogmios koralabs/handles-api:latest
```

- Replace `<path_to_socket_folder>` with the path to your ipc folder on the host that has the node.socket file

&nbsp;

# Testing the API 
- Open a browser to [http://localhost:3141/swagger](http://localhost:3141/swagger)
- You can also see the current API status at [http://localhost:3141/health](http://localhost:3141/health)
- Active Handle policy settings are available at [http://localhost:3141/policies](http://localhost:3141/policies) as normalized JSON (`first_minting_slot`, `last_minting_slot`, `sunset_slot` per hex policy ID without `0x` prefix)
- Health statuses currently include `current`, `storage_behind`, `ogmios_behind`, `updating`, and `waiting_on_cardano_node`.
- Most read endpoints return `202` while the indexed store is still catching up. Treat that data as best-effort until the API returns `200`.

## MCP Endpoint
- `POST /mcp` exposes a Model Context Protocol (MCP) JSON-RPC endpoint.
- Supported methods: `initialize`, `ping`, `tools/list`, `tools/call`.
- Included read-only tools: `get_handle`, `get_handle_utxo`, `search_handles`, `get_holder`, `list_holders`, `get_policies`, `get_stats`.
- `search_handles` supports `slot_number` pagination and holder filtering via `holder_address`.
- `search_handles` requires `page` and `slot_number` to be mutually exclusive.
- `GET /mcp` currently returns `405` (SSE streaming transport is not enabled).

&nbsp;

## Lambda Runtime
- API Lambda entrypoint: `lambdas/api.ts`
- Scanner Lambda entrypoint: `lambdas/scanner.ts`
- Snapshot Lambda entrypoint: `lambdas/snapshot.ts`
- The standard Lambda Rollup build bundles `api.ts`, `scanner.ts`, and `snapshot.ts`.
- The `valkey-utility` Lambda is ad hoc — see `docs/spec/scanner-recovery-runbook.md`.
- Scanner Lambda function URLs support a whitelisted reindex shortcut through `/reindex` or `/scanner/reindex`.

&nbsp;

## Running Automated Tests
- Unit tests:
```sh
npm run test:unit
```
- E2E tests (Valkey-backed):
```sh
npm run test:e2e
```
- Full suite:
```sh
npm test
```
- Critical processing coverage gate (UTxO + handle + holder paths):
```sh
npm run test:critical
```
- Container smoke tests (Dockerfile + install + entrypoint behavior):
```sh
npm run test:container
```
- Test isolation:
  - `test:e2e` and `test:critical` run against a dedicated local Valkey instance on `127.0.0.1:6380` by default (`REDIS_HOST` / `REDIS_PORT`), so they do not wipe a live scan running on `6379`.
  - `test:container` builds the image and runs lightweight runtime checks; requires a local Docker daemon.

&nbsp;

## TESTNET ENVIRONMENTS
To use Preview or PreProd environments just add `-e NETWORK=preview` or `-e NETWORK=preprod` to either of the `docker run...` commands.

&nbsp;

## OTHER OPTIONS
All of the options below can be passed into the container using `-e ENV_VAR=value` arguments on the `docker run...` command.
> `MODE=<api-only|ogmios|cardano-node|both|all>`
`api-only` will skip cardano-node and Ogmios and will only run the API NodeJS Express app. This requires `OGMIOS_HOST` to be set.
`ogmios` will run only Ogmios 
`cardano-node` will run only cardano-node
`both` will wun both cardano-node and Ogmios
`all` DEFAULT - This runs cardano-node, ogmios, and the API

> `OGMIOS_HOST=<http url with port>` Required for running with `MODE=api-only`.

> `DISABLE_NODE_SNAPSHOT=true` If no existing Cardano DB is found at `NODE_DB` (default `/db`), the container downloads a Mithril snapshot by default to reduce spin-up time. Use this option to skip the snapshot download and start cardano-node from origin. Existing DB data is reused if present. **🚩WARNING:** starting from origin can take a few days.

> `DISABLE_HANDLES_SNAPSHOT=true` By default, the container will try and download a Handles snapshot from S3 to reduce spin-up time. Use this option to skip the snapshot download and start the Ogmios Handles scan from origin. **🚩WARNING:** this can take a few hours.

> `BLOCKFROST_API_KEY=<key>` Optional for general provider helpers. Snapshot verification now reads the indexed `handle_root@handle_settings` datum directly, and startup ignores snapshots that were not chain-verified when generated.

> `CONFIG_FILES_BASE_URL='https://book.world.dev.cardano.org/environments'` A URL where the config, topology, and genesis files can be found. It should have the same folder structure as the default. 

See `site.env` for the full operator-facing env glossary, including local-only variables such as `OGMIOS_PORT`, `CARDANO_NODE_PORT`, `CARDANO_DB_PATH`, `OGMIOS_VER`, `CARDANO_NODE_VER`, and the `API_SCANNER_FUNCTION_URL_*` variables used by `shell/reindex-scanner.sh`.

&nbsp;

## NOTES

Depending on your internet connection, it can take 45 minutes to a few hours to download the cardano-node snapshot and begin an Ogmios scan.

A minimum of 24GB of RAM is required when running the container - 32GB recommended. If running in Ogmios-only mode, 4GB minimum is required, 8GB recommended.

The containers are setup for graceful cardano-node shutdown, but if you have to shut it down manually, for a more graceful shutdown (which helps subsequent load times), try running on the host (or in the container):
```sh
kill -SIGINT $(pidof cardano-node) 
```

For clean shutdowns (to avoid full immutable chunk validation from chunk `0` on next startup), make sure all of these are true:
- Stop with `SIGINT`/`SIGTERM` and allow enough time to exit (`docker stop --time 120 <container>` is a good baseline).
- Do not force kill the process/container (`SIGKILL`, `docker kill`, OOM kill).
- Reuse the same mounted DB path (for this image, `/db`).
- Do not run cardano-node with `--validate-db` unless you intentionally want full validation.

Clean startup signal to look for: absence of `ChainDB is not clean. Validating all immutable chunks`.
