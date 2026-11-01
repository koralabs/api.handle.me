import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { load } = require('js-yaml') as { load: (source: string) => { jobs: Record<string, { steps: { run?: string }[] }> } };

// Structural operator invariant: Actions must never dispatch local e2e/browser journeys.
// This is about the workflow producer, not a runtime feature or source-spelling check.
// Negative control: restore the actual workflow's npm test; this fails with ['test'].
it('dispatches only the existing unit test script from the NPM Actions producer', () => {
    const workflow = load(readFileSync(resolve(__dirname, '../.github/workflows/yarn-pr-tests.yml'), 'utf8'));
    const invokedTestScripts = Object.values(workflow.jobs).flatMap((job) => job.steps.flatMap((step) => {
        if (!step.run) return [];
        return [...step.run.matchAll(/\bnpm\s+(?:run\s+)?(test(?::[\w-]+)?)(?=\s|$)/g)].map((match) => match[1]);
    }));
    expect(invokedTestScripts).toEqual(['test:unit']);
});
