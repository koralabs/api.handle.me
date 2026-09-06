# Scanner Recovery Runbook

## Symptoms and Recovery Procedures

### Symptom: API returns `status: storage_behind` and slot not advancing

**Diagnosis:**
1. Check box logs with `kora-logs <env> api.handle.me --pattern 'scannerLambda|ERROR|NOTIFY' --days 1`
2. Check `/health` and Valkey metrics: `lockLambdas`, `currentSlot`, `currentBlockHash`, `lastSlot`
3. Check the worker's box deployment `logTail` and systemd/Fn timeout messages

**Common causes and fixes:**

---

### Cause: Demeter UTxORPC stream failure

**Symptoms:**
- `scannerLambda.error`, `scannerLambda.demeterDeadlineReached`, or `scannerLambda.demeterRollback`
- `currentSlot` remains on the last complete block
- Logs mention a missing intersection, non-contiguous block height, conflicting tip hash, or missing payload field

**Root cause:** In Demeter mode the scanner intentionally fails closed. It never falls back to another provider because advancing on two providers' conflicting views can permanently omit transactions. Matching blocks are buffered until the next block begins, so the scanner normally remains one block behind `ReadTip`.

**Recovery:**
1. Confirm `SCANNER_CHAIN_SOURCE=demeter`, `DEMETER_UTXORPC_ENDPOINT`, and `DEMETER_UTXORPC_API_KEY` are present in the function config without printing their values.
2. Verify `ReadTip` succeeds and that `currentBlockHash/currentSlot` is a retained Demeter intersection.
3. For `undo`, allow canonical rollback reconciliation to complete; do not edit UTxOs directly.
4. If the intersection is no longer retained or reconciliation cannot establish a canonical cursor, restore a verified pre-fork snapshot and replay through `WatchTx`.

---

### Cause: Scanner worker timing out (15 min)

**Symptoms:**
- Box logs show repeated `scannerLambda.lockedTooLong` warnings
- Worker runtime logs show a timeout near 900 seconds
- `lockLambdas: SCANNING` or `lockLambdas: ROLLBACK` in metrics
- Slot not advancing

**Root cause:** The scanner has a 12-minute hard deadline (`ScannerDeadlineError`) that should exit cleanly before the 15-minute Lambda timeout. If you see actual 15-minute timeouts, the deadline mechanism isn't firing — check breadcrumb logs (`scannerLambda.breadcrumb`, `scannerLambda.scan.breadcrumb`, `scannerLambda.rollback.breadcrumb`) to pinpoint where execution hangs.

The scanner falls back to Blockfrost when Koios calls fail. If both providers are down or the head points to an orphaned block, `processRollback`'s hash-set orphan detection identifies orphaned UTxOs and repairs only the affected handles. Drift candidates are scoped via the `scanned_blocks` ZSET (blocks canonical has that we never processed); if that ledger is missing or incomplete (e.g., cold boot after a reimport from a pre-`scannedBlocks` snapshot), the rollback check may either false-positive (extra `tx_info` fetches for canonical blocks we correctly scanned as handle-free) or miss genuine missed-block drift for a few scan cycles until the ledger rebuilds. This is self-healing — the scan loop writes one ledger entry per processed block and the behavior converges quickly.

**Recovery:**
1. Check breadcrumb logs with `kora-logs` — they show exactly which step hung
2. If the scanner head is stuck on an orphaned block, the hash-set rollback should self-recover on the next invocation
3. If self-recovery is not working, clear metrics via valkey-utility to trigger a snapshot reimport:
   ```json
   {"currentBlockHash": "", "currentSlot": "0", "lockLambdas": "", "lockLambdasTimestamp": "0"}
   ```
4. Before clearing, **bump scanner Lambda memory to 10GB** (see below)
5. Publish a new version and update the alias
6. After reimport completes and scanner catches up, restore memory to 4GB

---

### Cause: OOM during snapshot reimport

**Symptoms:**
- `platform.report` shows `status: error`, `errorType: Runtime.OutOfMemory`
- Metrics hash may be partially or fully wiped
- API returns `{"message": "Invalid time value"}`

**Recovery:**
1. Bump scanner Lambda to **10GB** memory:
   ```bash
   aws lambda update-function-configuration --function-name api-scanner --memory-size 10240
   ```
