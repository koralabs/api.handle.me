import { repairCommonAncestor, type RepairBlock } from './repairCommonAncestor';

const blocks: RepairBlock[] = [
    { hash: 'root', slot: 1, parentHash: null },
    { hash: 'common', slot: 10, parentHash: 'root' },
    { hash: 'old', slot: 20, parentHash: 'common' },
    { hash: 'new', slot: 21, parentHash: 'common' }
];
const reader = (values: RepairBlock[]) => async (hash: string) => values.find(block => block.hash === hash) ?? null;

// A fork must resolve to its verified common block, including the same-tip edge case.
// Returning either tip for a divergent fork makes the common-block assertion fail.
it('finds the shared parent of two verified chains', async () => {
    expect(await repairCommonAncestor({ hash: 'old', slot: 20 }, { hash: 'new', slot: 21 }, reader(blocks))).toEqual(blocks[1]);
    expect(await repairCommonAncestor({ hash: 'old', slot: 20 }, { hash: 'old', slot: 20 }, reader(blocks))).toEqual(blocks[2]);
});

// Missing, inconsistent or truncated ancestry cannot justify a rollback.
// Ignoring any of these errors would return an unverified block or accept bad input.
it('refuses missing, inconsistent and depth-limited ancestry', async () => {
    await expect(repairCommonAncestor({ hash: 'old', slot: 20 }, { hash: 'new', slot: 21 }, reader(blocks.filter(block => block.hash !== 'common')))).rejects.toThrow('unavailable');
    await expect(repairCommonAncestor({ hash: 'old', slot: 19 }, { hash: 'new', slot: 21 }, reader(blocks))).rejects.toThrow();
    await expect(repairCommonAncestor({ hash: 'old', slot: 20 }, { hash: 'new', slot: 21 }, reader(blocks), 0)).rejects.toThrow('No verified common ancestor');
    let commonReads = 0;
    await expect(repairCommonAncestor({ hash: 'old', slot: 20 }, { hash: 'new', slot: 21 }, async hash => {
        const block = blocks.find(item => item.hash === hash);
        if (!block) return null;
        if (hash === 'common' && ++commonReads === 2) return { ...block, parentHash: null };
        return block;
    })).rejects.toThrow('Ancestry block changed');
});
