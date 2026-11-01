"""Offline release-driver tests: real shell/lock guard, fake package-manager boundary.

Invariant: only the root registry lock supplies compiler and runtime dependencies.
Catches floating installs, sibling sources, ignored failures and stale release files.
Negative control: restore the old build command (or remove either ci/fail-fast/guard)
and the corresponding command, output-preservation or rejection assertion fails.
"""
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import os


class BuildLambdaTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='api-build-test-', dir='/tmp')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / 'shell').mkdir()
        for name in ['build-lambda.sh', 'check-build-lock.mjs']:
            shutil.copy(Path(__file__).parent / name, self.root / 'shell' / name)
        (self.root / 'docs').mkdir()
        (self.root / 'docs/swagger.yml').write_text('openapi: 3.0.0\n')
        (self.root / 'package.json').write_text(json.dumps({'name': 'fixture', 'version': '1.14.8'}))
        self.lock = {'lockfileVersion': 3, 'packages': {'': {'version': '1.14.8'}, 'node_modules/common': {
            'version': '6.9.3', 'resolved': 'https://registry.npmjs.org/common/-/common-6.9.3.tgz', 'integrity': 'sha512-fixture'}}}
        self.write_lock()
        (self.root / 'bin').mkdir()
        npm = self.root / 'bin/npm'
        npm.write_text('''#!/usr/bin/env bash
set -eu
printf '%s\\n' "$*" >> commands
if [[ "$*" == "ci --include=dev" ]]; then
    [[ "${FAIL_INSTALL:-}" != root ]] || exit 37
    mkdir -p node_modules/.bin
    printf '#!/usr/bin/env bash\nmkdir -p dist/lambdas\nprintf compiled > dist/lambdas/api.js\n' > node_modules/.bin/rollup
    chmod +x node_modules/.bin/rollup
elif [[ "$*" == "ci --prefix dist --omit=dev" ]]; then
    [[ "${FAIL_INSTALL:-}" != runtime ]] || exit 38
    mkdir -p dist/node_modules/common
    printf '6.9.3' > dist/node_modules/common/version
else
    exit 39
fi
''')
        npm.chmod(0o755)

    def write_lock(self):
        (self.root / 'package-lock.json').write_text(json.dumps(self.lock))

    def run_build(self, failure=''):
        return subprocess.run(['bash', 'shell/build-lambda.sh'], cwd=self.root, text=True,
                              capture_output=True, env={**os.environ, 'PATH': f'{self.root}/bin:{os.environ["PATH"]}',
                                                       'FAIL_INSTALL': failure})

    def test_locked_compiler_and_runtime(self):
        result = self.run_build()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.root / 'commands').read_text().splitlines(), ['ci --include=dev', 'ci --prefix dist --omit=dev'])
        for name in ['package.json', 'package-lock.json', 'docs/swagger.yml']:
            self.assertEqual((self.root / 'dist' / Path(name).name).read_bytes(), (self.root / name).read_bytes())
        self.assertEqual((self.root / 'dist/lambdas/api.js').read_text(), 'compiled')
        self.assertEqual((self.root / 'dist/node_modules/common/version').read_text(), '6.9.3')

    def test_empty_existing_output_allowed(self):
        (self.root / 'dist').mkdir()
        self.assertEqual(self.run_build().returncode, 0)
        self.assertEqual((self.root / 'dist/lambdas/api.js').read_text(), 'compiled')

    def test_stale_artifacts_preserved_and_build_refused(self):
        (self.root / 'dist').mkdir()
        artifact = self.root / 'dist/evidence.cbor'
        artifact.write_bytes(b'operator evidence')
        result = self.run_build()
        self.assertEqual(result.returncode, 1)
        self.assertIn('Refusing to build', result.stderr)
        self.assertEqual(artifact.read_bytes(), b'operator evidence')
        self.assertFalse((self.root / 'commands').exists())

    def test_sibling_or_unverified_graph_rejected_before_install(self):
        for bad in [{'link': True, 'resolved': '../common'}, {'resolved': 'file:../common', 'integrity': 'sha512-x'},
                    {'resolved': 'https://registry.npmjs.org/common.tgz'}]:
            with self.subTest(entry=bad):
                self.lock['packages']['node_modules/common'] = bad
                self.write_lock()
                result = self.run_build()
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('not sibling/local sources', result.stderr)
                self.assertFalse((self.root / 'commands').exists())

    def test_install_failures_are_not_recovered_or_hidden(self):
        self.assertEqual(self.run_build('root').returncode, 37)
        self.assertFalse((self.root / 'dist').exists())
        self.assertEqual(self.run_build('runtime').returncode, 38)
        self.assertEqual((self.root / 'commands').read_text().splitlines(),
                         ['ci --include=dev', 'ci --include=dev', 'ci --prefix dist --omit=dev'])


if __name__ == '__main__':
    unittest.main()
