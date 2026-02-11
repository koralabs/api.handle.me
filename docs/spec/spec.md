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
- Scanning mode:
  - Default: Ogmios WebSocket scanner (`services/ogmios/ogmios.service.ts`)
  - Optional local fallback in dev/test: lambda scanner/rollback loops (`USE_LAMBDA_SCANNER=true`)
- Lambda mode (`lambdas/api.ts`) forces `READ_ONLY_STORE=true` and serves API only.

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
  - `POST /datum` (feature-flagged via `ENABLE_DATUM_ENDPOINT`)
- Operations:
  - `GET /health`, `GET /stats`, `GET /deployment`, `GET /`

## Route Inventory

### Core
- `GET /` health ping style empty body response
- `GET /health` sync status + ogmios + stats
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
- `GET /holders`
- `GET /holders/:address`
- `GET /root-handles` (supports handle search filters and `minting_type` filter)

### Utility & Internal
- `POST /datum` CBOR/JSON encode/decode utility
- `GET /scripts` network script catalog (`latest`, `type` query support)
- `POST /mint` relay for subhandle minting service (currently rejects `handle_type=handle`)

## Search and Pagination Behavior
- Handles endpoints support:
  - `search`, `characters`, `length`, `rarity`, `numeric_modifiers`, `og`, `personalized`, `handle_type`, `holder_address`
  - pagination via `records_per_page` + `page` OR `slot_number`
- Content negotiation:
  - `Accept: text/plain` returns newline-delimited handle names
  - `Accept: application/json` returns JSON objects

## Rate Limiting and API Keys
- The app can optionally enable a request rate limiter via `RATE_LIMITER_ENABLED=true`.
- When enabled, default policy is `5` requests per `1000ms`.
- Requests with an `api-key` header present in `WHITELISTED_API_KEYS` bypass the limiter.
- This is not authentication; the API does not require an `api-key` for access by default.

## Scanner and Rollback
- Ogmios scanner processes each block transaction synchronously, updating UTxOs and indexes in order.
- Rollback lambda reconciles provider/store gaps over short and periodic long rollback windows.
- Snapshot lambda can emit compressed UTxO snapshots for fast restore.

## Environment Variables
See `site.env` for the operator-facing glossary. Commonly used ones include:
- `NETWORK`, `OGMIOS_HOST`
- `READ_ONLY_STORE`, `USE_LAMBDA_SCANNER`
- `ENABLE_DATUM_ENDPOINT`
- `RATE_LIMITER_ENABLED`, `WHITELISTED_API_KEYS`
- `IPFS_GATEWAY`, `IPFS_GATEWAY_BACKUP`, `PINATA_GATEWAY_TOKEN`

## Swagger Coverage Requirements
- `docs/swagger.yml` must document all active and deprecated externally callable routes.
- Obsolete undocumented paths should be removed or explicitly marked `deprecated`.

## Note: Swagger File Location
`app.ts` serves Swagger UI from a `./swagger.yml` file path at runtime. This repo maintains the OpenAPI spec at `docs/swagger.yml`; deployments should ensure the runtime file is present/packaged appropriately.
