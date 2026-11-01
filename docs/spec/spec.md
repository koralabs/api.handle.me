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
- `HandlesRepository` reads/writes indexed state in `RedisHandlesStore` (Valkey-backed).
- Detailed index model and invariants are captured in `docs/spec/index-model.md`.
- API responses are compressed with Express `compression` middleware when clients send supported `Accept-Encoding` headers (for example `br` or `gzip`).
- Runtime entrypoint details for local Node, container, and Lambda modes are captured in `docs/spec/runtime-entrypoints.md`.
- Scanning mode:
  - Local/container default: Ogmios WebSocket scanner (`services/ogmios/ogmios.service.ts`).
  - Scheduled scanner default: the legacy Blockfrost/Maestro/Koios path.
  - Scheduled scanner opt-in: Demeter UTxORPC `ReadTip` + policy-filtered `WatchTx` when `SCANNER_CHAIN_SOURCE=demeter`.
  - Optional local fallback in dev/test: scanner lambda loop (`USE_LAMBDA_SCANNER=true`).
- Function mode (`lambdas/api.ts`) forces `ENABLE_OGMIOS_SCANNING=false` and serves API only; the scanner is a separate box worker.

## Data Freshness Contract
- API returns `200` when store is caught up.
- API returns `202` when store is behind chain tip or the service is in an updating state.
- `/health` may return:
  - `200` when current
  - `202` when storage is behind, Ogmios is behind, or scanner maintenance is actively updating state
  - `503` when cardano-node connectivity is unavailable
- `/health` status values currently include:
  - `current`
  - `storage_behind`
  - `ogmios_behind`
  - `updating`
  - `waiting_on_cardano_node`

## Feature-to-Endpoint Mapping
- Handle resolution and ownership views:
  - `GET /handles/:handle` (supports `?hex=true`)
  - `GET /handles/:handle/utxo`
  - `GET /holders` and `GET /holders/:address`
- Catalog search and filtering:
  - `GET /handles` and `POST /handles/list` (batch reverse-lookup)
  - `GET /root-handles` (root handle inventory; includes `minting_type` filtering)
- Marketplace listings:
  - `GET /marketplace/listings` (optional `holder_address` and `search`)
- Personalization:
  - `GET /handles/:handle/personalized`
  - `GET /handles/:handle/personalized/utxo` (reference token UTxO)
- SubHandles:
  - `GET /handles/:handle/subhandle-settings` (+ UTxO view)
  - `GET /handles/:handle/subhandles` (supports `?type=virtual|nft`)
  - `POST /mint` relay for SubHandle minting workflows (not a general mint endpoint)
- Network scripts and datum utilities:
  - `GET /scripts`
  - `POST /datum`
  - `GET /policies`
  - deprecated `GET /handles/:handle/datum` remains feature-gated by `ENABLE_DATUM_ENDPOINT`
- MCP surface:
  - `POST /mcp`
  - `GET /mcp` transport-status response (`405` while SSE transport is disabled)
- Operations:
  - `GET /health`, `GET /stats`, `GET /deployment`, `GET /mpt-root`, `GET /`, `GET /swagger`, `GET /swagger/swagger.yml`

## Route Inventory

### Core
- `GET /` redirect to Swagger UI (`/swagger`)
- `GET /health` sync status + stats (+ `ogmios` when Ogmios scanning is enabled)
- `GET /stats` total handles/holders
- `GET /deployment` `deployment_info.json`
- `GET /swagger` Swagger UI
- `GET /swagger/swagger.yml` raw OpenAPI document

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
- `GET /mpt-root` compares the API's computed Merkle Patricia Trie root hash against the on-chain root from the `handle_root@handle_settings` datum; returns `verified: true` when they match
- `POST /datum` CBOR/JSON encode/decode utility
- `GET /policies` normalized handle policy settings derived from `handle_policies`
- `GET /scripts` network script catalog
  - lists every `<slug><ordinal>@handlecontract` subhandle that has inline script CBOR — no curated family allow-list
  - response keys are validator-hash-derived script addresses; `refScriptAddress` points to the handle-held reference script UTxO address
  - response `type` is the family slug (the slug minus its trailing digits): `pers1@handlecontract` → `pers`, `persprx1@handlecontract` → `persprx`
  - `?type=X` is a case-insensitive `startsWith` match on the slug — `type=pers` returns every family beginning with `pers`; `type=persprx` returns only `persprx<n>`
  - `?latest=true` filters to entries marked `latest: true` (highest ordinal per family that has script CBOR); combine with `?type=X` to scope to specific families
  - latest entries are emitted first so JSON-iteration order surfaces the active deployments up front
