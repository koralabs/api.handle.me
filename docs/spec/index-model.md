# Index and Data Model Spec

## Overview
`HandlesRepository` is the canonical read/write domain layer over the Valkey-backed `RedisHandlesStore`. Scanner paths write ordered chain state into indexes; API paths read from those indexes without chain RPC calls on request paths.

## Primary Index Domains

### Core Handle State
- `HANDLE`: hash map keyed by handle name containing canonical stored handle fields.
- `SLOT`: ordered set from slot to handle names for slot-based pagination.
- `MINT`: set of serialized minting records per handle. Members are encoded with a canonical JSON stringifier (`canonicalJsonStringify`) that sorts object keys recursively and coerces `bigint` to a numeric string, so replaying a block after a mid-block Lambda crash produces a byte-identical set member and SADD deduplicates instead of creating a second entry.

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
   - When a UTxO contains a reference token (`LBL_100`) or sub-handle settings token (`LBL_001`) whose inline datum is missing, the processor logs an error and `continue`s to the next asset in the same UTxO instead of returning from the function. This preserves state for co-minted/co-transferred handles that would otherwise be silently abandoned.
   - `updateHandleIndexes` accepts an optional `options.suppressDoubleMintDetection` flag. Rollback/drift repair paths set it to `true` because `stored.utxo !== canonical.utxo` is a tautology during repair — running the normal double-mint branch would falsely bump `handle.amount` on every repair cycle and eventually cause `removeHandle`'s `amount - 1 <= 0` burn threshold to stop firing on affected handles.

### Per-handle index symmetry
- `save(handle, oldHandle?)` writes to `HANDLE_TYPE`, both `PERSONALIZED` buckets, and the `SLOT` ZSET; `removeHandle(handle)` on a full burn must prune every one of them or searches filtered by those indexes return keys that no longer exist in `HANDLE`.
- `save()` removes the old `HANDLE_TYPE` bucket entry when `oldHandle.handle_type !== handle.handle_type` (e.g., `HANDLE` → `VIRTUAL_SUBHANDLE` on an LBL_000 update), so a type transition does not leave an orphan in the prior bucket.
- `save()` cleans `SLOT` by handle name (`ZREM slot name`). The prior code called `removeValuesFromOrderedSet(SLOT, updated_slot_number)`, which stringified the ordinal and performed a no-op `ZREM` in almost every case — worst case a wrong-target removal for a handle whose name happened to equal the current block slot.
- `removeHandle` removes the burned handle from both `PERSONALIZED:0` and `PERSONALIZED:1`. Recomputing the current bucket (`image_hash != standard_image_hash` OR any populated `personalization` field) could disagree with what `save()` actually wrote for legacy or drifted state, so cleanup is defensive by design — `SREM` on the wrong bucket is a no-op.

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
- Pipeline execution always clears queued state on failure. Reentrant `RedisHandlesStore.pipeline()` calls throw — the previous behavior silently overwrote the outer queue's commands, which was a silent data-loss path.
- Rollback/reindex flows clear lock state in `finally` paths to prevent deadlocks.
- Stored `mpt_root_hash` must reflect the `IndexNames.HANDLE` key set at `metrics.currentSlot`. The scanner `scan()` rebuilds it in a `finally`, guarded by an `endingCurrentSlot !== startingCurrentSlot` check, so every exit path — including `ScannerDeadlineError`, retriable Koios/Blockfrost failures, and fatal rethrown errors — leaves the stored root in sync with the handle set. No-op invocations (no blocks processed) skip the rebuild.
- Scanner lease (`scanner:lease`) renew and release operate via atomic Lua CAS — a GET-then-PEXPIRE/DEL round trip opened a TOCTOU window where a stale owner could extend a freshly-reacquired lease belonging to another invocation.
- `IndexNames.MINT` members must be canonically stringified. Non-canonical JSON encoding could produce two distinct set members for the same logical mint across a block replay (e.g., when the provider returns the same mint's metadata with different key insertion order), creating a phantom duplicate.
- The snapshot-loader progress marker (`{api:NETWORK}:snapshot_loader:progress`) is tagged with `utxoSchemaVersion` and `snapshotHash`. Resuming an interrupted snapshot import is only valid against the exact snapshot bytes the marker was written for — a schema bump or operator-uploaded replacement snapshot across invocations triggers a `clearNamespace` and fresh start rather than applying stale chunk offsets to new-schema data.

## Snapshot and Schema Behavior
- Snapshot population can bootstrap UTxOs and minting data from S3 snapshot artifacts.
- Snapshot artifacts are only considered valid when they carry chain-verification metadata from generation time; verification compares the indexed handle set to the indexed `handle_root@handle_settings` datum root hash, and unverified artifacts are ignored at bootstrap.
- `indexSchemaVersion` and `utxoSchemaVersion` metrics control reindex/bootstrap decisions at startup.
- Reindex repopulates all non-UTxO/non-MINT indexes from stored UTxOs.
