# Anomaly Sweep: Silent Data Loss

**Date:** 2026-05-07 (updated 2026-05-08 to reflect commits 29bafba, 4fb4b60, 6772557)
**Scope:** Whole repo. Where can transactions, blocks, UTxOs, or handles silently disappear?

## Update — closed since first draft

- **Phase 4 inner Koios 413 silent drop (the seed anomaly itself).** Closed by
  29bafba: `fetchUtxoBatchKoios` now recursively halves the batch on 413.
  Tier 1 #1 below has been reframed — the *outer* pool-wide catch is still
  open.
- **Phase 4d ghost-rescue.** Tried then reverted (4fb4b60) because Koios is
  the wrong source-of-truth when Blockfrost is ahead in Koios's reorg window.
  Not a finding from this sweep, but worth noting as resolved noise.
- **Cross-provider block-tx coverage gap (sibling of dabea7e).** Closed by
  6772557: scanner now halts when Koios `block_txs` row count is less than
  Blockfrost's `tx_count` for the same block, instead of silently advancing
  through Blockfrost-only territory. This wasn't itemized in the original
  sweep but is the same failure class — fixing it strengthens the posture
  check: the team is iterating on this exact category.

## Seed anomaly

`scripts/bootstrap-from-apis.ts` Phase 4 — when Koios returns 413 on a 50-asset
batch (often triggered by long `@`-subhandle asset names), the failed batch is
caught, logged, and dropped. ~16 batches × 50 work items = ~800 lost work items
including 15 missing handles. The Phase 4a fetcher has since been given a
recursive-halve-on-413 retry; the question that triggered this sweep is whether
the same fail-and-drop shape exists elsewhere.

## Dimensions audited

Five orthogonal lenses, dispatched in parallel:

1. Catch-and-swallow at external-API/network boundaries
2. Scanner pipeline gaps (cursor advance / rollback unwind / lease handoff)
3. Storage write-path silent failures (Valkey pipeline, MPT, S3)
4. Pagination / batching / filtering loss
5. Snapshot / bootstrap / repair tooling reconciliation

Findings consolidated and re-tiered by impact below. Agent claims that didn't
hold up under verification (e.g. `fetchAssetUtxoBatchWithRetry` "silently drops"
— it actually throws; Ogmios JSON.parse "silently skips" — it actually stalls
the websocket pump) have been re-graded.

---

## Tier 1 — Fix-on-sight silent bugs

These either lose data right now or trip on the next unusual chain payload.
Each is small, scoped, and self-contained.

