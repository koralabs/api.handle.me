export interface RepairBlock { hash: string; slot: number; parentHash: string | null }

/**
 * Verify both parent chains before selecting a common block. The caller must still
 * verify that the candidate is canonical and that all intervening state is undoable.
 */
export async function repairCommonAncestor(
    oldTip: { hash: string; slot: number },
    newTip: { hash: string; slot: number },
    readBlock: (hash: string) => Promise<RepairBlock | null>,
    maxDepth = 64
): Promise<RepairBlock> {
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) throw new Error('Invalid ancestry depth');
    const validateTip = (tip: { hash: string; slot: number }) => {
        if (!tip.hash || !Number.isSafeInteger(tip.slot) || tip.slot <= 0) throw new Error('Invalid ancestry tip');
    };
    validateTip(oldTip);
    validateTip(newTip);
    const cache = new Map<string, RepairBlock>();
    const load = async (hash: string, upperSlot: number): Promise<RepairBlock> => {
        const block = await readBlock(hash);
        if (!block || block.hash !== hash || !Number.isSafeInteger(block.slot) || block.slot <= 0 || block.slot >= upperSlot ||
            (block.parentHash !== null && (typeof block.parentHash !== 'string' || !block.parentHash))) throw new Error('Invalid or unavailable ancestry block');
        const prior = cache.get(hash);
        if (prior && (prior.slot !== block.slot || prior.parentHash !== block.parentHash)) throw new Error('Ancestry block changed');
        cache.set(hash, block);
        return block;
    };
    const old = new Map<string, RepairBlock>();
    let hash: string | null = oldTip.hash;
    let upper = oldTip.slot + 1;
    for (let depth = 0; hash && depth <= maxDepth; depth++) {
        if (old.has(hash)) throw new Error('Ancestry cycle');
        const block = await load(hash, upper);
        if (depth === 0 && block.slot !== oldTip.slot) throw new Error('Ancestry tip slot mismatch');
        old.set(hash, block);
        hash = block.parentHash;
        upper = block.slot;
    }
    hash = newTip.hash;
    upper = newTip.slot + 1;
    const seen = new Set<string>();
    for (let depth = 0; hash && depth <= maxDepth; depth++) {
        if (seen.has(hash)) throw new Error('Ancestry cycle');
        seen.add(hash);
        const block = await load(hash, upper);
        if (depth === 0 && block.slot !== newTip.slot) throw new Error('Ancestry tip slot mismatch');
        const previous = old.get(hash);
        if (previous) return block;
        hash = block.parentHash;
        upper = block.slot;
    }
    throw new Error('No verified common ancestor within depth');
}
