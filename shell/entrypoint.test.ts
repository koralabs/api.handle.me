import { spawnSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

function writeExecutable(filePath: string, content: string): void {
    writeFileSync(filePath, content);
    chmodSync(filePath, 0o755);
}

describe('container entrypoint', () => {
    it('starts cardano-node mode when ENABLE_SOCKET_REDIRECT is absent', () => {
        const repoRoot = process.cwd();
        const tempDir = mkdtempSync(path.join(tmpdir(), 'entrypoint-'));

        try {
            const binDir = path.join(tempDir, 'bin');
            const nodeDb = path.join(tempDir, 'db');
            const socketPath = path.join(tempDir, 'ipc', 'node.socket');
            const networkDir = path.join(tempDir, 'network');
            mkdirSync(binDir, { recursive: true });
            mkdirSync(networkDir, { recursive: true });

            writeFileSync(path.join(networkDir, 'shelley-genesis.json'), '{"networkMagic":42}');
            writeFileSync(path.join(networkDir, 'config.json'), '{}');
            writeFileSync(path.join(networkDir, 'topology.json'), '{}');
            writeExecutable(path.join(binDir, 'jq'), '#!/usr/bin/env bash\nprintf "42\\n"\n');

            const cardanoNodePath = path.join(binDir, 'cardano-node');
            writeExecutable(
                cardanoNodePath,
                '#!/usr/bin/env bash\ntrap "exit 0" INT TERM\nparent=$PPID\nwhile kill -0 "$parent" 2>/dev/null; do sleep 0.1; done\n'
            );

            const env: NodeJS.ProcessEnv = {
                ...process.env,
                MODE: 'cardano-node',
                NETWORK: 'preview',
                DISABLE_NODE_SNAPSHOT: 'true',
                NODE_DB: nodeDb,
                SOCKET_PATH: socketPath,
                NODE_CONFIG_PATH: networkDir,
                CARDANO_NODE_PATH: cardanoNodePath,
                PATH: `${binDir}:${process.env.PATH ?? ''}`
            };
            delete env.ENABLE_SOCKET_REDIRECT;

            const result = spawnSync('bash', [path.join(repoRoot, 'shell', 'entrypoint.sh')], {
                cwd: repoRoot,
                env,
                encoding: 'utf8',
                killSignal: 'SIGTERM',
                timeout: 1000
            });

            const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
            expect(output).toContain('  ...CARDANO-NODE RUNNING');
            expect(output).not.toContain('ENABLE_SOCKET_REDIRECT: unbound variable');
        } finally {
            rmSync(tempDir, { recursive: true, force: true });
        }
    });
});