- `POST /mcp` Model Context Protocol JSON-RPC endpoint with read-only tools:
  - `get_handle`
  - `get_handle_utxo`
  - `search_handles`
  - `get_holder`
  - `list_holders`
  - `get_policies`
  - `get_stats`
- `GET /mcp` returns `405` with an SSE-disabled message; streamable HTTP GET transport is not enabled
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
- canonical slug naming is the source of truth for deployment handles and repo-owned contract identifiers.
- `/scripts` accepts any string for `type=` — legacy aliases like `marketplace_contract` no longer match because there is no alias map. Use the canonical slug (e.g. `mkpl`).

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

## Runtime Entrypoints
- Local API bootstrap: `express.ts` -> `express.app.ts` -> `app.ts`
- Local chain bootstrap: `shell/start_local.sh` (`npm run ogmios`)
- Container bootstrap: `shell/entrypoint.sh`
- Lambda entrypoints:
  - `lambdas/api.ts`
  - `lambdas/scanner.ts`
  - `lambdas/snapshot.ts`
- Deployment orchestration for `api.handle.me` is handled from the sibling repo `../adahandle-deployments`, not from this repo.
- See `docs/spec/runtime-entrypoints.md` for exact mode behavior and packaging notes.

## Scanner and Rollback
- Ogmios and scheduled scanners process each block transaction synchronously, updating UTxOs and indexes in order.
- Demeter mode uses one `ReadTip` boundary and a server-side `WatchTx` predicate containing both Handle policies. `movesAsset` matches resolved inputs, outputs, and mint/burn activity, so transfers away from tracked outputs and pure burns are not omitted.
- `WatchTx` emits one event per matching transaction but no explicit end-of-block event for matching blocks. The scanner therefore buffers a block until the first event from the following block. It deliberately stops before the `ReadTip` boundary, leaving at most one complete block for the next invocation rather than committing a possibly partial tip block.
- Every streamed block is represented: a matching block has `apply` events and a non-matching block has `idle`. Block heights must be contiguous; duplicate events are deduplicated, while a gap, conflicting tip hash, missing field, unsupported script language, invalid intersection, or provider error halts without fallback or cursor advancement.
- Failed transactions are discarded. Successful transactions preserve stream order, resolved spent-input references, datum CBOR, metadata label 721, and Plutus V1/V2/V3 reference-script types before entering the existing repository mutation path.
- A `WatchTx` `undo` never reverses repository mutations directly. It halts streaming and invokes the existing canonical rollback reconciliation with the full 2,160-block protocol window. Snapshot reimport remains the recovery path when the persisted intersection is unavailable.
- Before any per-UTxO handle updates, scanners normalize and preload minting data for the full block/scan batch so Handle (`222`) and Virtual SubHandle (`000`) mint records are available regardless of tx/output ordering.
- Minting data is persisted once per batch and then reused during per-UTxO updates to avoid duplicate mint writes while keeping the same ordering guarantees.
- Missing minting data during handle index updates is treated as a hard failure (scanner invariant), not a soft fallback.
- Scanner lambda now also owns rollback/reconciliation and reindex checks.
- Scanner lambda acquires an expiring Valkey lease lock (`SET NX PX`) per invocation and refreshes it with a heartbeat during execution; competing invocations skip work while a valid lease is held. Lease renew and release are compare-and-set via a Lua `EVAL` script (`customCommand`), so a stale owner cannot extend or delete a lease that has been reacquired by another invocation between the GET and the PEXPIRE/DEL.
- Scanner lambda also uses a recovery flag for destructive phases (`reindex`). If a run terminates mid-reindex, the next cron tick detects the flag and runs index repair before normal scan/rollback flow. Stale `ROLLBACK` and `SCANNING` locks are cleared without setting a recovery flag.
- Rollback uses a delta-based drift detection algorithm. Canonical block metadata (hashes, slots) is fetched from Blockfrost over a `rollbackOffset`-deep window (default 20 blocks for the periodic check — see below). Stored Handle UTxOs whose `blockHash` is not in the canonical hash set are orphaned. Drift candidates — handles whose stored state may have fallen behind canonical even though no orphan was detected — are computed as the delta between canonical blocks in the window and the scanner's `scanned_blocks` ZSET (the authoritative record of blocks the scanner has fully processed, including handle-free blocks). Handles mentioned in `tx_info` for canonical blocks missing from `scanned_blocks` join the candidate set. Only the resulting candidate set is queried via `asset_utxos`; broad per-window handle enumeration (the prior behavior that blew out the 12-minute scanner deadline on mainnet when ~2000 window-stored handles produced ~1888 `asset_utxos` hits in a tight loop) is gone. For repair-needing handles, current on-chain state is fetched via `asset_utxos` + `tx_info` and repair is applied inline (remove orphaned UTxOs, add canonical ones, rebuild minting data/holders/indexes). A single `LockedLambdaReason.ROLLBACK` lock reason is used.
- `rollbackOffset` default is 20 blocks for the periodic rollback check called at the end of `scan()`. Cardano's protocol rollback limit of 2160 blocks (`k`) is a theoretical ceiling — the deepest observed real rollback is a few blocks, and the scanner/API cannot meaningfully recover from anything beyond ~20 blocks without a full S3 reimport. Scanning the full 2160-block canonical window on every periodic check cost tens of seconds per invocation for no real benefit. The stale-head recovery path in `scan()` (when `blocks/{currentBlockHash}/next` returns empty and chain tip is ahead) still calls `processRollback` with `rollbackOffset: 2160` explicitly, because the canonical predecessor of an orphaned head may legitimately be further back than 20 blocks after a scanner outage.
- Rollback and drift-repair call `updateHandleIndexes(..., { suppressDoubleMintDetection: true })`. During repair the stored UTxO pointer is known-stale relative to the canonical one — that is literally why repair is running — so the ordinary double-mint branch would fire on every repair cycle, bumping `handle.amount` and eventually defeating `removeHandle`'s burn threshold. The normal forward-scan path does NOT set this flag, so real on-chain double-mints are still detected.
- Rollback lock behavior is fail-safe: rollback attempts always clear `lockLambdas` in a `finally` path so scanner cron loops do not deadlock after provider/API failures.
- Snapshot lambda takes and releases a dedicated `lockLambdas` reason (`SNAPSHOT`) in `try/finally`, and scanner treats stale snapshot locks as recoverable.
- Snapshot lambda rechecks active lambda locks up to 4 times with a 15-second delay before skipping a run.
- Reindex lock behavior is fail-safe: reindex attempts must always clear `lockLambdas` in both success and error paths to avoid deadlocking scanner flows.
- Scanner block processing batches `tx_info` across the full discovered block window (subject to request-size batching), then groups transactions back by `block_hash` to preserve per-block synchronous application order.
- A single 12-minute hard deadline (`ScannerDeadlineError`) governs all scanner code paths: scan chunks, Koios retries, and rollback processing. When the deadline fires, the current operation exits cleanly and the next invocation resumes from the last saved block.
- Scanner keeps `block_txs` request-size batching, and `tx_info` caps batches at 35 hashes. Scanner `tx_info` requests include `_scripts: true` and `_bytecode: true` to index reference scripts.
- When Koios calls fail after retries, each scan/rollback iteration falls back to Blockfrost individual-request endpoints (~9 RPS). Blockfrost requests have a 20-second `AbortSignal` timeout. Fallback failures for reference scripts and metadata are logged as NOTIFY.
- Even with batched `tx_info`, scanner metrics (`currentBlockHash`, `currentSlot`) are advanced block-by-block in processing order so restart/resume points stay deterministic.
- Scanner `tx_info` requests use adaptive resiliency: retriable transport/provider failures are retried with short backoff, then failing batches are split recursively to smaller `_tx_hashes` groups before falling back to Blockfrost.
- Koios `tx_info` transient provider pool saturation responses (for example `PGRST003` connection-pool timeouts) are treated as retriable in the same retry/split flow.
- Scanner paces Koios batch calls (`tx_info`, `block_txs`, `asset_utxos`) to stay under 6 requests/second while still using request-size batching.
- Every `utils/helpers.ts::fetchKoios` caller shares the process-lifetime provider deadline in `utils/koiosRateLimit.ts`, separate from the next pacing start. Header registration runs in a reaction attached directly to the HTTP fetch promise, before the async admission wrapper produces its result or the helper reads `response.text()`; body `retry_after` and Google `RetryInfo.retryDelay` are registered when parsed. The maximum of numeric/fractional or HTTP-date `Retry-After`, reset-after/standard reset hints and exhausted `X-RateLimit-Remaining: 0` + reset wins; shorter/zero/past signals cannot shorten an existing hold. Success headers count too. Finite numeric header text is classified as a duration/reset number before date parsing; negative values are invalid and must not fall through to JavaScript's permissive year parser or change an existing valid hold. Valid fractional waits and HTTP dates remain supported. Error diagnostics still expose `retryAfterMs`, but a local retry decision is no longer the writer of provider state.
- Shared admission re-reads the hold and pacing after every wake. Scanner passes its deadline callback and start interval into the helper; it checks the earliest proposed start before sleeping, then synchronously checks/claims immediately before actual fetch without an intervening await. A known hold beyond the work budget ends the invocation without shortening the provider floor. Owned retry/pacing waits and every Blockfrost fallback request use that callback too; typed budget failures cannot become fresh fallback HTTP or partial success. Prefetch stops queued batches on failure and drains already-started reads before cleanup; a paused scan returns before optional post-scan network work. Split children, final-retry failures, tip, pagination, datum/asset and non-scanner helper callers therefore observe the same hold while in-flight requests remain concurrent. No new retry/fallback, provider probe, environment variable or public endpoint contract is introduced.
- `block_txs` and `asset_utxos` calls use retry+backoff on transient provider failures (including HTTP 429) before failing hard.
- On handled Koios retry/split failures, scanner emits local `INFO` logs with batch sizing/hash context and a token-redacted curl template to reproduce request bodies for provider debugging.
- Scanner lambda supports a function-url reindex shortcut (`/reindex` path, `reindex=true` query, or JSON body `{"reindex": true}`) and requires a whitelisted `api-key` from `WHITELISTED_API_KEYS`. Reindex and repair shortcuts must acquire the scanner lease like any other writer; if the lease is held by an active scan, the shortcut returns HTTP `409 Conflict` and the operator retries after the 60s lease TTL. This prevents shortcut paths from racing with a live cron scan on the same Valkey keys.
- Burn processing reads negative quantities directly from each transaction's mint field rather than deriving burns from surviving tracked outputs. Pure burns are therefore applied even when the transaction creates no Handle-policy output. Processing remains idempotent: missing/previously-removed burn handles are ignored so replaying the same block does not fail.
- Valkey pipeline execution must always clear pipeline state on errors; queue state is reset even when pipeline callbacks throw. Reentrant `pipeline()` calls throw `RedisHandlesStore.pipeline() called while another pipeline is already active` — the prior behavior silently reset the outer queue, dropping its commands without a signal.
- `IndexNames.MINT` SADD members are canonically stringified (`utils/helpers.ts` `canonicalJsonStringify`) so block replay after a mid-block crash produces byte-identical members and SADD deduplicates correctly. Scanner replay safety depends on this — especially when the fallback path routes through Blockfrost metadata whose field ordering may differ from Koios.
- Scanner `scan()` rebuilds and persists `mpt_root_hash` in a `finally` block, guarded by `endingCurrentSlot !== startingCurrentSlot`. Any exit path that advanced `currentSlot` (including `ScannerDeadlineError`, retriable Koios, rethrown errors) refreshes the stored root before unlocking. Failures in the rebuild itself are logged and do not block the lambda unlock.
- `LBL_100` (reference token) and `LBL_001` (sub-handle settings token) processing in `updateHandleIndexes` `continue`s to the next asset on a missing inline datum rather than returning from the function. A multi-handle UTxO whose reference token happens to be malformed no longer silently abandons the other handles in that same UTxO.
- `/mpt-root` provider probe (`probeKoiosRootHash`) rejects an empty tip response (`Koios /tip` returning `null` or no array entry) and rejects `tipSlot <= 0`. A degraded provider can no longer masquerade as a valid probe with a zero-slot tip.
- Snapshot-import progress marker is tagged with `utxoSchemaVersion` and `snapshotHash`. An invocation that resumes with a marker whose tags don't match the currently-fetched snapshot deletes the marker, calls `clearNamespace`, and restarts from chunk 0 — so a schema bump or replaced S3 snapshot across invocations can't silently apply stale offsets to new data.

