# Snapshot admission and ownership

## Failure and correction

The loader cleared the API namespace before fetching or validating the snapshot. Rejected schema/verification and missing files could then replace original metrics with genesis; resumed missing files and malformed or stale cursors could publish an incorrect starting point. Native Glide hash arrays were interpreted as records. Namespace deletion also erased scanner control leases. Legacy Ogmios initialization wrote synthetic metrics before admission and destroyed newly restored data before resume.

These are producer/root-cause fixes: validate the complete decompressed candidate before mutations; compare the original metrics/progress images at admission; fence each transaction by actual ownership; restrict deletion to data keys; and propagate refusal without destructive fallback. Bootstrap bookkeeping follows successful admission and resume.

## Contract

- A successful candidate must have the configured schema, a valid block hash/slot, structurally valid complete UTxO, mint and optional scanned-block DTOs, and equal nonempty 32-byte publisher verification roots for the current network. Every entry is checked before clearing or replaying anything.
- Existing publisher trust is retained. Verification metadata is **not independent chain attestation or an authenticated full-payload receipt**. Ogmios intersection checks remain in the legacy resume flow.
- Resume markers bind schema, block hash and SHA-256 of the actual compressed bytes. Both chunk offsets must be nonnegative integers within the complete candidate; UTxO progress requires completed mint progress. Invalid, legacy unbound or mismatched markers are refused intact, not silently discarded.
- A 404 can initialize genesis only when the original metrics/progress are absent and no original data keys exist. A resumed 404, other HTTP status, fetch/decompression/JSON/DTO error or failed admission does not mutate the original cache.
- The worker uses a dedicated transaction client. WATCH compares the exact pre-fetch metrics/progress and scanner lease images before claiming loader ownership. Each subsequent transaction checks the loader token and scanner token, renews their leases, and commits only while both remain current. Transaction refusal never retries the write automatically.
- An invocation may use an existing scanner lease only if that same process registered the token after successful acquisition. A standalone importer atomically reserves an absent scanner lease instead of borrowing another invocation's lease. Release compares tokens before deletion.
- Data clearing is allowlisted to index roots/members, metrics, MPT root, registry labels and scanned blocks. Scanner leases/recovery flags, loader ownership/progress and unrelated control keys are preserved.

## Deliberate boundary

This is bounded pre-admission/original-image preservation, **not generation publication or crash-atomic valid imports**. Once a valid candidate is admitted, an interrupted import or backend error may leave partially imported data; its bound progress is retained for the same candidate. Lost ownership stops subsequent writes and never rolls back over a successor. Changing the candidate or recovering an expired partial import requires separately authorized operator recovery; this change does not run one. No independent chain/payload attestation, deployment or live recovery is implied.

## Local verification

Focused loader and lifecycle tests exercise complete-image preservation, malformed late DTOs, Glide array markers, cursor bounds, byte binding, real replay and control-key survival. `REDIS_PORT=6380 node --test workers/snapshotTransactions.node-test.mjs` additionally exercises the real Glide transaction boundary against the disposable local Valkey server, including competing owners and a change immediately before EXEC. The test refuses port 6379 and uses a unique namespace.
