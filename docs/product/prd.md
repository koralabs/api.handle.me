# Handles Public API PRD

## Summary
The Handles Public API provides low-latency read access to ADA Handle data and related metadata by scanning Cardano chain data and indexing Handle state in Valkey.

## Product Context (ADA Handle Ecosystem)
ADA Handle has expanded beyond “send to a human-readable name” into a family of standards and products (Personalization, SubHandles, decentralized minting, marketplace features, and more). This API exists to make those on-chain resolution rules and datasets easier to integrate by exposing stable HTTP endpoints backed by an indexed store.

External context and milestones live in `docs/product/ecosystem.md`.

## Problem
Reading Handle state directly from chain providers for every request is expensive and slow. Clients need:
- Fast lookups by handle, holder, and filters
- Stable pagination options for large data sets
- Access to UTxO/script/datum/policy data for integration workflows
- Health and sync-state visibility

## Goals
- Serve Handle reads from an indexed store with predictable latency
- Keep API responses available while scanner catches up (HTTP `202` behavior)
- Support both wallet-facing lookups and builder-focused utilities (`/datum`, `/scripts`)
- Support MCP-based read access for tool-using clients
- Support local development and production Lambda deployment patterns

## Non-Goals
- No write/update endpoints for Handle state
- No generalized blockchain explorer features
- No guaranteed finality of very recent data while scanner/provider sync is in progress

## Primary Users
- Wallets and dApps resolving Handle ownership and metadata
- Marketplaces and analytics pipelines querying bulk Handle data
- Internal services using script metadata and mint relay functionality

## Key Use Cases
- Wallet UX: resolve `$handle` to a payment address and render personalization where supported.
- dApp UX: show “who owns what handle” (holder views) and handle metadata for profiles/leaderboards.
- Root-handle operators: manage SubHandles and verify settings/UTxOs.
- Integrators/builders: compute/validate datums and retrieve canonical scripts/policies per network.

## Product Requirements
- Complete API documentation in `docs/swagger.yml`.
- Operator env glossary is maintained in `site.env` (no real secrets).
- Runtime feature inventory and endpoint ownership are maintained in `docs/product/feature-matrix.md`.
- Snapshot recovery must preserve existing data, metrics and control ownership when a candidate, resume marker or pre-admission ownership check is invalid. Missing snapshots permit genesis only for an absent original. See [Snapshot Admission and Ownership](../spec/snapshot-admission.md) for the bounded import and trust contract.
- Core read API:
  - `/handles` catalog search + pagination and `/handles/list` batch reverse-lookup
  - `/handles/:handle` details and associated views (`/utxo`, `/personalized`, `/subhandle-settings`, `/subhandles`)
  - `/holders` and `/holders/:address` holder reverse lookup and aggregation
  - `/root-handles` for root handle inventory and filtering
- Marketplace reads:
  - `/marketplace/listings` exposes current indexed Handle listings as a BFF-compatible array with seller and name filters, prices in lovelace, and current UTxO details.
  - Empty results are successful reads; malformed listing entries are omitted and invalid queries return client errors. Normal indexed-read freshness statuses apply.
- Utility endpoints:
  - `/scripts` for the deployed-script catalog (every `*@handlecontract` subhandle with inline CBOR), with `?type=` slug `startsWith` filtering and `?latest=true` to scope to the highest ordinal per family
  - `/datum` CBOR/JSON encode/decode utility
  - `/policies` for normalized handle policy settings
  - `/deployment` for deployment metadata
- MCP endpoint:
  - `/mcp` provides a read-only Model Context Protocol JSON-RPC surface for handles, holders, policies, and stats.
- Mint relay:
  - `/mint` provides a controlled relay used for SubHandle minting flows (this API is not a generalized minting service).

## Product Contract: Freshness and Availability
- Responses must reflect store freshness:
  - `200` when indexed store is caught up
  - `202` when scanner is still catching up (results are best-effort but may be incomplete)
- `/health` exposes enough fields for integrators to gate UX by sync state (`current`, `storage_behind`, `ogmios_behind`, `waiting_on_cardano_node`).
- `/health` may also report `updating` while destructive scanner maintenance work is in progress.

