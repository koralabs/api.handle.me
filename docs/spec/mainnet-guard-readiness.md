# Target-specific mainnet snapshot and release guards

This is the preserved PR262 guard-release assessment (a0bbfbc → actually served cf7). The deliberately excluded provider/deadline work is tracked separately in [Mainnet Provider Continuation](./mainnet-provider-continuation.md); the historical exclusion below is not a claim those known defects were fixed by PR262.

## Baselines and preservation

This candidate is based on fresh mainnet source `35c2903ae4dc451fe977d701051ddd3c53629051`, not an environment merge. The previously verified PREPROD release `c9248cae532aa1bc947e856daf919836689ee652` remains reachable through `preserve/api-preprod-c924-20261018` and the preserved previous checkout branch. Only the reviewed snapshot/ownership/legacy-bootstrap/build/helper-pin commits were ported. PREPROD's separate provider-deadline/redirect changes are deliberately not included.

Fresh BOTH-box read-only observations on 2026-10-18 still bind the actual served mainnet release to `68d2efd1e5ee2705e591c2f3783e115517f26f59`, version1.14.7/build38188920717-1. Naturally running scanner images on both expose identical stable37-module graphs with that metadata. Source35 is therefore **not serving**. Its30 previously merged paths are part of any future served68 release exposure, even though this candidate does not reimplement them.

## Current operation, not another paused-scanner fix

Both boxes currently index at chain tip with266015 handles,67426 holders and schema1/1. Natural `scan_done` events continue on both, including after the historically offending block/transaction-coverage pause slots. The original paused-scanner business goal is currently recovered; neither an old failed repair queue nor historical WARN cards justify another paused-state fix.

Both mainnet `/mpt-root` responses return HTTP200 and `verified:true`, with equal calculated/indexed-datum/provider root `b823d4d712edfb212bea87404f99337272d6e0137a730ee705afdad1803bc02b`; sampled provider tip200770762 is at or beyond indexed200770729. Bounded search and direct handle reads succeed identically on both.

Current coverage-pause WARNs still occur and are correctly retained, not suppressed. The bounded Oct18 sample contains block_txs pauses SFO11/RDM4 and tx_info pauses SFO11/RDM15; these are not exhaustive daily counts. The logs tool also returned old Sep24 `_unrouted` lines despite its days selector; only actual Oct18 timestamps were classified as current. No current ERROR/FATAL/crash/Valkey/index/search failure was observed in this sample, not a zero-error guarantee.

The retained reporter lookup from existing handle.me issue1264 also succeeds on the old served API: both `/handles/drep%40brock` and the exact enterprise-holder query return `drep@brock`, its default-handle field and complete CIP105/CIP129 DRep metadata. API issue240 remains the default-route/burn report; these lookup results do **not** close original wallet construction/submission or prove a signed burn. No API release is needed merely to expose that already served DRep record. API issue124's address-only/no-id_hash enhancement is separate.

## Why this source candidate still exists

The live compiled loader still clears a namespace before fetching/validating a candidate and lacks original-image admission and transaction fencing. That is the known A5.2 latent destructive producer, even though no import is currently needed or authorized. This candidate ports the already PREPROD-served correction, not a new scanner recovery mechanism:

- Validate the entire candidate and publisher-root metadata before mutation; reject malformed or unbound resume progress intact.
- Compare original metrics/progress images before admission, bind actual scanner ownership, and fence loader transactions.
- Preserve control keys and stop legacy bootstrap/recovery from converting refusal into destructive reset.
- Compile and package from the root lock, prohibit sibling compiler inputs, and pin the published deployment helper `2b2b8350f59054a28aee6cd59ffa04253261425a`.
- Run the existing unit-only CI job for mainnet-target PRs too; local integration/native transaction tests remain local, never Actions.

See [Snapshot Admission and Ownership](./snapshot-admission.md) for the precise non-attestation/non-generation boundary. The candidate does not upgrade the shared SDK or change the committed lock from source35.

## Full served exposure and safety classification

The review boundary is served68 → source35 → this exact candidate, not just this PR's diff. A blob-bound inventory is retained in `tmp/api-mainnet-readiness-20261018/source-exposure-final.json`.

The30 already merged served68→source35 paths include marketplace **read/index** routes/models/repository logic and Swagger/docs, discovery of deployed marketplace validator hashes from stored CBOR, dependency-security overrides/lock entries, scanner budget/provider admission and tests, and unit-only CI selection. None edits a validator, on-chain settings/datum, signing key, transaction builder/submission or value-transfer action. Deriving a hash from existing validator CBOR for read-side filtering is not changing that validator.

New target-specific paths are snapshot validation/cache ownership and lifecycle, scanner ownership registration, locked build/workflow tooling, regression tests and documentation. There are no contract/settings/signing/burn/value changes. This does not claim that all read-side source changes were already served: the inherited marketplace/security source remains a real part of the future release exposure.

## No forced recovery on normal release/startup

Fresh BOTH mainnet function controls retain `UTXO_SCHEMA_VERSION=1`, `INDEX_SCHEMA_VERSION=1`, `KORA_SCANNER_DEFER_IMPORTS=true`, disabled KMS and the existing chain source, function IDs, timeouts and memory. Those controls and environment definitions are unchanged by this candidate. Existing indexed schema/current point already satisfy normal startup; no version bump requests import or reindex. Scheduled heavy work remains deferred, including the reindex shortcut. HTTP bootstrap remains read-only in its normal Lambda mode; the corrected legacy Ogmios path is not a new automatic importer.

Canonical infrastructure23c2e8e1 includes no-auto-sideload80eda5d. The normal PREPROD Actions39088893996 vehicle installed that code and the observer/restarted receivers on both, independently confirmed by the infrastructure owner. No API candidate dispatch, import/reindex/sideload, manual scanner, lease write, settings/root write or signed transaction is authorized or performed here. A normal source release is not permission to execute any of them.

## Verification and disposition

The selected guards already have BOTH-box served PREPROD proof at c9248ca: current health/progression, identical37-module graphs and root-lock/installed-version provenance. This target separately requires its actual focused/full local tests and normal PR CI; PREPROD is not relabeled mainnet. Existing PR259/260/261 and the original incident identities remain the history. Parent assesses this exact ordinary-risk source candidate and complete served exposure before any merge/release decision. No mainnet dispatch occurs as part of preparation.
