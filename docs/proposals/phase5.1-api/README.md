# Phase 5.1 API contract and enclave proposal

**DRAFT / NOT ACTIVATED / UNMERGED PENDING PER-REPO HUMAN REVIEW. Do not install or merge unattended. Phase 5 is not complete.**

- [Proposed canonical contract](./CANONICAL_CONTRACT.md)
- [Candidate enclave manifest](./.enclave)
- [Existing documentation index](../../index.md)

## Scope and source

API-only documentation/policy proposal, following handle.me #1304's nested-draft pattern (`docs/proposals/phase5.1-handle-me/`). Grounded in fresh mainnet `235233f0d0c3e7038e9d3f07f3a23b0cac140b91`, whose application code matches the inspected checkout. No runtime, parser, merge enforcement, CI/source preparation, coverage, infrastructure, payment, signing, validator or settings edits. No AGENTS.md/CLAUDE.md edits. No root policy is installed. No deployment or production request is needed.

The ecosystem plan (`kora-bot/v3/docs/ecosystem-ownership-plan.md`, Phase 5) explicitly requires individual human review. Historical proposal closures do not constitute adoption. This is not an ecosystem-wide completion or policy rollout.

## Proportional protection

The candidate has 19 exact root-relative paths: 17 current implementation files and two future adoption destinations (`.enclave`, `CANONICAL_CONTRACT.md`). No wildcard or directory freeze. The contract explains each boundary and links existing behavioral tests:

- Name/hex lookup and resolved recipient: exact route, controller, repository and error boundary.
- Chain properties and address conversion: exact Ogmios/Demeter decoders, provider conversion helper, policy decoding and repository projection.
- Cache, scanner progress and recovery: exact store/key definitions, scanner orchestration, rollback utility, chain/snapshot evidence validators, ownership registry and worker transaction implementation.
- Future policy self-protection: only the two future root files, not all documentation.

Repository/controller/scanner/helper/store files contain mixed responsibilities, so an ordinary edit within one protected file would require review after adoption. Human reviewers must accept or narrow that cost. No speculative extraction or broad freeze of controllers/services/UI/infrastructure/tests is bundled. External common-library codecs and dependency versions remain a transitive review limitation, not a claim of complete protection.

## Actual parser and merge policy

Inspected `kora-bot/v3/src/_enclave.py::{EnclaveManifest,load_manifest}` and `v3/src/tools/merge_pr.py::MergePRTool`:

1. One exact file per line; a trailing `/` means directory prefix. Blank lines and full-line `#` comments are ignored. No glob, exclusion, inline-comment or DRAFT directive exists. Candidate paths are repository-root-relative despite the nested storage location.
2. Active locations are `v3/.enclave`, then root `.enclave`. This nested candidate is not discovered. **Location prevents activation; a DRAFT comment cannot disable a manifest installed at an active location.**
3. Merge policy fetches the manifest from the authoritative target/base revision, not the agent checkout or PR head. A failed HTTP retrieval is not permission to treat policy as absent. Current and previous filenames are matched, so renames remain gated.
4. Default protected branches are master/main/mainnet/preprod, not preview. Caller overrides are rejected. Auto-merge does not bypass enclave review; agent-facing calls cannot self-approve the trusted operator-resume boundary.
5. The first installation cannot protect itself through the new manifest because the base lacks it. Explicit per-repo human review of the exact installation diff is required independently of the existing tool gate.
6. This is K.O.R.A.'s merge-tool policy, not a new GitHub branch rule or a universal block on direct CLI/API/admin merges. No new enforcement service is installed. Local loader unreadability behavior is not equivalent to the authoritative merge-time HTTP failure behavior.

## Validation and limitations

Existing tests only, with actual runtime behavior and real parser, no source-text change-detector tests:

- 233 passed across six API suites: actual HTTP route behavior, repository branch/status behavior, Ogmios block/lifecycle, snapshot admission and verified-snapshot rejection. Command: `npm run test:unit -- routes/handles.route.test.ts repositories/tests/handles.repository.branches.test.ts services/ogmios/tests/processBlock.unit.test.ts services/ogmios/tests/service.lifecycle.test.ts stores/redis/snapshotAdmission.test.ts utils/verifiedSnapshot.test.ts --coverage=false`.
- 13 provider conversion/stream and policy-decoding behavioral tests passed in two additional suites. Storage lifecycle/block e2e tests are inspected anchors, not claimed as newly executed; no integration harness, browser journey or production operation is required for this documentation-only change.
- 36 existing bot tests passed: test_enclave.py, test_merge_manifest_http.py and test_merge_pr_auto_merge_gate.py. Pytest emitted pre-existing deprecation/temporary-directory cleanup warnings; no cleanup or bot edits were made.
- Candidate validation uses the real EnclaveManifest: every implementation path exists in the exact base tree; address/scanner/cache paths match; unrelated UI/docs/workflow paths do not; previous-name matching survives a protected rename; removing a critical entry and adding a blanket services prefix each fail the corresponding negative control. Nested-only files do not become active root policy.
- Local receipts: `/tmp/api-phase5-proposal/{anchors,provider-anchors,merge-gates,candidate-check}.log`. These are proposal review receipts, not rollout/coverage evidence.

Existing limitations are explicit in the contract: this read/index service cannot prevent on-chain double issuance; possible duplicate mint evidence is logged and recorded. Slot freshness/status is not global atomic single-slot isolation. Shared codecs are outside this path policy. Do not silently turn these observations into claims of proven safety or unrequested runtime changes.

## Human decisions before any adoption

Review the exact PR head/diff, then decide:

1. Are recipient correctness, chain-faithful projection, honest partial/lagging reads and non-destructive verified recovery the intended API invariants?
2. Accept/narrow the 19 exact paths and mixed-file review costs. Decide whether transitive dependencies or stronger cross-read slot guarantees need a separate implementation proposal.
3. Which environment branches should eventually receive root policy? Preview is not currently covered by default bot merge gating; changing that server-owned policy is a separate tested bot change.
4. Approve a separate exact root installation/index-link diff after review, not merely publication of this draft. No instruction-file edits are part of this proposal. Do not infer adoption from green checks or permission to create the PR.

Until then, retain both candidate files here, keep this PR draft/unmerged, and leave Phase 5 open. Approval to merge policy never authorizes payment/signing/validator/settings/chain actions.
