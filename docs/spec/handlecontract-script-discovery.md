# `@handlecontract` Script Discovery

## Scope
`api.handle.me` owns the public documentation for handle-backed script discovery and `/scripts` behavior.

This repo documents:
- how `GET /scripts` resolves deployed scripts,
- the canonical `*.handlecontract` naming pattern,
- the transition away from a manually curated static script catalog,
- parity tooling that compares source handles to the latest published deployment handles.

## Discovery Rules
- Prefer live handle-backed script discovery over a manually maintained static registry.
- Support legacy handles such as `@handle_settings` while repos are still migrating.
- Treat `<slug><ordinal>@handlecontract` as the canonical deployment-handle shape for new automated deployments.
- `latest=true` should resolve the latest assigned deployment handle for each contract family.

## Tooling
Parity and migration checks that belong with the API-side discovery contract live here:
- `scripts/check_contract_script_parity.py`

Shared deployment workflow and planner docs live in `adahandle-deployments/docs/`.
