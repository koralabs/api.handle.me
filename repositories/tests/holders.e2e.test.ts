import { buildHolderInfo, HandleType, HolderHandleNames, IndexNames } from '@koralabs/kora-labs-common';
import { RedisHandlesStore } from '../../stores/redis';
import { HandlesRepository } from '../handlesRepository';
import { createRandomAddress, createRandomUtxo } from './fixtures/handles';

const policy = 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a';

describe('holder index integrity e2e', () => {
    const store = new RedisHandlesStore();
    const repo = new HandlesRepository(store);

    beforeAll(async () => {
        await repo.initialize();
    });

    afterAll(() => {
        repo.destroy();
    });

    beforeEach(() => {
        repo.rollBackToGenesis();
    });

    it('keeps holder index accurate across thousand-handle lifecycle updates', () => {
        const prefix = `e2e-holder-${Date.now()}`;
        const handleNames: string[] = [];
        const observedHolders = new Set<string>();

        for (let i = 0; i < 1000; i++) {
            const name = `${prefix}-${i}`;
            const address = createRandomAddress();
            const holderInfo = buildHolderInfo(address);
            const handle = repo.Internal.buildHandle({
                name,
                hex: Buffer.from(name).toString('hex'),
                policy,
                image: '',
                og_number: 0,
                handle_type: HandleType.HANDLE,
                utxo: createRandomUtxo(),
                lovelace: 0,
                resolved_addresses: { ada: address },
                updated_slot_number: i + 1
            });

            handle.holder = holderInfo.address;
            handle.holder_type = holderInfo.type;

            repo.updateHolder(handle);
            repo.save(handle);

            handleNames.push(name);
            observedHolders.add(holderInfo.address);
        }

        for (let i = 0; i < 1000; i++) {
            const name = handleNames[i % handleNames.length];
            const existing = repo.getHandle(name);
            if (!existing) continue;

            const address = createRandomAddress();
            const holderInfo = buildHolderInfo(address);
            const updated = repo.Internal.buildHandle({
                ...existing,
                utxo: createRandomUtxo(),
                resolved_addresses: { ada: address },
                updated_slot_number: 2000 + i
            });

            updated.holder = holderInfo.address;
            updated.holder_type = holderInfo.type;

            repo.updateHolder(updated);
            if (existing.holder !== updated.holder) {
                repo.Internal.removeHandleFromHolder(existing.holder, updated.name);
            }
            repo.save(updated, existing);

            observedHolders.add(existing.holder);
            observedHolders.add(updated.holder);
        }

        const expectedIndex = new Map<string, HolderHandleNames>();
        const testHandleSet = new Set(handleNames);

        for (const handleName of handleNames) {
            const handle = repo.getHandle(handleName);
            if (!handle) continue;

            const current = expectedIndex.get(handle.holder) ?? new Set<string>();
            current.add(handle.name);
            expectedIndex.set(handle.holder, current);

            const holderSet = store.getValuesFromIndexedSet(IndexNames.HOLDER, handle.holder) as Set<string>;
            expect(holderSet.has(handle.name)).toBe(true);
        }

        const normalize = (values: Set<string> | undefined) =>
            [...(values ?? new Set<string>())]
                .filter((name) => testHandleSet.has(name))
                .sort();

        for (const holderAddress of observedHolders) {
            const expected = normalize(expectedIndex.get(holderAddress));
            const indexed = normalize(store.getValuesFromIndexedSet(IndexNames.HOLDER, holderAddress) as Set<string>);
            expect(indexed).toEqual(expected);
        }
    });
});
