# Handles Public API Spec

## Domain Terminology
- Handle: a “root” ADA Handle (example: `$alice`) minted as a Cardano native asset/NFT.
- Root Handle: a handle that can own/manage SubHandles (examples in Catalyst use `acme` as a root for `treasury@acme`).
- SubHandle: a child identifier under a root handle (example: `treasury@acme`).
- Handle types (as exposed by this API and swagger enums):
  - `handle`: a root handle
  - `nft_subhandle`: a SubHandle represented as a native asset/NFT
  - `virtual_subhandle`: a SubHandle represented via datum + (typically) IPFS-hosted JSON and controlled by contracts
- Personalization: additional profile-style metadata associated with a handle (often through pointer records and IPFS JSON datasets).
- UTxO: the unspent output currently holding a handle/relevant reference token; used to derive current ownership and associated datums.

For external product context and Catalyst milestones, see `docs/product/ecosystem.md`.

## Standards & Encoding Notes (External)
- Handle encoding and “datum-bearing NFT” patterns reference Cardano CIPs such as:
  - CIP-67 (asset name labels; label `222` example -> hex prefix `000de140`): `https://cips.cardano.org/cip/CIP-0067`
  - CIP-68 (datum metadata standard): `https://cips.cardano.org/cip/CIP-0068`
- This repo intentionally tries to hide some of that complexity behind HTTP endpoints. For example, `GET /handles/:handle` supports `?hex=true` when the `:handle` path segment is provided in hex form.

## Runtime Architecture
- `app.ts` bootstraps Express, dynamic middleware/routes/IoC loading, and Swagger UI.
- Routes/controllers provide read APIs over `HandlesRepository`.
- `HandlesRepository` reads/writes indexed state in `RedisHandlesStore`.
- Detailed index model and invariants are captured in `docs/spec/index-model.md`.
- API responses are compressed with Express `compression` middleware when clients send supported `Accept-Encoding` headers (for example `br` or `gzip`).
- Scanning mode:
  - Default: Ogmios WebSocket scanner (`services/ogmios/ogmios.service.ts`)
  - Optional local fallback in dev/test: scanner lambda loop (`USE_LAMBDA_SCANNER=true`)
- Lambda mode (`lambdas/api.ts`) forces `ENABLE_OGMIOS_SCANNING=false` and serves API only.

## Data Freshness Contract
- API returns `200` when store is caught up.
- API returns `202` when store is behind chain tip.
- `/health` may return:
  - `200` when current
  - `202` when storage or ogmios is behind
  - `503` when cardano-node connectivity is unavailable

## Feature-to-Endpoint Mapping
- Handle resolution and ownership views:
  - `GET /handles/:handle` (supports `?hex=true`)
  - `GET /handles/:handle/utxo`
  - `GET /holders` and `GET /holders/:address`
- Catalog search and filtering:
  - `GET /handles` and `POST /handles/list` (batch reverse-lookup)
  - `GET /root-handles` (root handle inventory; includes `minting_type` filtering)
- Personalization:
  - `GET /handles/:handle/personalized`
  - `GET /handles/:handle/personalized/utxo` (reference token UTxO)
- SubHandles:
  - `GET /handles/:handle/subhandle-settings` (+ UTxO view)
  - `GET /handles/:handle/subhandles` (supports `?type=virtual|nft`)
  - `POST /mint` relay for SubHandle minting workflows (not a general mint endpoint)
- Network scripts and datum utilities:
  - `GET /scripts`
  - `POST /tx/evaluate`
  - `POST /datum` (feature-flagged via `ENABLE_DATUM_ENDPOINT`)
- Operations:
  - `GET /health`, `GET /stats`, `GET /deployment`, `GET /` (redirects to `/swagger`)

## Route Inventory

### Core
- `GET /` redirect to Swagger UI (`/swagger`)
- `GET /health` sync status + stats (+ `ogmios` when Ogmios scanning is enabled)
- `GET /stats` total handles/holders
- `GET /deployment` `deployment_info.json`

### Handles
- `GET /handles` filter/search/paginate handle catalog
- `POST /handles/list` batch lookup/reverse-lookup by filter type
- `GET /handles/:handle` handle details (supports `?hex=true`)
- `GET /handles/:handle/utxo` UTxO payload for current handle location
- `GET /handles/:handle/personalized` personalization payload
- `GET /handles/:handle/personalized/utxo` reference token UTxO
- `GET /handles/:handle/subhandle-settings` subhandle settings
- `GET /handles/:handle/subhandle-settings/utxo` subhandle settings UTxO
- `GET /handles/:handle/subhandles` list child subhandles (`?type=virtual|nft`)

