# Anomaly Sweep — api.handle.me — 2026-04-24

## Context

Broad anomaly sweep across the whole project, no single seed anomaly —
user asked for a catalogue of weird stuff accumulated on
`release/1.14.0`. Five orthogonal dimensions dispatched in parallel:

1. Duplicate implementations
2. Dead code and orphans
3. Config/env coherence
4. Architecture anomalies
5. Shell/language boundary confusion and stale artifacts

Each agent's raw list was cross-verified before inclusion here; several
high-severity claims were downgraded or dropped after spot-checks (see
**Dropped findings** at the bottom).

Findings are organized **by cost-to-fix**, not by dimension. Each
entry cites `file:line` so the doc doubles as a punch list.

---

## Tier 1 — Broken now or bug-class, <1hr each

- [x] **`build:docker` calls a script that doesn't exist** —
  [package.json:21](../../package.json#L21) runs
  `npm run build:production`, but no `build:production` script is
  defined. `npm run build:docker` will fail with "Missing script"
  before `docker build` is reached.
  **Impact:** local docker builds are broken. Production flow uses
  `build:lambda`, so this wasn't caught.
  **Fix direction:** either add a `build:production` target (likely a
  rollup config for Express that emits `dist/express.js`) or change
  `build:docker` to invoke the actual build steps inline.

- [x] **Container entrypoint expects `dist/express.js`, but nothing
  builds it** — [shell/entrypoint.sh:91](../../shell/entrypoint.sh#L91)
  runs `node express.js` from `/app` (populated by
  [Dockerfile:5](../../Dockerfile#L5) `ADD ./dist/`). Only
  `rollup.lambda.config.js` exists; there's no rollup/tsc target for
  Express. Same root cause as the `build:production` miss — if the
  docker build were runnable today, the container still wouldn't start.
  **Fix direction:** add the Express rollup target, OR switch the
  container entrypoint to run `tsx express.ts` (matching the
  `npm run api` flow) and drop the build step entirely.

- [x] **`shell/install.sh` has no shebang but uses bashisms** —
  [shell/install.sh:1](../../shell/install.sh#L1) begins with
  `set -eu`, not `#!/bin/bash`. Uses `[[ ... ]]` and `declare -a`
  (lines 7, 24–25). Invoked in the Dockerfile as `./install.sh` with
  `SHELL ["/bin/bash", "-c"]`, so today it executes under bash via the
  parent `RUN` shell — but a shebang-less script is a portability trap
  and will fail if ever invoked via `sh install.sh`, execve from a
  non-bash parent, or if someone drops the `SHELL` directive.
  **Fix direction:** add `#!/bin/bash`.

- [x] **`deployment_info.json` is a frozen 2023 placeholder** —
  [deployment_info.json](../../deployment_info.json) is literally
  `{"version":"0.0.1","build":"0","commit":"unknown_hash","timestamp":"2023-01-01T00:00:00Z"}`
  and is `ADD`ed into the container image. If anything reads it at
  runtime (health endpoint, telemetry), the reported deployment
  metadata is wrong for every image built since 2023.
  **Fix direction:** generate at build time in the GitHub Actions
  workflow (git SHA, ISO timestamp, package version); keep the file
  out of source or template it.

- [x] **`ORIGIN` / `CORS_ORIGIN` naming collision in config** —
  [config/index.ts:9](../../config/index.ts#L9) exports `ORIGIN` but
  reads `process.env.CORS_ORIGIN`. `site.env` documents both names.
  Low bug-potential but high future-confusion.
  **Fix direction:** rename the export to `CORS_ORIGIN` and remove the
  `ORIGIN` alias from `site.env`.

- [x] **`verify-handles.ts` reads undocumented env vars** —
  [scripts/verify-handles.ts:36-58](../../scripts/verify-handles.ts#L36-L58)
  reads `API_BASE`, `MAX_HANDLES`, `START_SLOT`, `SCANNER_REPAIR_URL`,
  `SCANNER_REPAIR_API_KEY`; none of these appear in `site.env`.
  AGENTS.md requires `site.env` to document env vars.
  **Fix direction:** add the five entries to `site.env` with
  placeholder values and defaults.

- [x] **`NETWORK` default drifts between entry points** —
  [scripts/verify-handles.ts:35](../../scripts/verify-handles.ts#L35)
  and `scripts/endpointTimings.ts`, `scripts/lambdaStressTest.ts`
  default to `mainnet`;
  [scripts/compareLocalToLive.ts:13](../../scripts/compareLocalToLive.ts#L13)
  and `scripts/compareApiToKoios.ts` default to `preview`;
  [services/ogmios/ogmios.service.ts](../../services/ogmios/ogmios.service.ts)
  fallback is `preview`; [Dockerfile:2](../../Dockerfile#L2) hardcodes
  `mainnet`. Running a local script without `NETWORK` set hits the
  wrong network half the time.
  **Fix direction:** pick one project-wide default (likely `preview`
  per the test suite's convention), codify in
  [config/index.ts](../../config/index.ts), remove all per-script
  fallbacks.

## Tier 2 — Structural cleanup, 2–8 hrs each, scoped

- **Hardcoded `GHOST_HANDLES` (known integrity gap)** —
  [utils/snapshotVerification.ts:13-16](../../utils/snapshotVerification.ts#L13-L16)
  bakes in `mainnet: ['watchman@ngmerchs']`, `preview: ['dynamo2@ai']`.
  This is already tracked as a known drift-blind constant; the
  anomaly sweep confirms it's still there. Any new ghost handle
  requires a code change + redeploy.
  **Fix direction:** move to config, sourced from env or a
  per-network JSON file loaded at boot. Allow runtime override.

- **Hardcoded Cardano era boundaries per network** —
  [config/constants.ts:8-25](../../config/constants.ts#L8-L25)
  hardcodes mainnet slot 48194528, preview 1470343, preprod
  commented-out. Any network upgrade requires a code change.
  **Fix direction:** move to site.env or per-network config file.

- **Lambda entrypoints mutate `process.env` as a side effect** —
  [lambdas/api.app.ts:4](../../lambdas/api.app.ts#L4),
  [lambdas/scanner.app.ts:60](../../lambdas/scanner.app.ts#L60),
  [lambdas/snapshot.app.ts:11](../../lambdas/snapshot.app.ts#L11)
  all do `process.env.ENABLE_OGMIOS_SCANNING = 'false'` at module
  scope, relying on import order to beat
  [app.ts:102](../../app.ts#L102)'s `initializeOgmios()` check. Works
  today, fragile forever.
  **Fix direction:** pass `{ disableOgmios: true }` to the App
  constructor or an `initialize(options)` method; stop using env-var
  assignment as a cross-module signal.

- **Direct `new RedisHandlesStore()` in scripts, lambdas, and utils** —
  [scripts/deleteHandlesIndex.ts:5](../../scripts/deleteHandlesIndex.ts#L5),
  [lambdas/snapshot.app.ts:111](../../lambdas/snapshot.app.ts#L111),
  [lambdas/snapshot.app.ts:227](../../lambdas/snapshot.app.ts#L227),
  [lambdas/scanner.app.ts:11](../../lambdas/scanner.app.ts#L11) (with
  a self-aware "I hate this" comment),
  [utils/snapshotVerification.ts:19](../../utils/snapshotVerification.ts#L19),
  [utils/snapshotVerification.ts:172](../../utils/snapshotVerification.ts#L172).
  Controllers go through `req.app.get('registry').handlesStore()`;
  everything else improvises.
  **Fix direction:** export a single factory in
  [ioc/](../../ioc/) or attach store to a shared context object
  passed into script/lambda entry points.

- **Per-request `HandlesRepository` instantiation in ~19 controller
  methods** —
  [controllers/handles.controller.ts:59,124,145,164,209,232,262,308,360,404,428](../../controllers/handles.controller.ts)
  plus all other controllers. Identical
  `new HandlesRepository(new (req.app.get('registry') as IRegistry).handlesStore())`
  boilerplate. Tests can't mock it; nothing else can substitute.
  **Fix direction:** add a `handlesRepository()` factory to the
  registry (or a one-line middleware that attaches it to `req.locals`)
  and replace the inline construction.

- **`dotenv` hydration inconsistent** — jest configs use
  `dotenv.config({ path: '.env' })`
  ([jest.config.ts](../../jest.config.ts),
  [jest.e2e.config.ts](../../jest.e2e.config.ts),
  [jest.critical.config.ts](../../jest.critical.config.ts)); scripts
  use `import 'dotenv/config'`. Different hydration timing can mask
  bugs between test and script runs.
  **Fix direction:** standardize on `import 'dotenv/config'`
  everywhere.

- **`site.env` mixes runtime app vars with container/shell vars** —
  roughly 18 entries (`MODE`, `DISABLE_NODE_SNAPSHOT`, `NODE_DB`,
  `SOCKET_PATH`, `CARDANO_NODE_PATH`, `CARDANO_NODE_VER`, etc.) are
  only read by shell scripts; mixing them with app-runtime vars makes
  the file hard to reason about.
  **Fix direction:** split into labeled sections in the same file (a
  `# --- container/shell only ---` banner), or separate
  `site.env.app` + `site.env.container`.

- **`Router.ts` handler instantiates `HandlesController` directly** —
  [routes/handles.route.ts:5](../../routes/handles.route.ts#L5) does
  `new HandlesController()`. Every other dependency in the project
  flows through the registry; this one bypasses it.
  **Fix direction:** resolve from registry at route-register time.

## Tier 3 — Bigger refactors, 1–3 days each

- **`lambdas/scanner.app.ts` re-declares 780+ lines of business
  logic** — state machine, lease management, rollback/reindex paths
  all live in the Lambda entrypoint, not in
  [services/ogmios/](../../services/ogmios/). The scanner can't be
  unit-tested outside the Lambda runtime, and any fix has to be
  duplicated if the Express path ever re-enables scanning.
  **Fix direction:** extract a `services/scanner/` module that owns
  the state machine; reduce `lambdas/scanner.app.ts` to orchestration
  (init, handler shape, lifecycle glue).

- **Three TypeScript entry points with overlapping boot ceremony** —
  [app.ts](../../app.ts), [express.ts](../../express.ts),
  [express.app.ts](../../express.app.ts) plus Lambda wrappers. Boot
  order and middleware registration differ across them; the dynamic
  middleware loader ([app.ts:81-84](../../app.ts#L81-L84)) runs at an
  unspecified time relative to IoC binding, which is the root cause
  of the "set env before import" dance in the Lambda wrappers.
  **Fix direction:** one `bootstrap({ mode })` function, called by
  each entry point with different flags. Explicit middleware order
  (cors/compression/auth first, dynamic loader last, error middleware
  always last).

- **`OgmiosService` constructed in `app.ts` but never bound to the
  registry** —
  [app.ts:121-122](../../app.ts#L121-L122) creates it and hangs on to
  the instance locally. Services that need scanner state have no
  canonical way to get it from the registry. Couples into entry-point
  shape.
  **Fix direction:** register into the IoC after init; fold into the
  `bootstrap()` refactor above.

---

## Posture check — what's right

Not a dumpster; it's a production API accumulating quirks:

- **Helios migration is done in this repo.** The `@hyperionbt/helios`
  migration noted in project memory left no stragglers — no imports,
  no dead tx-building paths. Any remaining helios work lives in
  sibling repos.
- **No helios/cardano-sdk duplicate tx builders in this tree.** The
  duplicate-implementation sweep turned up none of the feared forked
  code paths.
- **`dist/`, `coverage/`, `node_modules/` are properly gitignored.**
  No tracked build output; no stray editor backups; no `.DS_Store`
  pollution.
- **`.env` is gitignored; secrets live outside source control.** The
  real-values-in-site-env violation one agent flagged was a
  misreading of the local `.env` (which is supposed to hold real
  values).
- **Safety-rule compliance in scripts.** No writes to port 6379 from
  scripts; temp files go to `/tmp` per AGENTS.md; test-infra scripts
  use port 6380 consistently.
- **Recent middleware cleanup stuck.** The "Remove response
  middleware that overwrote /utxo script field" fix (commit b62003e)
  didn't leave orphan middleware slots behind; the architecture audit
  didn't resurface it.
- **Controllers are consistent.** Every controller method follows the
  same shape (registry → store → repository → call). The boilerplate
  is annoying, but it's at least *uniform* annoying, which makes the
  Tier 2 fix straightforward.
- **Tests are structured.** Three jest configs (unit / e2e /
  critical) with real Valkey via `local_valkey.sh` on port 6380. No
  mock-the-DB shortcuts surfaced.
- **Scanner recovery terminology respected.** No "rollback recovery"
  / "snapshot reimport" language drift across code paths.

---

## Dropped findings (spot-checked and rejected)

Documenting these so the next sweep doesn't waste dispatches:

- **"sed invocation in entrypoint.sh is malformed"**
  ([shell/entrypoint.sh:89](../../shell/entrypoint.sh#L89)) —
  FALSE. `sed 's https://… http://… '` uses **space** as the `s`
  command delimiter, which is valid. Verified with a live
  `echo | sed` test. The agent assumed `/` was the only legal
  delimiter.
- **"`.env` contains real secrets (violates AGENTS.md)"** — FALSE.
  `.env` is gitignored; it is by design the local real-values file.
  AGENTS.md forbids real values in **`site.env`** (the template),
  not `.env`.
- **"`.kora/executor-logs/` is git-tracked and bloating the repo"** —
  FALSE. `git ls-files` shows zero files under `.kora/`. The
  directory exists locally but isn't tracked.

---

## Next moves

- **Tier 1 is done** (2026-04-24). All seven items applied; `npm run
  build:lambda` produces `dist/express.js` cleanly, unit tests
  unchanged (10 pre-existing `lambdas/scanner.test.ts` failures on
  `release/1.14.0` remain; same count before and after). See commit
  for exact diff.
- **Tier 2 deferred until triggered.** Pick up the Lambda env-var
  side-effect cleanup next time anything in `lambdas/` is being
  touched. GHOST_HANDLES moves out of the hardcoded set the next
  time a ghost is discovered or when
  [project_known_integrity_gaps.md](../../../../.claude/projects/-home-jesse-src-koralabs-api-handle-me/memory/project_known_integrity_gaps.md)
  is opened as part of a correctness pass.
- **Tier 3 is refactor-season work.** Don't do it piecemeal; the
  three items are one coherent bootstrap/scanner-service refactor
  and should land together or not at all.

---

## Provenance

Five dimensions, each dispatched to an `Explore` agent. Agent
summaries were cross-verified against the filesystem before inclusion
here (see Dropped findings). Sweep run on branch `release/1.14.0`
at HEAD `77d3a98` (Document scanned-blocks ledger + delta-based
rollback drift detection).