- [ ] **Phase 4 outer pool-wide catch drops entire batches on non-413 errors.**
  [scripts/bootstrap-from-apis.ts:531-534](../../scripts/bootstrap-from-apis.ts#L531-L534).
  29bafba closed the 413 case inside `fetchUtxoBatchKoios` (recursive
  split-retry). This outer catch is the residual sibling: any *non-413* throw
  — connection reset, 5xx after Koios's own retries exhaust, JSON parse
  failure on a malformed response, the Blockfrost fallback path throwing —
  hits this catch, increments `st.failures++`, and abandons the batch. The
  inner 413 fix means we no longer lose 800 items per bootstrap to the
  observed mode, but every non-413 mode still loses items silently. Fix
  direction: re-queue failed batches into a retry list surfaced at phase end,
  or fail-loud with a non-zero exit so the operator knows the snapshot is
  incomplete.

- [ ] **Phase 4c tx_info fetch drops failed batches without per-batch retry.**
  [scripts/bootstrap-from-apis.ts:614-624](../../scripts/bootstrap-from-apis.ts#L614-L624).
  Mirrors the *unfixed* outer-catch shape at the tx_info layer. `fetchTxInfoBatchKoios`
  has no 413 split-retry (compare to the in-scanner
  [`fetchTxInfoBatchWithRetryAndSplit`](../../lambdas/scanner.app.ts#L298) and
  the now-fixed bootstrap `fetchUtxoBatchKoios`). On any throw, a batch of 35
  tx hashes is dropped, leaving the snapshot with handles whose minting
  history can't be reconstructed. Fix direction: copy the split-retry shape
  from `fetchTxInfoBatchWithRetryAndSplit`, plus surface batch-level failure
  totals at phase end.

- [ ] **Snapshot mint pipeline: `JSON.parse(md)` on each minting record without
  per-record guard — corrupts the published snapshot.**
  [lambdas/snapshot.app.ts:178](../../lambdas/snapshot.app.ts#L178).
  Re-verified: the throw inside `.map(JSON.parse)` short-circuits not just
  the rest of the mints loop but the rest of `getRedisItems` (the outer
  try-catch is at function scope, line 185). The function returns *partial*
  state; `processSnapshot` then writes it to S3 unconditionally
  ([lines 254-269](../../lambdas/snapshot.app.ts#L254-L269)) — an ERROR is
  logged but no NOTIFY, and S3 write proceeds. A single corrupt mint record
  can corrupt the published snapshot and downstream consumers won't know.
  Fix direction: per-record try/catch identifying the offending handle, plus
  fail-loud (throw NOTIFY) if any record fails to parse — better to halt the
  snapshot than ship a corrupted one. Matches the dabea7e/6772557 posture.

- [ ] **Local Ogmios scanner: `JSON.parse(msg)` outside the try-catch causes
  the websocket pump to stall on a malformed frame.**
  [services/ogmios/ogmios.service.ts:104](../../services/ogmios/ogmios.service.ts#L104).
  Not a silent *loss* (the scanner halts rather than skipping), but it's a
  silent *hang* — no NOTIFY, no recovery. Trivial fix: wrap the parse, log
  NOTIFY, request next-block to resume.

  *(An earlier draft of this report listed a sibling finding claiming
  `processBlock` was not awaited. That was wrong: `processBlock` is
  synchronous — no `async`, no `await` inside, all repo calls are sync.
  Calling it returns `undefined`, not a Promise, so the existing catch on
  line 141 covers it.)*

- [ ] **`buildUTxOsFromKoiosTxs` iterates `t.outputs` with no nullish guard.**
  [utils/helpers.ts:147](../../utils/helpers.ts#L147).
  `for (const o of t.outputs)` throws if Koios ever returns a tx_info row
  with `outputs: null` (defensive against API shape drift). Add `?? []`. The
  surrounding scanner catch advances state on partial success, so a thrown
  iteration is the worst silent-loss surface in this hot path.

- [ ] **`fetchBlockfrostDatumCbor` catches all errors and returns `null`.**
  [utils/helpers.ts:367-374](../../utils/helpers.ts#L367-L374).
  Conflates "datum not found (404)" with "transient 5xx / timeout". Callers
  reconstruct UTxO state from `null`, so a transient blip becomes a
  permanently-incomplete UTxO record. Fix direction: distinguish 404 from
  transient — return `null` only on 404, throw on everything else and let
  the scanner halt-and-retry per the dabea7e tx_info pattern.

- [ ] **`fetchReferenceScript` (in `utils/helpers.ts`) logs NOTIFY and
  continues with the script field set to null.**
  [utils/helpers.ts:313-322](../../utils/helpers.ts#L313-L322).
  UTxO ends up persisted with `reference_script === null` even though one
  exists on chain. Same fix shape as the datum case: throw on transient,
  let the scanner halt or backfill. Per `AGENTS.md`: *handle properties must
  remain chain-accurate*.

*(An earlier draft listed `decodeCborFromIPFSFile` as a "catch returns
undefined on any failure" finding. Withdrawn after re-reading: the function
already implements primary → Pinata-backup failover ([utils/ipfs/index.ts:7-26](../../utils/ipfs/index.ts#L7-L26)
plus [config/index.ts:16-19](../../config/index.ts#L16-L19)). The
`return undefined` only fires after both gateways have failed — that's the
intentional contract, not a swallowed transient. Throwing on the primary's
transient would break the backup attempt.)*

## Tier 2 — Structural cleanup

Worth doing as a coherent pass when the area is touched. Each touches a class
of callers, not a single line.

- **ioredis pipeline `.exec()` results never inspected for per-command errors.**
  [stores/redis/index.ts:67](../../stores/redis/index.ts#L67) and every caller
  of `store.pipeline(...)`. A pipeline can succeed overall while individual
  commands fail; nothing in the codebase reads `[err, reply]` per entry. Class
  of bug — not just one line. Fix direction: change `pipeline()` to throw if
  any per-command result is an error (or NOTIFY + return a typed result that
  the caller can branch on).

- **Repository save() returns `void`; ~15 index-set updates can partial-write.**
  [repositories/handlesRepository.ts:1056-1129](../../repositories/handlesRepository.ts#L1056-L1129).
  Ties to the pipeline finding above. Returning success/failure counts would
  let callers verify all indexes received the update before declaring the
  handle saved.

- **`filter(Boolean)` on pipeline results in rollback recovery without length
  assertion.**
  [lambdas/scanner.app.ts:654](../../lambdas/scanner.app.ts#L654) and
  [lambdas/scanner.app.ts:745-749](../../lambdas/scanner.app.ts#L745-L749).
  `utxoIds` and `candidateHandleList` are queried, the pipeline result is
  `.filter(Boolean)`-ed without comparing the input length to the kept
  length. A store inconsistency (key in index but value missing) silently
  shrinks the candidate set. Fix direction: assert lengths and NOTIFY on
  mismatch; do not silently proceed.

- **`fetchAssetUtxoBatchWithRetry` lacks the split-on-413 symmetry that
  `fetchBlockTxHashBatchWithRetry` has.**
  [lambdas/scanner.app.ts:461-480](../../lambdas/scanner.app.ts#L461-L480)
  vs.
  [lambdas/scanner.app.ts:445-457](../../lambdas/scanner.app.ts#L445-L457).
  Practical risk is currently low (asset_utxos batches are pre-capped at
  ≤4700 bytes, far below typical 413 thresholds), but the asymmetry is a
  trap for the next time someone bumps the cap. Fix direction: copy the
  block_txs split path. Same shape, ~10 lines.

- **Snapshot SCAN cursor not resumed across Lambda invocations.**
  [lambdas/snapshot.app.ts:126-184](../../lambdas/snapshot.app.ts#L126-L184).
  A 12-min Lambda timeout mid-SCAN restarts at cursor 0 next invocation.
  Mostly self-healing on rerun, but a key deletion between invocations can
  cause SCAN to skip a chunk. Fix direction: persist last-cursor in Valkey;
  on resume, validate enumerated count against prior snapshot's metadata.

- **S3 putObject for snapshots skips ETag / content-length verification.**
  [lambdas/snapshot.app.ts:260-269](../../lambdas/snapshot.app.ts#L260-L269).
  Network truncation could commit a corrupted snapshot that imports cleanly
  but is missing records. Fix direction: assert `ETag` is present and
  body-length matches.

- **`fetchPaginatedResults` treats short-page as end-of-data.**
  [utils/helpers.ts:39-68](../../utils/helpers.ts#L39-L68).
  Blockfrost rate-limit responses are indistinguishable from "last page" to
  this loop. Mostly used by ad-hoc scripts but worth tightening. Fix
  direction: prefer the API's total-count header over inferring from page
  size.

- **Phase 4 `PHASE4_MAX_ITEMS` truncation drops items without listing them.**
  [scripts/bootstrap-from-apis.ts:979-982](../../scripts/bootstrap-from-apis.ts#L979-L982).
  `slice(0, maxItems)` is a deliberate cap, but the dropped handles aren't
  recorded anywhere. Fix direction: emit the dropped policy/asset pairs to a
  summary file for operator follow-up.

- **`scripts/verify-handles.ts` returns `[]` on Koios batch failure mid-run.**
  [scripts/verify-handles.ts:144-156](../../scripts/verify-handles.ts#L144-L156).
  Verifier reports "no stale handles in this batch" when really it couldn't
  reach Koios. Fix direction: collect failed batch ranges and report them at
  exit as `unverified handles: [ranges]`.

## Tier 3 — Bigger refactors / open questions

Defer until the area is being touched for another reason, or until the
operator wants a dedicated correctness sprint. These need product input or
ripple across multiple subsystems.

- **End-of-phase reconciliation in `bootstrap-from-apis.ts`.** No phase
  asserts `expected_in_count === actual_out_count` against a known-good
  source (Koios policy-asset count, on-chain MPT root). Adding this would
  catch the Tier 1 bootstrap findings *and* future regressions. Larger
  scope: changes phase return shapes and the snapshot writer's exit
  conditions.

- **`GHOST_HANDLES` is a static hardcoded array per network.**
  [utils/snapshotVerification.ts:18-21](../../utils/snapshotVerification.ts#L18-L21).
  If a ghost is removed/added on chain without a code update, MPT root
  computation silently includes phantoms. Memory notes the
  drift-blind issue was *reduced* on 2026-04-25, not closed. Fix direction
  (large): fetch active ghosts from the minting-data datum at runtime; or
  (small) checksum the static array against an on-chain probe and NOTIFY on
  divergence.

- **Maestro tx-hash → block-hash mapping silently skips unmapped txs.**
  [lambdas/scanner.app.ts:1268-1271](../../lambdas/scanner.app.ts#L1268-L1271).
  A Maestro/Koios divergence drops the tx with `continue` and no log. Worth
  a structured WARN with the unmapped tx hash so the divergence frequency is
  measurable; the larger question (do we trust Maestro at all here, given
  the 2026-05-07 indexing-lag closure was about exactly this provider) is a
  product decision.

- **MPT rebuild source enumeration verification.** Memory: "MPT rebuild
  silent-fail (CLOSED 2026-04-25)" — verify the closure covers
  `scripts/build-true-root.ts` and `scripts/build-api-root.ts` as well as
  the in-process rebuild path. Likely a small audit-lens follow-up rather
  than a refactor.

---

## Posture check — what's right

This sweep is a story of an active correctness program, not a dumpster.
Specifically:

- **The seed bug shape is already partially defended in production.**
  `fetchBlockTxHashBatchWithRetry` (block_txs) implements split-on-413 cleanly
  ([scanner.app.ts:445-457](../../lambdas/scanner.app.ts#L445-L457)). The
  pattern is in the codebase; Tier 1 mostly extends it to peer call sites.
- **Recent commits target this exact failure class.** `dabea7e` (halt on
  incomplete tx_info instead of Blockfrost backfill), `6772557` (halt when
  Koios `block_txs` row count < Blockfrost `tx_count` — same shape, different
  cross-provider edge), `df30eeb` (orphan-anchor fix, 2026-04-25), `29bafba`
  (the bootstrap inner-413 fix that closed the original seed anomaly), the
  MPT rebuild silent-fail closure, GHOST_HANDLES drift reduction. The team is
  iterating on silent loss specifically — the audit's job is to surface the
  remaining sibling shapes, not introduce a new philosophy.
- **Logging is observable.** `Logger.local` breadcrumbs are present at most
  loop boundaries; the gap is enforcement (asserting counts, halting on
  mismatch), not visibility.
- **Dual-scanner architecture is intentional.** The local Ogmios bugs
  (Tier 1 items 4-5) affect community Docker users; production runs on the
  Lambda scanner where the equivalent paths are tighter.
- **The hard scanner deadline + lease pattern is doing real work.** It
  prevents stuck-on-rolled-back-block hangs and forces forward progress.
  The Tier 2 finding about pipeline-flush-vs-deadline is about tightening
  the boundary, not redesigning it.

## Sources

Five Explore-agent dispatches at 2026-05-07. Detailed findings (raw,
pre-synthesis) are in the session transcript. This document is the durable
record; tiers reflect verification of agent claims against the actual code,
not the agents' raw severities.
