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
- Core read API:
  - `/handles` catalog search + pagination and `/handles/list` batch reverse-lookup
  - `/handles/:handle` details and associated views (`/utxo`, `/personalized`, `/subhandle-settings`, `/subhandles`)
  - `/holders` and `/holders/:address` holder reverse lookup and aggregation
  - `/root-handles` for root handle inventory and filtering
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
- API side may use async operations
- Store-first serving model returns `202` while still catching up
- Scheduled scanning can use managed Demeter UTxORPC without locally hosting cardano-node or Ogmios
- Chain ingestion must preserve every Handle-policy touch, complete-block ordering, datum/script/metadata fidelity, and rollback-safe cursor semantics
- Deployment targets include local Docker/Node and self-hosted box functions; AWS Lambda/ALB deployment is retired
- Deployment orchestration is owned by the box workflow and the sibling `adahandle-deployments` build scripts

## Risks and Pain Points (Ecosystem-driven)
- Resolution complexity: multiple handle “types” and standard evolutions (CIP labels, policy transitions) create integration risk.
- Adoption lag: new features (Personalization, SubHandles, Marketplace assets) require many wallets/dApps to update.
- Burst traffic: mint events and feature launches can cause sudden spikes; index freshness and rate limiting need to remain predictable.
- Privacy/safety: personalization increases identity surface area; API responses should be treated as public data.

## Future Considerations (Not Implemented Here Yet)
- Support for new script/policy eras (e.g., decentralized minting policy transitions) with minimal breaking changes for integrators.
- Additional “resolver UX” endpoints for wallets (pre-validated resolution results, richer personalization pointers).
- HandleChat / payments experiences are separate products; this API may become a data dependency but does not implement messaging or payment flows.

## Success Criteria
- Consistent API availability during sync and restart windows
- Accurate indexed Handle state relative to chain providers
- Complete API documentation in `docs/swagger.yml`
- Complete operator-facing env glossary in `site.env`