### Blockfrost transport and fallback fidelity

Blockfrost callers share one process-lifetime limiter instance using the same parser/admission implementation as Koios, with independent provider state. Headers register directly at response receipt, body waits at body receipt, and every applicable signal is maxed. Success/exhausted and final-attempt holds bind later callers too. Existing pagination retry counts and pacing remain; no retry/fallback is added, and an unadmittable scanner wait is not retried early.

Fallback reads preserve the original `Response` contract and carry deadline admission through transaction, UTxO, datum, script and metadata requests. Known script bytes require their actual language metadata; lookup errors or missing language cannot become fabricated Plutus V2 or absent-script success. A genuine CBOR lookup 404 retains the established absence result. Transaction metadata failures propagate rather than returning stripped successful data. These are upstream data/transport corrections, not relaxed completeness or root guards.

## Marketplace Listing Read Contract

`GET /marketplace/listings` returns a JSON array of `MarketplaceListingViewModel` records,
matching the marketplace BFF's `MarketAsset[]` contract. Each record includes `assetName`,
`assetNameHex` (full on-chain asset name), `assetLabel` (empty for legacy, CIP-67 label hex
for 222 owner tokens), `policyId`, `utxo` (including raw datum CBOR), `holder`,
`payoutAddress`, `price`, and `slotNumber`. `price` is the sum of datum payouts in lovelace,
excluding marketplace fees; `payoutAddress` is the first payout destination. Results are
sorted by handle name, without pagination, and `X-Total-Count` is the filtered array size.