2. Restore essential metrics fields if wiped:
   ```json
   {"utxoSchemaVersion": "1", "indexSchemaVersion": "3", "currentBlockHash": "", "currentSlot": "0", "startTimestamp": "<now_ms>", "lockLambdas": "", "lockLambdasTimestamp": "0"}
   ```
3. Publish new version and update alias (the alias won't pick up config changes without this)
4. After reimport completes, restore to 4GB and publish/update alias again

---

### Cause: Wrong NETWORK env var after manual Lambda config change

**Symptoms:**
- Scanner Lambda invocations succeed in ~5 seconds with no application logs
- No log streams for the expected version number
- Slot not advancing

**Diagnosis:** Check the Lambda version's `NETWORK` env var — it may have inherited from the base function (which might be set to a different network).

**Recovery:**
1. Get the correct env vars from a known-good version:
   ```bash
   aws lambda get-function-configuration --function-name api-scanner --qualifier <good_version> --query 'Environment' --output json
   ```
2. Update the base function with the correct env:
   ```bash
   aws lambda update-function-configuration --function-name api-scanner --environment '<env_json>'
   ```
3. Publish and update alias

---

## Critical Checklist for Any Scanner Reset

1. **Both regions** — us-east-1 AND us-west-2 have separate Valkey instances, separate scanner aliases, and separate valkey-utility Lambdas. Fix both.

2. **Bump memory before reimport** — The S3 snapshot for mainnet is ~265K handles. Reimporting requires 10GB. Set memory to 10240 BEFORE triggering the reimport.

3. **Publish and update alias** — Changing `update-function-configuration` only affects the base `$LATEST` function. You MUST:
   ```bash
   aws lambda publish-version --function-name api-scanner
   aws lambda update-alias --function-name api-scanner --name <network> --function-version <new_version>
   ```

4. **NETWORK env var** — When updating function configuration, the env vars come from the base function, not the alias. Always verify `NETWORK` matches the target alias.

5. **Restore memory after reimport** — Once scanning is at tip, drop back to 4GB and publish/update alias again.

6. **API Lambda stale cache** — After reimport, the API Lambda may show `slot: 0` or `percentage_complete: 0` for up to 30 minutes until its warm instances cycle out. The data in Valkey is correct — verify with valkey-utility.

## Reindex Without Reimport (recompute indexes, no schema bump)

Use this when a **secondary index's membership changed additively** but its shape/contract did
**not** — e.g. broadening the `is_personalized` predicate so `PERSONALIZED` also counts custom
(non-`ada`) chain addresses. This rebuilds the secondary indexes from the UTxOs **already in
Valkey** — no S3 reimport, no chain rescan (~5 min for ~265K handles).

> ⚠️ This is **not** a schema-version bump. Do **not** touch `INDEX_SCHEMA_VERSION` /
> `UTXO_SCHEMA_VERSION` — they are a breaking-change contract published on `/health`
> (see [`schema-versions.md`](./schema-versions.md)). Adding a field or broadening index membership
> is additive; bumping would falsely tell every consumer the schema broke.

**Mechanism:** set the recovery flag `{api:<network>}:scanner:recovery = reindex`. The next
scheduled scanner tick reads it (`scanner.app.ts`: `getRecoveryFlag()` → `processReindex()` →
`repopulateIndexesFromUTxOs()`), rebuilds indexes with the **currently deployed code**, then clears
the flag. `indexSchemaVersion` / `utxoSchemaVersion` stay untouched. On AWS the scanner runs this
in-process (`KORA_SCANNER_DEFER_IMPORTS` is unset); the 409/deferred path is box-only.

**Procedure — one region at a time, east verified before west:**
1. Deploy the code first (the predicate must live in a single shared helper used by both the view
   model field and the index `save()`, e.g. `utils/isPersonalized.ts`).
2. Bump that region's `api-scanner` to **10GB** (`update-function-configuration --memory-size 10240`
   → `wait function-updated` → `publish-version` → `update-alias <network>`; verify `NETWORK`). The
   rebuild iterates every handle and OOMs at 4GB.
3. `valkey-utility` **`trigger_reindex`** (sets the recovery flag):
   ```bash
   aws lambda invoke --function-name valkey-utility --region us-east-1 \
       --cli-binary-format raw-in-base64-out \
       --payload '{"action":"trigger_reindex","region":"us-east-1","network":"mainnet"}' /tmp/r.json
   ```
