# Runtime Entrypoints

## Purpose
This repo ships the same API/indexing system in three operational shapes:
- local Node.js development
- container runtime
- AWS Lambda entrypoints

This document maps the code entrypoints, what they start, and which environment variables affect them.

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
- Snapshot generation forces `ENABLE_OGMIOS_SCANNING=false`, waits for active lambda locks to clear, reads indexed UTxOs + mint data from Valkey, builds chain-verification metadata, and uploads the compressed snapshot to S3.

### Valkey Utility Lambda Source
- `lambdas/valkeyutility.ts` is an operational helper for copying, renaming, or deleting API cache namespaces across Valkey targets.
- It is repo-documented because operators use it, but the standard Rollup Lambda bundle in `rollup.lambda.config.js` currently bundles `api.ts`, `scanner.ts`, and `snapshot.ts` only.

## Packaging Notes
- `rollup.lambda.config.js` builds the Lambda bundle into `dist/`.
- The build includes Lambda entrypoints plus dynamically loaded routes, middlewares, IoC registries, and workers so the serverless API runtime can boot without relying on the source tree layout.

## Related Docs
- [API/Scanner Spec](./spec.md)
- [Index and Data Model](./index-model.md)
- [Environment Variable Glossary](../../site.env)
