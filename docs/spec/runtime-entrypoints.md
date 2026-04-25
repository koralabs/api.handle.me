# Runtime Entrypoints

## Purpose
This repo ships the same API/indexing system in three operational shapes:
- local Node.js development
- container runtime
- AWS Lambda entrypoints

This document maps the code entrypoints, what they start, and which environment variables affect them.

## Deployment Ownership
- This repo is not the deployment control plane for `api.handle.me`.
- The ecosystem-level deployment source of truth lives in the sibling repo `../adahandle-deployments`.
- `api.handle.me` deploys from `adahandle-deployments`, including the complementary Docker Hub deployment `handles-public-api`.
- Treat the files in this repo as runtime/build inputs; shipping changes may require coordinated updates in `adahandle-deployments`.

## Local Development

### API Process
- `npm run api` starts `express.ts`, which hydrates KMS-backed env and loads `express.app.ts`.
- `express.app.ts` creates `App` from `app.ts` and calls `listen()`.
- `app.ts` initializes middleware, dynamically loads routes/middlewares/IoC registries, serves Swagger, then starts Ogmios scanning unless `ENABLE_OGMIOS_SCANNING=false`.

### Chain Services
- `npm run ogmios` runs `shell/start_local.sh`.
- The script sources `.env`, downloads network config files into `./tmp/<network>`, installs or reuses local `cardano-node` and `ogmios` binaries under `./tmp`, reuses an existing node/socket when possible, and starts `cardano-node` + Ogmios for local development.
- The same script expects local Valkey access on `REDIS_HOST` / `REDIS_PORT` and installs/enables `valkey-server` when needed. In normal local development that means the app uses the default Valkey port `6379`.

### Read-only Local Mode
- `npm run readonly` starts the API on port `3142` with `ENABLE_OGMIOS_SCANNING=false` and `USE_LAMBDA_SCANNER=false`.
- This is useful when you want to inspect already-indexed data without starting the live scanner in-process.

### Local Lambda Scanner Loop
- In development or test, setting `ENABLE_OGMIOS_SCANNING=false` and `USE_LAMBDA_SCANNER=true` makes `app.ts` invoke `lambdas/scanner.ts` immediately and then every 60 seconds.
- This is only a local/dev execution mode. The scanner still owns synchronous block application semantics.

### API-based Snapshot Bootstrap
- `npm run bootstrap:apis` runs `scripts/bootstrap-from-apis.ts`, which rebuilds a full verified handle-set snapshot from Koios + Blockfrost REST calls instead of walking chain history through Ogmios.
- Replaces the ~20-hour Ogmios bootstrap path with a ~30–45 minute API bootstrap. Produces the same `VerifiedHandleFileContent` shape used by `tryPopulateFromS3UTxOs`, including `slot`, `hash`, `utxos`, `mintingData`, `utxoSchemaVersion`, and chain-verified `verification` metadata whose `verifiedAgainstChain` flag must be true before the snapshot is usable.
- Output: writes both `<SNAPSHOT_OUT>` (zlib-deflated `.gz`) and the sibling raw `.json` file. Defaults to `tmp/handles_utxos.gz`; set `SNAPSHOT_OUT` to override.
- Network selection: `NETWORK` (defaults to `preview`).
- Required credentials: `KOIOS_API_BEARER_TOKEN` and `BLOCKFROST_API_KEY` (both must be present or the script exits immediately).
- Optional secondary credentials for parallel fetch pools: `KOIOS_API_BEARER_TOKEN_LOW`, `BLOCKFROST_API_KEY_LOW`. When set, the script spreads asset-UTxO and tx-info work across the primary/secondary pool pair for throughput.
- RPS tuning (defaults in parentheses): `KOIOS_HIGH_RPS` (8), `KOIOS_LOW_RPS` (3), `BF_HIGH_RPS` (10), `BF_LOW_RPS` (10). Lower these if you hit provider rate limits.
- Debug knobs: `PHASE4=0` skips the tx-info enrichment phase; `PHASE4_MAX_ITEMS=<N>` caps the number of tx-info entries fetched (useful for quick local smoke tests).
- Verification: the script computes the MPT root from the collected handle set and compares it against the live on-chain `handle_root@handle_settings` datum before writing the snapshot. `verification.verifiedAgainstChain=false` means the computed set did not match chain and the snapshot should NOT be uploaded for the indexer to consume.
- The resulting `.gz` can be uploaded to `s3://api.handle.me/<network>/utxo-snapshot/<utxoSchemaVersion>/handles_utxos.gz` so the scanner Lambda's `tryPopulateFromS3UTxOs` picks it up on next cold start or reset.

