# Handles Public API Feature Matrix

## Purpose
This matrix links shipped feature areas to their externally visible endpoints and the runtime paths that own behavior.

## Feature Coverage

| Feature Area | Primary Endpoints | Core Runtime Paths | User Outcome |
| --- | --- | --- | --- |
| Handle lookup and catalog search | `GET /handles`, `POST /handles/list`, `GET /handles/:handle`, `GET /handles/:handle/utxo` | `routes/handles.route.ts`, `controllers/handles.controller.ts`, `repositories/handlesRepository.ts` | Wallets/dApps can resolve handle records, ownership, and UTxO details with filtering and pagination. |
| Holder and root-handle views | `GET /holders`, `GET /holders/:address`, `GET /root-handles` | `routes/holders.route.ts`, `routes/rootHandles.route.ts`, `controllers/holders.controller.ts`, `controllers/rootHandles.controller.ts` | Integrators can map addresses to handle sets and derive root-handle inventory. |
| Personalization and subhandle data | `GET /handles/:handle/personalized`, `GET /handles/:handle/subhandle-settings`, `GET /handles/:handle/subhandles` | `repositories/handlesRepository.ts`, `utils/ipfs/*`, `controllers/handles.controller.ts` | Clients can render profile metadata and subhandle state from indexed chain data. |
| Script, datum, and policy utilities | `GET /scripts`, `POST /datum`, `GET /policies` | `routes/policies.route.ts`, `controllers/scripts.controller.ts`, `controllers/datum.controller.ts`, `controllers/policies.controller.ts`, `services/scripts.service.ts` | Builders can fetch deployed scripts, transform CBOR/JSON payloads, and retrieve normalized Handle policy settings. `/scripts` lists every `<slug><ordinal>@handlecontract` subhandle that has inline script CBOR (no curated family allow-list). The highest ordinal per family is marked `latest`. `?type=X` is a `startsWith` filter on the slug (`type=pers` matches `pers`/`persprx`/`perspz`/etc.); `?latest=true` filters to entries marked latest. |
| MCP read surface | `POST /mcp`, `GET /mcp` | `routes/mcp.route.ts`, `controllers/mcp.controller.ts`, `repositories/handlesRepository.ts` | Tool-using clients can access a read-only JSON-RPC surface for handles, holders, policies, and stats without bespoke HTTP integrations. |
| Scanner/index lifecycle and verification | `GET /health`, `GET /stats`, `GET /mpt-root` | `services/ogmios/ogmis.service.ts`, `lambdas/scanner.ts`, `lambdas/scanner.app.ts`, `stores/redis/index.ts`, `repositories/handlesRepository.ts`, `routes/mptRoot.route.ts`, `controllers/mptRoot.controller.ts`, `utils/snapshotVerification.ts` | Operators and clients can observe freshness, verify MPT root integrity against the chain, and rely on ordered index updates as blocks are processed. Health can report `current`, `storage_behind`, `ogmios_behind`, `updating`, or `waiting_on_cardano_node`. During `UTXO_IMPORT` (snapshot reimport), health reports `storage_behind` not `updating`. |
| Runtime entrypoints | local `npm run ogmios` / `npm run api`, container `shell/entrypoint.sh`, Lambdas in `lambdas/*.ts` | `shell/start_local.sh`, `express.ts`, `shell/entrypoint.sh`, `lambdas/api.ts`, `lambdas/scanner.ts`, `lambdas/snapshot.ts` | Operators can run the same indexed API locally, in containers, or with dedicated Lambda entrypoints for API, scanning, and snapshots. |
| Mint relay support | `POST /mint` | `routes/mint.route.ts`, `controllers/mint.controller.ts`, `services/minting.service.ts` | Subhandle minting flows can relay requests through a controlled API surface. |

## Non-Feature Exclusions
- No direct write/update endpoints for arbitrary handle state.
- No explorer-style generalized chain query API.
- No auth-only private account functionality in this service.

## Validation Signals
- Swagger route list and request/response contracts remain current (`docs/swagger.yml`).
- Repository tests validate key branch logic for indexing, search, rollback safety, and endpoint handlers.
- Health/freshness semantics remain stable (`200` when caught up, `202` when catching up).