The dynamically loaded marketplace route/controller reads `HandlesRepository`. Script
metadata is resolved locally from all deployed `mkpl<ordinal>@handlecontract` subhandles
using the same language-tagged validator hash calculation as `/scripts`. Candidate names
come from the payment-key-hash index, because the contract's listing output combines the
marketplace payment validator with the seller's stake credential. Validate each current
UTxO's validator and asset membership; do not trust stale candidate index membership.
Decode inline datums with `marketplaceDatumSchema`, requiring supported constructors,
a 28-byte owner credential, non-empty valid payouts, and safe nonnegative integer prices.
Only legacy or label-222 owner assets are exposed. Malformed/unsupported datums, missing
UTxOs, mismatched assets, and reference tokens are skipped per record. Storage failures
remain request errors. No remote chain queries or unoptimized-CBOR fetches occur.

`holder_address` supports base, enterprise, and stake addresses on the API network;
Byron and pointer addresses are unsupported. Base addresses normalize to their stake
address. Staked listing holders are the output's stake address; non-staked listing holders
are enterprise addresses reconstructed from the datum owner. An enterprise query can also
match the datum owner's payment credential on a staked listing. `search` is a case-insensitive
name substring with at least three characters after trimming. Unknown parameters, repeated
or structured values, empty strings, short searches, invalid addresses, and wrong-network
addresses return `400` with the standard `{error,message,docs}` envelope.

