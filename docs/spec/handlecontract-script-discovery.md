# `@handlecontract` Script Discovery

## Scope
`api.handle.me` owns the public documentation for handle-backed script discovery and `/scripts` behavior.

This repo documents:
- how `GET /scripts` resolves deployed scripts,
- the canonical `<slug><ordinal>@handlecontract` naming pattern,
- parity tooling that compares source handles to the latest published deployment handles.

## Discovery Rules
- `/scripts` lists every `*@handlecontract` subhandle that has inline script CBOR. There is no curated allow-list of contract families — whatever exists on chain shows up.
- Each entry is parsed as `<family><ordinal>@handlecontract`. The `family` is the leading non-digit slug (used as the response `type`); the `ordinal` is the trailing digits (used to pick `latest`).
- Within each family, the highest ordinal that has script CBOR is marked `latest: true`. Latest entries are emitted first so JSON-iteration order surfaces them up front.
- A placeholder mint of the next-version subhandle that hasn't been deployed yet does not displace `latest` — it stays on the previous ordinal until the new one gets its inline script.
- The `?type=X` query parameter is a case-insensitive `startsWith` match against the slug part of the handle name. `type=pers` matches `pers`, `persprx`, `perspz`, `perslfc`, `persdsg`. `type=persprx` matches only `persprx<n>`.
- `?latest=true` filters the response to entries with `latest: true` — combine with `?type=X` to scope to specific families.

## Tooling
Parity and migration checks that belong with the API-side discovery contract live here:
- `scripts/check_contract_script_parity.py`

Shared deployment workflow and planner docs live in `adahandle-deployments/docs/`.
