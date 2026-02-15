# AGENTS.md

## 1) Role
- Act as a senior software/platform engineer.
- Prefer simple, elegant, maintainable solutions (KISS, YAGNI).
- Be OWASP-aware and call out security concerns when relevant.

## 2) Default Development Style
- Keep implementations minimal and readable.
- Do not over-engineer or add fallback/robustness mechanisms unless explicitly requested.
- Prefer vanilla TypeScript/JavaScript/Python over adding dependencies unless the dependency is a well-known staple and clearly justified.

## 3) Completion Requirements
- A task is complete only when:
  - unit and e2e tests are added/updated, and
  - all relevant tests pass.
- Exception:
  - documentation-only changes do not require tests.
  - files under `/scripts/*` do not require tests.
- Always maintain type integrity.

## 4) Documentation Requirements
- Keep documentation current when behavior changes.
- PRD contains product requirements; spec contains implementation details.
- If a requested feature is missing from PRD/spec, update the relevant document(s).
- Maintain links between docs and `docs/index.md` table of contents.
- Keep Swagger/OpenAPI docs up to date when API contracts change.
- Keep `site.env` up to date for env var definitions (comments, defaults, examples, optionality).
- Do not use `site.env` for real values.
- Ignore `human_notes/notes.md`.

## 5) Code & Comment Rules
- Use idiomatic code; comment only where the "why" is unclear or logic is non-trivial.
- Do not delete comments tagged `IMPORTANT`, comments in all caps, or comments containing `-----` / `*****`.
- In general, do not delete comments unless the commented behavior no longer exists and you edited that area.
- Keep edited comments accurate.

## 6) Operational Safety Rules
- Never write to Valkey/Redis on default port `6379`.
- Reading from `6379` is allowed for troubleshooting.
- If write testing is needed, use a different `REDIS_PORT`.
- Temporary files must be created in `/tmp`.

## 7) Application Flow / Mechanics
- Local dev:
  - `npm run ogmios` starts cardano-node, Ogmios, and Valkey.
  - `npm run api` is the local app entrypoint and starts/resumes scanning.
- Container runtime:
  - `shell/entrypoint.sh` starts the app and supporting services.
- Production runtime:
  - ALB-fronted AWS Lambdas + Valkey.
  - each `/lambdas` file is an entrypoint.
- Scanning must remain synchronous (UTxO order matters).
- API handlers can and should use async concurrency where appropriate.
- Store pipeline batching can defer execution/results; account for this in design and debugging.

## 8) Deployment
- Most deployment code lives in a separate private repo to protect secrets.

## 9) Critical Correctness
- Handle addresses must be correct 100% of the time.
- Handles must never double-mint.
- All handle properties must remain chain-accurate.

## 10) Logging Rules
- Use `Logger.local()` for local-only/noisy troubleshooting.
- Use `Logger.log({ message, category, event })` for operationally important logs.
- CloudWatch subscriptions monitor `WARN`, `ERROR`, and `NOTIFY` and forward to team alerts.
- `WARN` is rate-limited downstream; `NOTIFY` is emergency-level only.
- Do not emit `Logger.log()` inside highly iterative loops unless it is a necessary `WARN`/`ERROR`/`NOTIFY`.
- Do not use raw `console.*` in runtime app paths unless explicitly justified and documented.
- Existing exception: `utils/util.ts` `debugLog` helper is allowed for manual local debugging.

## 11) Sibling Projects
- You may edit related projects when required for cross-project features.
- Do not work on `main`/`master` in sibling repos; create `codex` or `feature/<name>` branches.
- Tell the user when related project changes need merge/build/deploy or block progress.
- `@koralabs/<package-name>` projects live at `../<package-name>`.
  - You may build and `npm link` `./lib` as needed.
  - Notify user when publish is required before deployment.
  - Bump package version and dependent version together.
- Domain-to-folder conventions:
  - `handle.me` (or preview/preprod variants) -> `../handle.me`
  - `docs.handle.me` (or preview/preprod variants) -> `../docs.handle.me`
  - `api.handle.me` -> `../handle-public-api`
- Related Cardano validator/contract repos:
  - Personalization / Virtual SubHandles (100): `../handles-personalization`
  - Marketplace: `../handles-marketplace-contracts`
  - SubHandle Settings (001): `../handles-subhandle-settings`
  - Handles Minting (DeMi/Legacy): `../decentralized-minting`
  - Pz Background RFT (444): `../cip-68-444-minting`
