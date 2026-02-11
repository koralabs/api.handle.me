import { HandlePaginationModel, Holder, IndexNames, StoredHandle } from '@koralabs/kora-labs-common';
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
        const testHolderIndex = new Map<string, Holder>();
        console.time("repo-search")
        const handles = (repo.search({ handlesPerPage: 1000 } as HandlePaginationModel).handles as StoredHandle[]).sort((a, b) => a.updated_slot_number - b.updated_slot_number);
        console.timeEnd("repo-search")
        for (let i = 0; i < handles.length; i++) {
            const handle = handles[i];
            const holder = testHolderIndex.get(handle.holder);
            if (!holder) {
                testHolderIndex.set(handle.holder, {
                    defaultHandle: handle.default_in_wallet,
                    handles: [{ name: handle.name, og_number: handle.og_number, created_slot_number: handle.created_slot_number }],
                    manuallySet: false,
                    type: 'wallet'
                } as unknown as any);
            } else {
                holder.default_handle = handle.default_in_wallet;
                holder.handles.push(handle.name);
            }
        }
        const holdersList = storeInstance.getKeysFromIndex(IndexNames.HOLDER) as string[];
        const allHolders = new Map<string, Holder>();
        holdersList.forEach((h) => {
            const holder = storeInstance.getValuesFromIndexedSet(IndexNames.HOLDER, h) as Set<string>;
            const defaultHandle = storeInstance.getValuesFromIndexedSet(IndexNames.DEFAULT_HANDLE, h) as Set<string>;
            holder.default_handle = `${defaultHandle}`;
            allHolders.set(h, holder);
        });
        expect(allHolders).toEqual(testHolderIndex);
    });
});
