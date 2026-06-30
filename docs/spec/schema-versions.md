# Schema Versions (`UTXO_SCHEMA_VERSION` / `INDEX_SCHEMA_VERSION`)

These two integers are a **public, consumer-facing contract**, not internal knobs. Both are
published on `GET /health` (`utxo_schema_version`, `index_schema_version`) and downstream
integrators gate on them. **Bumping either one announces to everyone that the stored schema
changed in a breaking way and that they must update their integration to keep working.**

> ⚠️ **Never bump a schema version to "force a reindex / reimport."** That is not what they are
> for. The repopulate-from-UTxOs / snapshot-reimport behaviour is a *side effect* of a version
> increase, not its purpose. To recompute an index without a contract change, do a **snapshot
> reimport** (see [`scanner-recovery-runbook.md`](./scanner-recovery-runbook.md)) — it re-runs
> `save()` over every handle and rebuilds the secondary indexes with the currently deployed code,
> leaving the schema versions untouched.

## What each version means

### `UTXO_SCHEMA_VERSION`
The shape/layout of the stored UTxO data **and** the S3 snapshot artifact. It is part of the
snapshot URL: `${SNAPSHOT_BASE_URL}/${NETWORK}/utxo-snapshot/${UTXO_SCHEMA_VERSION}/handles_utxos.gz`.

- Bump **only** when the UTxO/snapshot data shape changes incompatibly.
- A bump **requires a matching snapshot artifact** to already exist at the new version path.
  Bumping without one resolves the URL to a non-existent object, loads an empty snapshot, and
  **wipes the handle index** (`requireSchemaVersion` now fails loud to prevent the `NaN` variant
  of this, but a valid-but-empty new version is still destructive).

### `INDEX_SCHEMA_VERSION`
The shape/semantics of the **secondary indexes** (`HANDLE_TYPE`, `PERSONALIZED`, `SLOT`, …) that
the data model and `?`-filters depend on.

- Bump **only** when an index's structure changes in a way that makes the previously-stored index
  invalid/incompatible for consumers.
- On a bump, the scanner detects deployed > stored (`stores/redis/index.ts`) and **repopulates
  indexes from UTxOs**. Requires the scanner at 10GB (see runbook).

### What is **NOT** a schema-version bump
- Adding a new **additive** response field (e.g. `is_personalized`) — consumers that ignore it are
  unaffected.
- Broadening which handles fall into an existing index/filter (e.g. `PERSONALIZED` now also counts
  custom chain addresses) — the index *structure* is unchanged; only its membership is recomputed.
  Recompute via a snapshot reimport, **do not** bump the version.

## Current versions

| Version env | Current | Notes |
|---|---|---|
| `UTXO_SCHEMA_VERSION`  | `1` | default in code; snapshot path `.../utxo-snapshot/1/...` |
| `INDEX_SCHEMA_VERSION` | `3` | default in `repositories/handlesRepository.ts` |

## Changelog (record every bump here)

When you bump a version, add a row: what changed in the stored schema, why it is breaking for
consumers, and the migration/reimport performed. Backfill historical rows from git history.

| Date | Version | From → To | Breaking change | Consumer action required |
|---|---|---|---|---|
| _(backfill)_ | `INDEX_SCHEMA_VERSION` | … → 3 | _(record)_ | _(record)_ |
| _(backfill)_ | `UTXO_SCHEMA_VERSION` | … → 1 | _(record)_ | _(record)_ |
