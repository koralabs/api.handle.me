import { readFileSync } from 'node:fs';

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
if (lock.lockfileVersion !== 3 || !lock.packages?.['']) {
    throw new Error('Build requires the root npm v3 package lock.');
}
for (const [name, entry] of Object.entries(lock.packages)) {
    if (!name) continue;
    if (entry.link || !entry.integrity || !entry.resolved?.startsWith('https://registry.npmjs.org/')) {
        throw new Error(`Build requires integrity-locked registry dependencies, not sibling/local sources: ${name}`);
    }
}
