import fs from 'fs/promises';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { SCRIPT_ARTIFACT_NETWORKS, SCRIPT_SOURCES, ScriptArtifactNetwork, ScriptSource } from '../config/script-sources';

const GITHUB_RAW_BASE_URL = 'https://raw.githubusercontent.com/koralabs';
const OUTPUT_DIR = path.resolve(process.cwd(), 'config', 'script-artifacts');

const fetchOptionalText = async (url: string) => {
    const response = await fetch(url);
    if (response.status === 404) {
        return;
    }
    if (!response.ok) {
        throw new Error(`Unable to fetch ${url}: ${response.status} ${response.statusText}`);
    }

    const text = (await response.text()).trim();
    return text || undefined;
};

const getUnoptimizedCborUrl = (network: ScriptArtifactNetwork, source: ScriptSource) =>
    `${GITHUB_RAW_BASE_URL}/${source.repo}/master/deploy/${network}/${source.slug}.unoptimized.cbor`;

const getDeploymentStateUrl = (network: ScriptArtifactNetwork, source: ScriptSource) =>
    source.deploymentStatePath
        ? `${GITHUB_RAW_BASE_URL}/${source.repo}/master/${source.deploymentStatePath.replace('${network}', network)}`
        : undefined;

const fetchAssignedHandles = async (network: ScriptArtifactNetwork, source: ScriptSource) => {
    const url = getDeploymentStateUrl(network, source);
    if (!url) {
        return;
    }

    const contents = await fetchOptionalText(url);
    if (!contents) {
        return;
    }

    const payload = parseYaml(contents) as {
        assigned_handles?: { scripts?: unknown };
    } | null;
    const handles = payload?.assigned_handles?.scripts;
    if (!Array.isArray(handles)) {
        return;
    }

    const normalizedHandles = handles
        .map((handle) => `${handle}`.trim())
        .filter((handle) => handle.length > 0);
    return normalizedHandles.length > 0 ? normalizedHandles : undefined;
};

const writeNetworkArtifacts = async (network: ScriptArtifactNetwork) => {
    const networkDir = path.join(OUTPUT_DIR, network);
    await fs.mkdir(networkDir, { recursive: true });

    const staleArtifacts = await fs.readdir(networkDir).catch(() => []);
    await Promise.all(
        staleArtifacts
            .filter((name) => name.endsWith('.unoptimized.cbor'))
            .map((name) => fs.rm(path.join(networkDir, name), { force: true }))
    );

    const assignedHandlesIndex: Record<string, string[]> = {};

    for (const source of Object.values(SCRIPT_SOURCES)) {
        const unoptimizedCbor = await fetchOptionalText(getUnoptimizedCborUrl(network, source));
        if (unoptimizedCbor) {
            await fs.writeFile(path.join(networkDir, `${source.slug}.unoptimized.cbor`), `${unoptimizedCbor}\n`);
        }

        const assignedHandles = await fetchAssignedHandles(network, source);
        if (assignedHandles?.length) {
            assignedHandlesIndex[source.slug] = assignedHandles;
        }
    }

    await fs.writeFile(path.join(networkDir, 'assigned-handles.json'), `${JSON.stringify(assignedHandlesIndex, null, 2)}\n`);
};

const main = async () => {
    for (const network of SCRIPT_ARTIFACT_NETWORKS) {
        await writeNetworkArtifacts(network);
    }
};

await main();