### Handles Deprecated Aliases (still routed)
- `GET /handles/:handle/subhandle_settings`
- `GET /handles/:handle/subhandle_settings/utxo`
- `GET /handles/:handle/reference_token`
- `GET /handles/:handle/datum` (gated by `ENABLE_DATUM_ENDPOINT=true`)
- `GET /handles/:handle/script`

### Holder & Root Handle Views
- `GET /holders` (summary list; does not include per-holder `handles` arrays)
- `GET /holders/:address`
- `GET /root-handles` (supports handle search filters and `minting_type` filter)
- `GET /holders` defaults to `sort=desc` by `total_handles` (highest holder counts first); `sort=asc` returns smallest holder counts first.

### Utility & Internal
- `POST /datum` CBOR/JSON encode/decode utility
- `POST /tx/evaluate` Ogmios-backed transaction evaluation that returns Mesh-compatible redeemer budgets and contract-response errors for builder flows
- `GET /scripts` network script catalog (`latest`, `type` query support)
  - script entries are resolved from canonical `<slug><ordinal>@handlecontract` subhandles
  - the `type` query parameter now prefers canonical slugs such as `pers`, `mkpl`, `demimntprx`, and `halmntprx`
  - deprecated legacy aliases such as `pz_contract`, `marketplace_contract`, `demi_mint_proxy`, and `hal_mint_proxy` are still accepted during the migration window
  - response payload `type` values use the canonical slugs such as `pers`, `mkpl`, `demimnt`, and `halmntprx`
  - response keys are validator-hash-derived script addresses, while `refScriptAddress` points to the handle-held reference script UTxO address
  - `unoptimizedCbor`, when present, is loaded from the owning contract repo at `deploy/<network>/<slug>.unoptimized.cbor`
- `POST /mint` relay for subhandle minting service (currently rejects `handle_type=handle`)

## Contract Slug Naming
`api.handle.me` follows the shared contract slug naming rule defined in `adahandle-deployments/docs/contract-deployment-pipeline.md`.

Canonical slug shape:

```text
<app><[ord|mnt|ref|roy]><[mpt]>
```

Rules:
- `app` is a 3 or 4 letter repo, project, or app abbreviation.
- `ord`, `mnt`, `ref`, and `roy` identify order, minting, reference, and royalty contract families.
- spend is implied when omitted.
- `mpt` marks the Merkle Patricia Trie root managing contract.
- canonical `contract_slug`, `script_type`, and `deployment_handle_slug` values must match.
- canonical slugs must be 10 characters or fewer and must not contain `-` or `_`.

API transition rule:
- canonical slug naming is the long-term source of truth for new deployment handles and new repo-owned contract identifiers.
- `/scripts` `type=` query values now prefer canonical slugs such as `mkpl`, `demimntprx`, and `halmntprx`.
- `/scripts` still accepts legacy query aliases such as `marketplace_contract`, `demi_mint_proxy`, and `hal_mint_proxy` during the migration window.
- handle-backed discovery maps new ordinalized `*.handlecontract` names and repo-owned `deploy/<network>/<slug>.unoptimized.cbor` artifacts onto canonical slug response `type` values while still accepting legacy query aliases during migration.

## Search and Pagination Behavior
- Handles endpoints support:
  - `search`, `characters`, `length`, `rarity`, `numeric_modifiers`, `og`, `personalized`, `handle_type`, `holder_address`, `root_handle`
  - `root_handle` limits results to subhandles indexed under that exact root handle and composes with the other filters above
  - pagination via `records_per_page` + `page` OR `slot_number`
  - `records_per_page` maximum is `250` for `application/json` and `50000` for `text/plain` on `/handles` and `/handles/list`
  - default page size is `100` for `application/json` and `50000` for `text/plain`
- Content negotiation:
  - `Accept: text/plain` returns newline-delimited handle names and supports pagination
  - `Accept: application/json` returns JSON objects

## Rate Limiting and API Keys
- The app can optionally enable a request rate limiter via `RATE_LIMITER_ENABLED=true`.
- When enabled, default policy is `5` requests per `1000ms`.
- Requests with an `api-key` header present in `WHITELISTED_API_KEYS` bypass the limiter.
- This is not authentication; the API does not require an `api-key` for access by default.

