# Mainnet provider/deadline continuation after PR262

## Delivered boundary

PR262's guard tree actually serves MAINNET as `cf7a621baae58d427c94bc0222ee4619decd5506` through Actions39141735008, trigger6ab6302a-4e21-4651-a0d5-47fd066dc1ff. Both natural scanner images, root/search/health contracts, unchanged function controls and forward index progress are recorded in `tmp/api-mainnet-release-20261018/`. The original paused-scanner business goal remains currently recovered. That does not erase the already demonstrated provider/deadline defects deliberately excluded from PR262.

This continuation starts directly from that fresh mainnet cf7 source, preserved at `preserve/api-mainnet-cf7-20261018`. It applies only the15 selected provider/deadline/redirect/test/doc paths from verified PREPRODc924, without merging environment history or reverting mainnet-only CI/readiness work. No package, lock, SDK, schema, network selection or contract/settings/signing/value change is included.

## Remaining changes classified against actual mainnet

All four runtime areas below fix established unsafe behavior present in cf7, not optional Demeter design or a new paused-state diagnosis. Actual mainnet uses Blockfrost scanning, but these paths still use Koios transaction/datum/asset reads and Blockfrost fallback/metadata. Helpers and limiter bytes at cf7 exactly match pre-fix mainnet35; the scanner pool/fallback implementations remain the corresponding old versions.

### 1. Future provider waits can outlive the Fn budget

- **Failed:** a valid hour-long provider hold can become an owned timer instead of refusing this invocation; expired scanner work can start fresh fallback reads.
- **Why:** the existing240s scheduled budget checked now, not the proposed future start/end of provider/pacing/backoff waits. Deadline exceptions were ordinary errors and could become fallback.
- **Enabling condition:** a long Retry-After, exhausted work budget or ordinary wrapper adoption crosses the owned callback boundary.
- **Root-cause correction:** evaluate the maximum future floor before sleeping and again on wake, retain the provider floor when refusing, and propagate structural `REQUEST_DEADLINE_EXCEEDED` through actual fallback/read boundaries. Provider waits are never shortened to fit an invocation.
- **Existing evidence:** accepted `final-api-4ce75-independent-review.md` and bound artifacts under `kora-bot/tmp/app-alert-repair-20261015/` retain old deadline failures (3600100ms lifetime and BF transaction/UTxO/datum reads after expiry), plus meaningful controls. The selected admission/deadline and local scanner-budget tests exercise these invariants. No live provider-quota experiment is needed.

### 2. Native redirects hide the first response and can replay a POST

- **Failed:** native fetch follows302/307 before shared admission sees the first headers/body; the original hold/status can disappear and a Location request or POST replay occurs early.
- **Why:** both actual producers used implicit fetch redirect-follow.
- **Enabling condition:** a provider returns a redirect, including a header/body-only wait or a307 for Koios POST.
- **Root-cause correction:** use `redirect:'manual'` at both actual producers, preserve first response fidelity and register applicable headers before wrapper adoption/body extension. Separate process-lifetime provider states use the same parser/admission code. Unthrottled redirects do not invent waits.
- **Existing evidence:** native loopback transport controls retain10 old-producer failures with4 positive controls and14 fixed cases in the accepted final4ce review. These tests preserve actual fetch options/method/body, scrub fixture credentials and assert zero Location dispatch; they do not contact a real provider.

### 3. Failed pools can release ownership while started work is still active

- **Failed:** transaction/datum/rollback-asset work can continue after its caller has failed, admit queued work against a later invocation's budget, or leave an unhandled rejection.
- **Why:** early Promise rejection and the installed common helper's delayed callback observation did not stop admission and drain all started reads before outer lease cleanup.
- **Enabling condition:** first failure or deadline arrives while another read is held/queued.
- **Root-cause correction:** immediately capture first failure, stop later admission, keep the original failure, and await every started worker before rethrowing. Preserve the installed helper/API and token-conditional lease behavior; do not change its package or replace it with a new architecture.
- **Existing evidence:** the accepted nine pool controls and old asset failures retain unhandled-rejection, four-vs-one dispatch and premature-return defects. Local entrypoint tests assert persisted index/root/ledger/head state, actual lease PTTL during a held read, PTTL=-2 after cleanup, and immediate reentry before TTL. No production lease or scanner invocation is used.

### 4. Provider failures must not become fabricated/missing-data success

- **Failed:** failed or missing script-language metadata can become invented V2; non404 transaction metadata failures can return stripped success.
- **Why:** broad fallback/absence handling conflated a genuine CBOR404 with failed authority metadata and swallowed typed budget failures.
- **Enabling condition:** CBOR bytes exist but language lookup fails, or transaction metadata/read budget fails.
- **Root-cause correction:** retain genuine CBOR404 absence, require real language once bytes exist, preserve V3, and propagate non404 metadata/deadline failure instead of inventing data. This is chain-read correctness/error propagation, not a validator or transaction-building change.
- **Existing evidence:** accepted full helper/fallback tests and native deadline controls cover V3, language404/failure, genuine CBOR404, metadata failure and structural cross-module deadline identity.

## No optional/environment redesign hidden in the port

The selected15 paths contain four runtime areas (`scanner.app.ts`, helpers, limiter, typed deadline), their existing regression tests and three accurate self-hosted runtime/PRD/spec updates. No Demeter resume threshold, batch policy, quota, concurrency limit, scanner source control, recovery action or on-chain state is changed. Existing coverage pauses and ordered complete-block cursor application are retained. Mainnet-only unit CI and PR262's documentation/history are not overwritten by PREPROD files.

This source candidate preserves the served cf7 graph/evidence and original PR259/260/261/262 lineage. The exact continuation gets focused tests first, then its complete local unit/e2e/native/types suite and normal unit-only PR CI. PREPROD acceptance is reused as bounded existing evidence, not relabeled mainnet serving. No second deployment dispatch is part of preparation. No import/reindex/sideload, manual scanner, production lease write, root/settings/signing/burn or financial-app action is permitted or performed here.