A caught-up store returns `200`, including `[]` when there are no matches or registered
marketplace deployments. Normal indexed-read freshness behavior remains: `202` while
behind and `503` during destructive maintenance. Existing handle, holder, and script APIs
retain their contracts. The marketplace static consumer's `{listings,total}` envelope is
owned by its BFF; aligning that separate consumer mismatch is tracked in marketplace.handle.me.
Deployment orchestration remains in the sibling deployment repository.

## Verification
The NPM Actions producer (`.github/workflows/yarn-pr-tests.yml`) invokes the existing
`npm run test:unit` script, not `npm test`, which also dispatches local e2e tests.
Unit-only workflow dispatch is a structural operator invariant. The local `test` and
`test:e2e` scripts remain available; e2e/browser/user-journey tests never run in Actions.

Local scanner integration tests use an isolated Valkey fixture database on loopback,
never production Redis. Canonical rollback fixtures exercise actual HTTP helpers and
provider conversion behind an HTTP-boundary fake and assert persisted block metrics,
lock release, UTxOs and normalized holder ownership/indexes. A matching canonical block
must not remove or replay valid tracked ownership. Assertions must not pin internal
helper argument counts; admission parameters are not a persisted-state contract.

## Environment Variables
See `site.env` for the operator-facing glossary. Commonly used ones include:
- `NETWORK`, `OGMIOS_HOST`
- `ENABLE_OGMIOS_SCANNING`, `USE_LAMBDA_SCANNER`
- `ENABLE_DATUM_ENDPOINT`
- `RATE_LIMITER_ENABLED`, `WHITELISTED_API_KEYS`
- `IPFS_GATEWAY`, `IPFS_GATEWAY_BACKUP`, `PINATA_GATEWAY_TOKEN`
- `OGMIOS_PORT`, `CARDANO_NODE_PORT`, `CARDANO_DB_PATH`
- `OGMIOS_VER`, `CARDANO_NODE_VER`

## Swagger Coverage Requirements
- `docs/swagger.yml` must document all active and deprecated externally callable routes.
- Obsolete undocumented paths should be removed or explicitly marked `deprecated`.

## Note: Swagger File Location
`app.ts` serves Swagger UI from a `./swagger.yml` file path at runtime. This repo maintains the OpenAPI spec at `docs/swagger.yml`; deployments should ensure the runtime file is present/packaged appropriately.
