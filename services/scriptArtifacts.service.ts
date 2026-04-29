import { ScriptType } from '@koralabs/kora-labs-common';
import fs from 'fs';
import path from 'path';
import { resolveScriptArtifactNetwork, SCRIPT_SOURCES, ScriptArtifactNetwork } from '../config/script-sources';

type AssignedHandlesIndex = Record<string, string[]>;

export type BundledScriptArtifact = {
    assignedHandles?: string[];
    unoptimizedCbor?: string;
};

const unoptimizedCborCache = new Map<string, string | undefined>();
const assignedHandlesCache = new Map<ScriptArtifactNetwork, AssignedHandlesIndex>();

const getScriptArtifactDir = (network: ScriptArtifactNetwork) => path.resolve(process.cwd(), 'config', 'script-artifacts', network);

const readAssignedHandlesIndex = (network: ScriptArtifactNetwork) => {
    const cached = assignedHandlesCache.get(network);
    if (cached) {
        return cached;
    }

    const assignedHandlesPath = path.join(getScriptArtifactDir(network), 'assigned-handles.json');
    let assignedHandles: AssignedHandlesIndex = {};
    try {
        assignedHandles = JSON.parse(fs.readFileSync(assignedHandlesPath, 'utf8')) as AssignedHandlesIndex;
    } catch (error: any) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }
    }

    assignedHandlesCache.set(network, assignedHandles);
    return assignedHandles;
};

const readUnoptimizedCbor = (network: ScriptArtifactNetwork, slug: string) => {
    const cacheKey = `${network}:${slug}`;
    if (unoptimizedCborCache.has(cacheKey)) {
        return unoptimizedCborCache.get(cacheKey);
    }

    const unoptimizedCborPath = path.join(getScriptArtifactDir(network), `${slug}.unoptimized.cbor`);
    let unoptimizedCbor: string | undefined;
    try {
        const contents = fs.readFileSync(unoptimizedCborPath, 'utf8').trim();
        unoptimizedCbor = contents || undefined;
    } catch (error: any) {
        if (error?.code !== 'ENOENT') {
            throw error;
        }
    }

    unoptimizedCborCache.set(cacheKey, unoptimizedCbor);
    return unoptimizedCbor;
};

export const getBundledScriptArtifact = (type: ScriptType, network = resolveScriptArtifactNetwork()): BundledScriptArtifact => {
    const source = SCRIPT_SOURCES[type];
    if (!source) {
        return {};
    }

    const assignedHandles = readAssignedHandlesIndex(network)[source.slug];
    return {
        assignedHandles: assignedHandles?.length ? assignedHandles : undefined,
        unoptimizedCbor: readUnoptimizedCbor(network, source.slug)
    };
};

export const resetBundledScriptArtifactCachesForTests = () => {
    assignedHandlesCache.clear();
    unoptimizedCborCache.clear();
};