4. Watch the region's metrics: `lockLambdas` goes `REINDEX` (~5 min), then clears; the recovery flag
   returns to `null`; the scanner resumes `SCANNING` and catches back to tip
   (`currentBlockHash == tipBlockHash`).
5. Verify (`indexSchemaVersion` unchanged, the affected filter e.g. `?personalized=true` returns
   200, region at tip).
6. Restore that region's scanner to **4GB** (config → publish → alias).
7. Repeat for the other region.

> ⚠️ **`api.handle.me` is CNAME'd to the _west_ ELB only — there is NO Route53/east failover.**
> `east.api.handle.me` is the east-direct endpoint. Consequences during a reindex:
> - A **west** reindex briefly degrades the **main** `api.handle.me` (~5 min). It returns **HTTP
>   `202` with the full handle body** — "a region is reindexing", not an error — but consumers that
>   reject non-`200` will see it. Prefer low-traffic windows for west.
> - An **east** reindex only affects `east.api.handle.me`; main traffic is unaffected.
>
> Done 2026-06-22 for `is_personalized` (api.handle.me#199), both regions, on the eef2391-based
> mainnet deploy. `trigger_reindex` is a permanent `valkey-utility` action.

## Valkey-Utility Usage

The `valkey-utility` Lambda is ad hoc throwaway code. Deploy whatever handler you need:

```bash
# Write your handler to index.js
# Package with ioredis
cd tmp/adhoc-valkey-utility
zip -r /tmp/handler.zip index.js node_modules/ package.json
aws lambda update-function-code --function-name valkey-utility --zip-file fileb:///tmp/handler.zip
# For west:
aws lambda update-function-code --function-name valkey-utility --zip-file fileb:///tmp/handler.zip --region us-west-2
```

Environment variables available: `REDIS_HOST_US_EAST_1`, `REDIS_HOST_US_WEST_2`, `REDIS_USE_TLS`, `NETWORK`.

### Index-Orphan Audit and Cleanup

The utility also ships with read-only `audit_orphans` and mutating `cleanup_orphans` actions for reconciling secondary indexes against `IndexNames.HANDLE`. These surface entries in `HANDLE_TYPE`, `PERSONALIZED`, and `SLOT` that reference handle names no longer present in the HANDLE index (typically the residue of pre-fix `removeHandle` not pruning every index that `save()` populated), plus any `handle.amount > 1` (which can result from the pre-fix rollback-repair false-positive double-mint bump).

```bash
# Read-only report — safe to run anytime, both regions
aws lambda invoke --region us-east-1 --function-name valkey-utility \
    --cli-binary-format raw-in-base64-out \
    --payload '{"action":"audit_orphans","region":"us-east-1","network":"mainnet"}' \
    /tmp/audit.json

# Inspect: counts by category, sample orphans per bucket, inflated-amount handle list
cat /tmp/audit.json | jq '{live_handles, handle_type_orphan_count, personalized_orphan_0, personalized_orphan_1, slot_orphan_count, inflated_amount_count}'
```

Cleanup accepts `dryRun: true` to report what it would remove without touching Valkey. Amount resets are unconditional: any `amount > 1` is set to `1`, because there are no real on-chain double-mints in the current state (the historical `mydexaccounts` incident has since been resolved on chain).

```bash
# Dry run first
aws lambda invoke --region us-east-1 --function-name valkey-utility \
    --cli-binary-format raw-in-base64-out \
    --payload '{"action":"cleanup_orphans","region":"us-east-1","network":"mainnet","dryRun":true}' \
    /tmp/cleanup-dry.json

# Live cleanup — idempotent; safe to re-run
aws lambda invoke --region us-east-1 --function-name valkey-utility \
    --cli-binary-format raw-in-base64-out \
    --payload '{"action":"cleanup_orphans","region":"us-east-1","network":"mainnet"}' \
    /tmp/cleanup.json
```

Mainnet ops rule: run audit/cleanup on east first, verify `/health` and `/mpt-root` remain healthy for ~10 minutes, then do west. The cleanup does not take a region offline but does mutate index state while the API is serving reads, so keep the sequential-region discipline.

**Design note:** a freshly rebuilt snapshot (full S3 reimport) produces a clean index automatically, so post-reimport audit counts are typically zero. Orphans tend to accumulate only across long-lived Valkey instances that have seen many rollbacks or type transitions before the fixes landed.