## Container Runtime
- `Dockerfile` installs the runtime into `/app` and uses `shell/entrypoint.sh` as the container entrypoint.
- `shell/install.sh` installs `cardano-node`, Ogmios, Node.js, Valkey, and network config files during image build.
- `shell/entrypoint.sh` supports these `MODE` values:
  - `api-only`: API only
  - `ogmios`: Ogmios only
  - `cardano-node`: cardano-node only
  - `both`: cardano-node + Ogmios
  - `all`: cardano-node + Ogmios + API
- In container API mode, the script rewrites the packaged `swagger.yml` server URL to `http://localhost:3141` before starting `node express.js`.
- If `NODE_DB` is empty and `DISABLE_NODE_SNAPSHOT=false`, the entrypoint downloads a Mithril cardano-node snapshot before starting the node.

## Lambda Runtime

### API Lambda
- `lambdas/api.ts` hydrates KMS environment variables, then loads `lambdas/api.app.ts`.
- `lambdas/api.app.ts` forces `ENABLE_OGMIOS_SCANNING=false` and serves the Express API through `@vendia/serverless-express`.
- This Lambda serves API traffic only. It does not run the Ogmios WebSocket scanner.

### Scanner Lambda
- `lambdas/scanner.ts` hydrates env and delegates to `lambdas/scanner.app.ts`.
- The scanner Lambda owns:
  - chain catch-up scanning
  - rollback checks and replay
  - reindex/recovery checks
  - lease locking and recovery flags in Valkey
- Function URL reindex shortcut:
  - accepted paths: `/reindex` or `/scanner/reindex`
  - also accepts `reindex=true` in query/body
  - requires a whitelisted `api-key` from `WHITELISTED_API_KEYS`

### Snapshot Lambda
- `lambdas/snapshot.ts` delegates to `lambdas/snapshot.app.ts`.
- Snapshot generation forces `ENABLE_OGMIOS_SCANNING=false`, waits for active lambda locks to clear, reads indexed UTxOs + mint data from Valkey, builds chain-verification metadata, uploads the compressed snapshot to the fixed startup key in S3, archives a timestamped copy, and deletes archived snapshots older than 5 days.
- Snapshot payloads also include the `scanned_blocks` ledger filtered to `<= lastSlot` so the scanner's rollback-check drift detection is accurate immediately after an S3 reimport. See [index-model.md](./index-model.md#snapshot-and-schema-behavior) for the full snapshot/reimport flow.

### Valkey Utility Lambda
- The `valkey-utility` Lambda is ad hoc operational tooling deployed directly via `aws lambda update-function-code`. Its source is NOT part of this repo.
- See `docs/spec/scanner-recovery-runbook.md` for usage instructions.

## Packaging Notes
- `rollup.lambda.config.js` builds the Lambda bundle into `dist/`.
- The build includes Lambda entrypoints plus dynamically loaded routes, middlewares, IoC registries, and workers so the serverless API runtime can boot without relying on the source tree layout.

## Related Docs
- [API/Scanner Spec](./spec.md)
- [Index and Data Model](./index-model.md)
- [Environment Variable Glossary](../../site.env)
