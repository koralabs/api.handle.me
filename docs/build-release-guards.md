# Locked builds and release boundaries

## Failure and root cause

The API compiler and shipped runtime previously used different dependency graphs. `build:lambda` installed an unlocked `rollup.package.json` graph inside `dist`; that manifest also advertised version 1.14.6 while the root package/lock were 1.14.8. Registry changes could therefore change a release without changing the root lock. Upstream deployment tooling also invokes a shared sibling-source fallback before installing dependencies, so the checked-out source and root lock did not necessarily describe the compiler inputs.

The root-cause correction here is one dependency authority: the committed root `package.json` and npm v3 `package-lock.json`. The current lock resolves `@koralabs/kora-labs-common` to registry version 6.9.3 with integrity verification. No sibling source is accepted by the build lock guard. This does not prove that a separately fetched deployment helper is immutable or safe.

## Build contract

Run `npm run build:lambda` from a release checkout with absent or empty `dist`. The driver:

1. Refuses nonempty output before installing or writing anything. It never deletes existing artifacts; preserve them outside the output path before building again.
2. Rejects local/sibling links, non-registry package sources and missing integrity hashes in the root lock.
3. Runs `npm ci --include=dev` at the root, replacing the installed dependency graph with the locked compiler graph. This intentionally discards linked packages in `node_modules`.
4. Runs the locally installed Rollup binary, without an `npm exec` download fallback.
5. Copies the root manifest, root lock and Swagger document into `dist`, then runs `npm ci --prefix dist --omit=dev`. Runtime versions and overrides now come from the same lock as the build, rather than a second manifest.

Every stage fails closed; there is no floating install or sibling fallback in this driver. The legacy `rollup.package.json` is no longer consumed. Build output is not byte-for-byte reproducibility proof: platform-specific dependencies and deployment metadata still vary. Do not run this build over evidence-bearing ignored output or an actively used local dependency tree.

## Required sibling coordination — release remains blocked

Sibling implementation and activation status (parent-coordinated):

- The API workflow pins published `adahandle-deployments` commit `2b2b8350f59054a28aee6cd59ffa04253261425a`, merged canonically through deployments PR28 (`7c689a267f824537fd42c45ab30d8a888c56a8c1`). The producer uses `build-koralabs-deps.sh` for lock validation only, not mutating sibling-source fallback. The API workflow supplies `SERVICE_INSTALL_CMD: npm ci --include=dev` and fetches only `service-fn-push.sh`. The producer fetches missing validation, `runtime-versions.sh` and `box-deploy.sh` helpers from the same immutable base. This supersedes the earlier b827d5a pin: PREPROD Actions39088695416 failed before staging/trigger because that validator mistook published registry packages' workspace metadata for local workspace inputs. The corrected validator rejects workspace declarations at the root/manifest and still requires registry HTTPS/integrity/version records with no local links. The legacy `adahandle-deployments/handles-api/build.sh` needs equivalent provenance review if retained as a release path.
- Parent reports `kora-self-hosted-apps` commit `80eda5dde534bc2bf0db4d3d4c10bf84c303a18f` removes the automatic detached sideload launch from `bootstrap/deploy/fn_push_apply.sh`, with process-boundary tests for **preview, preprod and mainnet**. This is source-complete, **not activated**; this API task has not deployed or independently run those sibling tests. Release health must not trigger REIMPORT/REINDEX, namespace clearing, or another mutating recovery operation. Keep any separately authorized recovery an explicit operator operation, not a deployment side effect.
- The API workflow pins `DEPLOY_FETCH_BASE` literally to `https://raw.githubusercontent.com/koralabs/adahandle-deployments/2b2b8350f59054a28aee6cd59ffa04253261425a/common`, not a mutable repository variable. The inherited base pins the producer's helper fetches too. Source review and this pin are not activation or permission to deploy, change sibling helpers, or invoke sideload even in detect mode.

The all-environment release/recovery separation is a root-cause fix to the deployment lifecycle, not a recovery mechanism. It does not make valid imports crash-atomic or resolve the separate snapshot admission/CAS work described by A5.2 in `kora-bot/tasks/app-alert-recovery/TASK_STATE.md`.

## Focused offline verification

`python3 shell/build-lambda.test.py` executes the real build driver and Node lock guard with a fake package-manager/process boundary in temporary fixture directories under `/tmp`. It verifies locked install commands, generated runtime metadata, empty-output handling, preservation/refusal for existing artifacts, sibling/unverified lock rejection, and propagation of compiler/runtime install failures. The test docstring describes negative controls. It does not install packages, build the actual application, access the network, touch Redis, or execute a deployment. `node shell/check-build-lock.mjs` additionally validates the actual checked-in lock without changing it.

`node --test .github/scripts/test-deploy-build-contract.mjs` parses the actual workflow and executes its deployment shell against fake network/package-manager boundaries for preview, preprod and mainnet. It proves the locked install command reaches the producer, only the producer is fetched from the approved immutable URL, the producer inherits the same base, and a failed fetch cannot install or execute deployment. Restoring floating installation, the sibling fallback fetch or a mutable base breaks the command/fetch assertions. It does not independently validate the private producer or fetch any remote source.

The parent owns full-suite integration and the `docs/index.md` link to this document. Actual bundle/runtime validation and sibling release-hook tests remain required before promotion; the focused driver tests do not replace them.
