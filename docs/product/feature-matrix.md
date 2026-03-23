# Handles Public API Feature Matrix

## Purpose
This matrix links shipped feature areas to their externally visible endpoints and the runtime paths that own behavior.

## Feature Coverage

| Feature Area | Primary Endpoints | Core Runtime Paths | User Outcome |
| --- | --- | --- | --- |
| Handle lookup and catalog search | `GET /handles`, `POST /handles/list`, `GET /handles/:handle`, `GET /handles/:handle/utxo` | `routes/handles.route.ts`, `controllers/handles.controller.ts`, `repositories/handlesRepository.ts` | Wallets/dApps can resolve handle records, ownership, and UTxO details with filtering and pagination. |
| Holder and root-handle views | `GET /holders`, `GET /holders/:address`, `GET /root-handles` | `routes/holders.route.ts`, `routes/rootHandles.route.ts`, `controllers/holders.controller.ts`, `controllers/rootHandles.controller.ts` | Integrators can map addresses to handle sets and derive root-handle inventory. |
| Personalization and subhandle data | `GET /handles/:handle/personalized`, `GET /handles/:handle/subhandle-settings`, `GET /handles/:handle/subhandles` | `repositories/handlesRepository.ts`, `utils/ipfs/*`, `controllers/handles.controller.ts` | Clients can render profile metadata and subhandle state from indexed chain data. |
| Script catalog and builder utilities | `GET /scripts`, `POST /datum`, `POST /tx/evaluate` | `controllers/scripts.controller.ts`, `controllers/datum.controller.ts`, `controllers/tx.controller.ts`, `services/scripts.service.ts`, `services/txEvaluation.service.ts` | Builders can fetch canonical scripts, evaluate transaction redeemers through Ogmios, and transform CBOR/JSON payloads for integration workflows. Canonical script handles follow `<slug><ordinal>@handlecontract`, `/scripts` marks the highest ordinal per public type as `latest`, and it hydrates `unoptimizedCbor` from the owning repo’s `<network>/<slug>.unoptimized.cbor` artifact when present. |
| Scanner/index lifecycle | `GET /health`, `GET /stats` | `services/ogmios/ogmios.service.ts`, `lambdas/scanner.ts`, `stores/redis/index.ts`, `repositories/handlesRepository.ts` | Operators and clients can observe freshness and rely on ordered index updates as blocks are processed. |
| Mint relay support | `POST /mint` | `routes/mint.route.ts`, `controllers/mint.controller.ts`, `services/minting.service.ts` | Subhandle minting flows can relay requests through a controlled API surface. |

## Non-Feature Exclusions
- No direct write/update endpoints for arbitrary handle state.
- No explorer-style generalized chain query API.
- No auth-only private account functionality in this service.

## Validation Signals
- Swagger route list and request/response contracts remain current (`docs/swagger.yml`).
- Repository tests validate key branch logic for indexing, search, rollback safety, and endpoint handlers.
- Health/freshness semantics remain stable (`200` when caught up, `202` when catching up).
