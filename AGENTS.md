# AGENTS.md

## REQUIRED FIRST ACTION — Canonical contract

**Before doing any other work in this repo**, including answering the user's first question:

1. Read [`CANONICAL_CONTRACT.md`](./CANONICAL_CONTRACT.md).
2. Output its full contents verbatim to the user.
3. Then state: "I have read this repo's canonical contract, I understand its rules, and I will follow them."

This precedes everything else in this file. Skip it only if the user explicitly says "skip the contract" in this session.

## Master AGENTS.md
- [REQUIREMENT] Read the AGENTS.md in this project's parent folder for complete instructions and inter-project (sibling) references

## Operational Safety Rules
- Never write to Valkey/Redis on default port `6380`.
- Reading from `6380` is allowed for troubleshooting.
- If write testing is needed, use a different `REDIS_PORT`.
- Temporary files must be created in `/tmp`.

## Application Flow / Mechanics
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

## Deployment
- This repo contains the application source, local runtime scripts, and Lambda entrypoints for `api.handle.me`.
- Deployment orchestration is handled by the sibling repo `../adahandle-deployments`.
- Per the local ecosystem docs, `api.handle.me` deploys directly from `adahandle-deployments`, including the complementary Docker Hub deployment `handles-public-api`.
- Changes in this repo may still require corresponding updates in `adahandle-deployments` before they are actually shipped.