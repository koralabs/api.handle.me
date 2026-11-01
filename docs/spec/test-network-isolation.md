# Test credential and network isolation

## Incident and root cause

A sibling Mint test reached a real DynamoDB DeleteCommand using the workstation's default AWS profile. ResourceNotFound was incidental, not a safety boundary: the account still contains real tables. API tests previously loaded `.env` and application/SDK modules without a process-wide deny boundary; integration startup also adopted any listener already on6380. This is an upstream test-entrypoint correction, not IAM/table cleanup or a production change.

## Entrypoints

All unit, e2e and critical Jest configs install `tests/network-guard.cjs` before application imports, through config import, global setup and every worker's `setupFiles`. Normal npm test commands additionally preload it before Jest/Node itself. Node test files import the same guard before their other modules. Node children and worker threads inherit forced preload and sanitized environment even when callers supply replacement env/execArgv. Late dotenv loads are sanitized again.

Before SDK/application imports the guard removes AWS key/token/profile/role/web-identity/container credential sources, points shared credentials/config files to `/dev/null`, disables instance metadata, uses the reserved `http://aws-test.invalid` endpoint (including service overrides) and sets one AWS attempt. It never reads/edits workstation credential files, IAM or real tables.

Process-wide HTTP/HTTPS/fetch/TCP/TLS hooks reject outside destinations before connect. Same-process test servers permit only loopback client addresses while their listener is owned and open. Standard synchronous `listen(0)` semantics used by supertest are preserved; binding a wildcard listener does not authorize outbound external addresses. Closing the listener revokes new request authority.

Rust Glide bypasses Node TCP hooks, so its client creation is checked separately before native creation. Unit tests cannot open native Valkey connections. Glide's exact private JS/Rust IPC socket is permitted only inside an already validated client creation; arbitrary Unix sockets are denied. This is a test boundary for normal SDK/transport entrypoints, not an OS sandbox against malicious native code.

## Real integration/native storage is retained

No Redis store, WATCH transaction, scanner or existing assertion is replaced with a fake. E2e, critical and native tests retain real Glide/Valkey on **127.0.0.1:6380 only**, never6379, a general localhost exception or a tunnel.

`tests/valkey-harness.cjs` itself creates an ephemeral password-authenticated Valkey container from an already-local image ID, without pulling. A mode0600 owner receipt and exact Docker inspection bind repo/nonce/container/image/argv/no persistence/read-only filesystem/tmpfs/localhost publication. Docker uses only the literal local Unix daemon, not inherited remote contexts. Native options must name the single approved address with no TLS; the checked target is copied/canonicalized so caller mutation during native awaits cannot change it. Fixture credentials are supplied only if absent, preserving real wrong-password failures. An unrelated pre-existing6380 listener is refused, not adopted or stopped. Teardown removes only the verified owned container/receipt.

The old campaign fixture on6380 was identified by exact container ID/name/image/no-persistence argv/localhost publication, its metadata preserved, and that local test container stopped once before guarded tests. It was not a production service or6379 and was not silently adopted by the new harness. No production/box service operation occurred.

## Commands and evidence

- `npm run test:guard`: strict Node transport/credential/child/worker/owned-listener tests, including unfaked AWS and native-client denial.
- `npm run test:unit`: strict worker isolation and system-boundary fakes already used by unit tests.
- `npm run test:e2e`: starts/verifies the real owned fixture and runs all existing e2e assertions; an unfaked AWS client must still fail.
- `npm run test:valkey-harness`: actual authenticated Glide round trip plus ownership/configuration failure controls.
- `npm run test:critical`: existing complete critical suite and unchanged coverage thresholds with the same real fixture and AWS denial.

The legacy shell listener helper is no longer a test entrypoint. Use these commands; direct Jest configs are also guarded and own their fixture. The required local Docker image must already exist; missing images, busy6380 or ownership mismatch fail closed without network pulls/fallbacks. Tests that expose an unfaked external dependency must fake that system boundary while preserving behavioral assertions, never weaken guard rules or accept a real AWS error as proof of safety.

The backport introduces no scanner behavior. This environment's existing native WATCH/fence test script remains intact and now uses the owned fixture and AWS guard. Guarded unit/e2e/critical and actual native Glide harness logs are retained as rollout evidence. The real-Valkey readiness regression corrected Valkey8's required `REDISCLI_AUTH`; the initial bad readiness and the guard's initially incorrect supertest listen override are preserved as failures, not hidden by weaker tests. Normal test-only PR/CI/merge does not authorize a manual deployment or mainnet dispatch; application/runtime source and dependency lock are unchanged.