## Constraints
- Scanner/index updates are synchronous by design (ordering matters)
- Koios response rate-limit signals bind every caller in the process, including success responses with exhausted quota and errors that exhaust local retries. Register header waits before reading a potentially slow body and body waits when received; no later endpoint, split or queued request may start before the maximum stated deadline. Scanner pacing and the invocation work deadline apply to the earliest proposed request start, before waiting and again at dispatch (240 seconds for scheduled Fn; at most twelve minutes otherwise). An unadmittable provider hold exits without clearing its floor, advancing an incomplete block or starting fresh fallback work. [Implementation contract](../spec/spec.md#scanner-and-rollback).
- API side may use async operations
- Store-first serving model returns `202` while still catching up
- Scheduled scanning can use managed Demeter UTxORPC without locally hosting cardano-node or Ogmios
- Chain ingestion must preserve every Handle-policy touch, complete-block ordering, datum/script/metadata fidelity, and rollback-safe cursor semantics
- Deployment targets include local Docker/Node and self-hosted box functions; AWS Lambda/ALB deployment is retired
- Deployment orchestration is owned by the box workflow and the sibling `adahandle-deployments` build scripts
- GitHub Actions runs unit tests only. Integration/e2e, browser and user-journey tests run locally against isolated fixtures, never in Actions. [Verification contract](../spec/spec.md#verification).

## Risks and Pain Points (Ecosystem-driven)
- Resolution complexity: multiple handle “types” and standard evolutions (CIP labels, policy transitions) create integration risk.
- Adoption lag: new features (Personalization, SubHandles, Marketplace assets) require many wallets/dApps to update.
- Burst traffic: mint events and feature launches can cause sudden spikes; index freshness and rate limiting need to remain predictable.
- Privacy/safety: personalization increases identity surface area; API responses should be treated as public data.

## Planned DeMi Minting API

Status: planned, not implemented. [Lean implementation design](../spec/demi-minting-api.md).

- One public minting interface serves handle.me and third-party callers, sharing pricing and business rules rather than creating another minting system.
- Build unsigned DeMi order transactions; wallets sign and submit. Existing engines retain mint execution, delivery, and refunds. New API flows do not support Legacy; existing Legacy flows remain until separately retired.
- Provide quote, build, and status operations. Quotes do not reserve handles. Recheck terms at build time and require acceptance of changed prices.
- Ordinary paid orders require no login/session JWT by default. Remove existing JWT dependencies only after proving equivalent contract/engine enforcement of economic terms and replay protection. Restricted benefits and operator actions retain appropriate authorization.
- Reuse existing order tracking and refund behavior; recognize valid payments independently of client notifications. Preserve unconfirmed-input transaction chaining.
- Keep scope small: start with ordinary root handles supported by DeMi, without a new engine, reservation service, or pricing framework.

## Future Considerations (Not Implemented Here Yet)
- Support for new script/policy eras (e.g., decentralized minting policy transitions) with minimal breaking changes for integrators.
- Additional “resolver UX” endpoints for wallets (pre-validated resolution results, richer personalization pointers).
- HandleChat / payments experiences are separate products; this API may become a data dependency but does not implement messaging or payment flows.

## Snapshot Storage
- Runtime settings arrive as plaintext from deploy-time SOPS; leftover encrypted settings fail startup without contacting KMS. API runtime does not require unused JWT keys or cloud metadata discovery.
- Snapshot publishing and restoration use Cloudflare R2 only, never ambient AWS credentials or an AWS website fallback.
- Missing R2 configuration must fail startup before accepting requests or starting cache workers, rather than being logged only on a later publish.
- Verify deployments on both boxes with an isolated scratch-object write/read/delete check; never invoke a production snapshot worker for verification.

## Success Criteria
- Consistent API availability during sync and restart windows
- Accurate indexed Handle state relative to chain providers
- Complete API documentation in `docs/swagger.yml`
- Complete operator-facing env glossary in `site.env`
