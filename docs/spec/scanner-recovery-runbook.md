# Scanner Recovery Runbook

## Symptoms and Recovery Procedures

### Symptom: API returns `status: storage_behind` and slot not advancing

**Diagnosis:**
1. Check CloudWatch logs for `api-scanner` — look for `NOTIFY` or `ERROR` category messages
2. Check metrics via valkey-utility: `lockLambdas`, `currentSlot`, `currentBlockHash`
3. Check if Lambda is timing out: look for `platform.report` with `status: timeout`

**Common causes and fixes:**

---

### Cause: Scanner Lambda timing out (15 min)

**Symptoms:**
- CloudWatch shows repeated `scannerLambda.lockedTooLong` warnings
- `platform.report` shows `status: timeout`, `durationMs: 900000`
- `lockLambdas: SCANNING` or `lockLambdas: ROLLBACK` in metrics
- Slot not advancing

**Root cause:** The scanner has a 12-minute hard deadline (`ScannerDeadlineError`) that should exit cleanly before the 15-minute Lambda timeout. If you see actual 15-minute timeouts, the deadline mechanism isn't firing — check breadcrumb logs (`scannerLambda.breadcrumb`, `scannerLambda.scan.breadcrumb`, `scannerLambda.rollback.breadcrumb`) to pinpoint where execution hangs.

The scanner falls back to Blockfrost when Koios calls fail. If both providers are down or the head points to an orphaned block, the rollback hash-set detection identifies orphaned UTxOs and repairs only the affected handles.

**Recovery:**
1. Check breadcrumb logs in CloudWatch — they show exactly which step hung
2. If the scanner head is stuck on an orphaned block, the hash-set rollback should self-recover on the next invocation
3. If self-recovery is not working, clear metrics via valkey-utility to trigger a snapshot reimport:
   ```json
   {"currentBlockHash": "", "currentSlot": "0", "lockLambdas": "", "lockLambdasTimestamp": "0"}
   ```
4. Before clearing, **bump scanner Lambda memory to 10GB** (see below)
5. Publish a new version and update the alias
6. After reimport completes and scanner catches up, restore memory to 4GB

---

### Cause: OOM during snapshot reimport

**Symptoms:**
- `platform.report` shows `status: error`, `errorType: Runtime.OutOfMemory`
- Metrics hash may be partially or fully wiped
- API returns `{"message": "Invalid time value"}`

**Recovery:**
1. Bump scanner Lambda to **10GB** memory:
   ```bash
   aws lambda update-function-configuration --function-name api-scanner --memory-size 10240
   ```
2. Restore essential metrics fields if wiped:
   ```json
   {"utxoSchemaVersion": "1", "indexSchemaVersion": "3", "currentBlockHash": "", "currentSlot": "0", "startTimestamp": "<now_ms>", "lockLambdas": "", "lockLambdasTimestamp": "0"}
   ```
3. Publish new version and update alias (the alias won't pick up config changes without this)
4. After reimport completes, restore to 4GB and publish/update alias again

---

### Cause: Wrong NETWORK env var after manual Lambda config change

**Symptoms:**
- Scanner Lambda invocations succeed in ~5 seconds with no application logs
- No log streams for the expected version number
- Slot not advancing

**Diagnosis:** Check the Lambda version's `NETWORK` env var — it may have inherited from the base function (which might be set to a different network).

**Recovery:**
1. Get the correct env vars from a known-good version:
   ```bash
   aws lambda get-function-configuration --function-name api-scanner --qualifier <good_version> --query 'Environment' --output json
   ```
2. Update the base function with the correct env:
   ```bash
   aws lambda update-function-configuration --function-name api-scanner --environment '<env_json>'
   ```
3. Publish and update alias

---

## Critical Checklist for Any Scanner Reset

1. **Both regions** — us-east-1 AND us-west-2 have separate Valkey instances, separate scanner aliases, and separate valkey-utility Lambdas. Fix both.

2. **Bump memory before reimport** — The S3 snapshot for mainnet is ~265K handles. Reimporting requires 10GB. Set memory to 10240 BEFORE triggering the reimport.

3. **Publish and update alias** — Changing `update-function-configuration` only affects the base `$LATEST` function. You MUST:
   ```bash
   aws lambda publish-version --function-name api-scanner
   aws lambda update-alias --function-name api-scanner --name <network> --function-version <new_version>
   ```

4. **NETWORK env var** — When updating function configuration, the env vars come from the base function, not the alias. Always verify `NETWORK` matches the target alias.

5. **Restore memory after reimport** — Once scanning is at tip, drop back to 4GB and publish/update alias again.

6. **API Lambda stale cache** — After reimport, the API Lambda may show `slot: 0` or `percentage_complete: 0` for up to 30 minutes until its warm instances cycle out. The data in Valkey is correct — verify with valkey-utility.

## Valkey-Utility Usage

The `valkey-utility` Lambda is ad hoc throwaway code. Deploy whatever handler you need:

```bash
# Write your handler to index.js
# Package with ioredis
cd tmp/adhoc-valkey-utility
zip -r /tmp/handler.zip index.js node_modules/ package.json
aws lambda update-function-code --function-name valkey-utility --zip-file fileb:///tmp/handler.zip
# For west:
aws lambda update-function-code --function-name valkey-utility --zip-file fileb:///tmp/handler.zip --region us-west-2
```

Environment variables available: `REDIS_HOST_US_EAST_1`, `REDIS_HOST_US_WEST_2`, `REDIS_USE_TLS`, `NETWORK`.
