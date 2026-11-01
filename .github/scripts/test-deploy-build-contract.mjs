// Invariant: every environment installs the locked compiler graph without fetching sibling fallback.
// Failure caught: floating npm install or reintroduction of the source-rewriting helper fetch.
// Negative controls: restore floating install, sibling fetch or mutable base; command/fetch assertions fail.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import YAML from 'yaml';

const workflow = YAML.parse(readFileSync(new URL('../workflows/deploy-box.yml', import.meta.url), 'utf8'));
const step = workflow.jobs['deploy-box'].steps.find(step => step.env?.SERVICE_INSTALL_CMD);
const reviewedBase = 'https://raw.githubusercontent.com/koralabs/adahandle-deployments/2b2b8350f59054a28aee6cd59ffa04253261425a/common';

function execute(environment, failFetch = false) {
    const dir = mkdtempSync(join(tmpdir(), 'api-workflow-test-'));
    try {
        mkdirSync(join(dir, 'bin'));
        // Network/process boundaries only: execute the actual workflow shell, never the deployment producer.
        writeFileSync(join(dir, 'bin/curl'), `#!/usr/bin/env bash
set -eu
url=''
out=''
while (( $# )); do
  case "$1" in
    -H) shift 2 ;;
    -o) out="$2"; shift 2 ;;
    https:*) url="$1"; shift ;;
    *) shift ;;
  esac
done
printf '%s\\n' "$url" >> fetches
[[ "\${FAIL_FETCH}" != 1 ]] || exit 22
cat > "$out" <<'HELPER'
#!/usr/bin/env bash
set -eu
eval "$SERVICE_INSTALL_CMD"
printf '%s' "$BOX_ENV" > invoked-environment
printf '%s' "$DEPLOY_FETCH_BASE" > inherited-base
HELPER
`, { mode: 0o755 });
        writeFileSync(join(dir, 'bin/npm'), '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> installs\n', { mode: 0o755 });
        const result = spawnSync('bash', ['-c', step.run], {
            cwd: dir, encoding: 'utf8',
            env: { ...process.env, PATH: `${dir}/bin:${process.env.PATH}`, BOX_ENV: environment,
                SERVICE_INSTALL_CMD: step.env.SERVICE_INSTALL_CMD, DEPLOY_FETCH_BASE: step.env.DEPLOY_FETCH_BASE,
                DEPLOYMENT_ACCESS_TOKEN: 'fixture-token', FAIL_FETCH: failFetch ? '1' : '0' }
        });
        const content = file => {
            try { return readFileSync(join(dir, file), 'utf8'); }
            catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        };
        return { result, fetches: content('fetches'), installs: content('installs'), invoked: content('invoked-environment'), inheritedBase: content('inherited-base') };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

for (const environment of ['preview', 'preprod', 'mainnet']) {
    test(`${environment}: locked install and only deployment producer fetched`, () => {
        const output = execute(environment);
        assert.equal(output.result.status, 0, output.result.stderr);
        assert.equal(output.fetches, `${reviewedBase}/service-fn-push.sh\n`);
        assert.equal(output.inheritedBase, reviewedBase);
        assert.equal(output.installs, 'ci --include=dev\n');
        assert.equal(output.invoked, environment);
    });
}

test('failed producer fetch cannot install or execute deployment', () => {
    const output = execute('mainnet', true);
    assert.equal(output.result.status, 22);
    assert.equal(output.installs, null);
    assert.equal(output.invoked, null);
    assert.equal(output.inheritedBase, null);
});
