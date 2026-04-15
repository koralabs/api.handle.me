# Index and Data Model Spec

## Overview
`HandlesRepository` is the canonical read/write domain layer over the Valkey-backed `RedisHandlesStore`. Scanner paths write ordered chain state into indexes; API paths read from those indexes without chain RPC calls on request paths.

## Primary Index Domains

### Core Handle State
- `HANDLE`: hash map keyed by handle name containing canonical stored handle fields.
- `SLOT`: ordered set from slot to handle names for slot-based pagination.
- `MINT`: set of serialized minting records per handle.

### Ownership and Resolution
- `HOLDER`: set of handles per holder key.
- `DEFAULT_HANDLE`: optional explicit default-handle set per holder.
- `HOLDER_COUNT`: ordered set for holder ranking/pagination.
- `ADDRESS`, `PAYMENT_KEY_HASH`, `HASH_OF_STAKE_KEY_HASH`: reverse lookup indexes for resolved addresses and key hashes.

### Search Facets
- `RARITY`, `LENGTH`, `CHARACTER`, `NUMERIC_MODIFIER`, `HANDLE_TYPE`, `OG`, `PERSONALIZED`.
- Search queries are set intersections over active filters, then optional text/hex matching and pagination.

### Subhandle and UTxO History
- `SUBHANDLE`: root-handle to child-subhandle mapping.
- `UTXO_SLOT`: ordered set mapping slot to UTxO IDs.
- `UTXO`: hash map keyed by UTxO ID storing normalized UTxO records.

## Write Flow
1. Scanner retrieves ordered block/tx payloads and normalizes minting data.
2. `addMintDataFromUTxOs` persists mint records once per batch.
3. `addUTxOsWithMintDataAndUpdateIndexes` stores UTxOs and calls `updateHandleIndexes`.
4. `updateHandleIndexes` mutates handle records, owner indexes, personalization/subhandle projections, and slot indexes.

## Read Flow
1. Route/controller parses request query/path models.
2. Repository resolves index sets and intersections for filters.
3. Repository hydrates stored handle objects and default-handle projection.
4. Controller serializes output shape for JSON or text responses.

## Key Namespace
All index keys are scoped under `{api:<network>}:<IndexName>` (e.g., `{api:mainnet}:HANDLE`). Additional operational keys outside the index domains:
- `scanner:lease` — expiring SET NX lease for scanner concurrency
- `scanner:recovery` — recovery flag for mid-phase interruption (`rollback` or `reindex`)
- `mpt_root_hash` — cached MPT root computed from the current handle set

## Consistency Invariants
- Scanner/index writes are synchronous by block/UTxO ordering.
- Missing minting data during update is a hard error (scanner invariant protection).
- Holder indexes and holder-count ranking update together.
- Pipeline execution always clears queued state on failure.
- Rollback/reindex flows clear lock state in `finally` paths to prevent deadlocks.

## Snapshot and Schema Behavior
- Snapshot population can bootstrap UTxOs and minting data from S3 snapshot artifacts.
- Snapshot artifacts are only considered valid when they carry chain-verification metadata from generation time; verification compares the indexed handle set to the indexed `handle_root@handle_settings` datum root hash, and unverified artifacts are ignored at bootstrap.
- `indexSchemaVersion` and `utxoSchemaVersion` metrics control reindex/bootstrap decisions at startup.
- Reindex repopulates all non-UTxO/non-MINT indexes from stored UTxOs.
