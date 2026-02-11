import { HandlePaginationModel, HolderHandleNames, IndexNames, StoredHandle } from '@koralabs/kora-labs-common';
import { RedisHandlesStore } from '../../stores/redis';
import { HandlesRepository } from '../handlesRepository';
import { createRandomHandles, performRandomHandleUpdates } from './fixtures/handles';

//for (const store of [HandlesMemoryStore]) {
const storeInstance = new RedisHandlesStore();
const repo = new HandlesRepository(storeInstance);
repo.initialize();
repo.rollBackToGenesis();

describe('holder index integrity', () => {
    it('holder index should be accurate', async () => {
        await createRandomHandles(storeInstance, 1000, true);
        await performRandomHandleUpdates(storeInstance, 1000, 1001);
        const testHolderIndex = new Map<string, HolderHandleNames>();
        console.time("repo-search")
        const handles = (repo.search({ handlesPerPage: 1000 } as HandlePaginationModel).handles as StoredHandle[]).sort((a, b) => a.updated_slot_number - b.updated_slot_number);
        console.timeEnd("repo-search")
        for (let i = 0; i < handles.length; i++) {
            const handle = handles[i];
            const handleNames = testHolderIndex.get(handle.holder);
            if (!handleNames) {
                testHolderIndex.set(handle.holder, new Set([handle.name]));
            } else {
                handleNames.add(handle.name);
            }
        }
        const holdersList = storeInstance.getKeysFromIndex(IndexNames.HOLDER) as string[];
        const allHolders = new Map<string, HolderHandleNames>();
        holdersList.forEach((h) => {
            const handleNames = storeInstance.getValuesFromIndexedSet(IndexNames.HOLDER, h) as Set<string>;
            allHolders.set(h, nope);
        });
        expect(allHolders).toEqual(testHolderIndex);
    });
});