## Scanner and Rollback
- Ogmios scanner processes each block transaction synchronously, updating UTxOs and indexes in order.
- Before any per-UTxO handle updates, scanners normalize and preload minting data for the full block/scan batch so Handle (`222`) and Virtual SubHandle (`000`) mint records are available regardless of tx/output ordering.
- Minting data is persisted once per batch and then reused during per-UTxO updates to avoid duplicate mint writes while keeping the same ordering guarantees.
- Missing minting data during handle index updates is treated as a hard failure (scanner invariant), not a soft fallback.
- Scanner lambda now also owns rollback/reconciliation and reindex checks.
- Scanner lambda acquires an expiring Valkey lease lock (`SET NX PX`) per invocation and refreshes it with a heartbeat during execution; competing invocations skip work while a valid lease is held.
- Scanner lambda also uses a recovery flag for destructive phases (`rollback` / `reindex`). If a run terminates mid-phase, the next cron tick detects the flag and runs index repair before normal scan/rollback flow.
- Rollback reconciliation runs in short and periodic long windows and remains intentionally two-phase:
  first persist replayed UTxOs + mint history without index updates, then run index updates from provider `tx_info`.
- Rollback cutoff is computed from the first divergent block (provider/API mismatch) within the checked window, and cleanup/replay is applied from that block forward (not from the beginning of the window).
- Rollback lock behavior is fail-safe: rollback attempts always clear `lockLambdas` in a `finally` path so scanner cron loops do not deadlock after provider/API failures.
- Stale scanner locks (`lockLambdas` with aged timestamps) are treated as recoverable: stale locks are cleared and recovery flags are set for rollback/reindex lock reasons.
- Snapshot lambda takes and releases a dedicated `lockLambdas` reason (`SNAPSHOT`) in `try/finally`, and scanner treats stale snapshot locks as recoverable.
- Snapshot lambda rechecks active lambda locks up to 4 times with a 15-second delay before skipping a run.
- Reindex lock behavior is fail-safe: reindex attempts must always clear `lockLambdas` in both success and error paths to avoid deadlocking scanner flows.
- Scanner block processing batches `tx_info` across the full discovered block window (subject to request-size batching), then groups transactions back by `block_hash` to preserve per-block synchronous application order.
- Scanner starts `tx_info` and `block_txs` requests with a 3000-byte soft body target per batch to reduce provider-side timeout and 5xx rates.
- Even with batched `tx_info`, scanner metrics (`currentBlockHash`, `currentSlot`) are advanced block-by-block in processing order so restart/resume points stay deterministic.
- Scanner `tx_info` requests use adaptive resiliency: retriable transport/provider failures are retried with short backoff, then failing batches are split recursively to smaller `_tx_hashes` groups before failing hard.
- Koios `tx_info` transient provider pool saturation responses (for example `PGRST003` connection-pool timeouts) are treated as retriable in the same retry/split flow.
- Scanner paces Koios batch calls (`tx_info`, `block_txs`, `asset_utxos`) to stay under 6 requests/second while still using request-size batching.
- `block_txs` and `asset_utxos` calls use retry+backoff on transient provider failures (including HTTP 429) before failing hard.
- On handled Koios retry/split failures, scanner emits local `INFO` logs with batch sizing/hash context and a token-redacted curl template to reproduce request bodies for provider debugging.
- Scanner lambda supports a function-url reindex shortcut (`/reindex` path, `reindex=true` query, or JSON body `{"reindex": true}`) and requires a whitelisted `api-key` from `WHITELISTED_API_KEYS`.
- Burn processing in scanner is idempotent: missing/previously-removed burn handles are ignored so replaying the same block does not fail.
- Valkey pipeline execution must always clear pipeline state on errors; queue state is reset even when pipeline callbacks throw.

## Environment Variables
See `site.env` for the operator-facing glossary. Commonly used ones include:
- `NETWORK`, `OGMIOS_HOST`
- `ENABLE_OGMIOS_SCANNING`, `USE_LAMBDA_SCANNER`
- `ENABLE_DATUM_ENDPOINT`
- `RATE_LIMITER_ENABLED`, `WHITELISTED_API_KEYS`
- `IPFS_GATEWAY`, `IPFS_GATEWAY_BACKUP`, `PINATA_GATEWAY_TOKEN`

## Swagger Coverage Requirements
- `docs/swagger.yml` must document all active and deprecated externally callable routes.
- Obsolete undocumented paths should be removed or explicitly marked `deprecated`.

## Note: Swagger File Location
`app.ts` serves Swagger UI from a `./swagger.yml` file path at runtime. This repo maintains the OpenAPI spec at `docs/swagger.yml`; deployments should ensure the runtime file is present/packaged appropriately.
