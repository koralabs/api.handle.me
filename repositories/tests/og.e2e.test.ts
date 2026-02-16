import { ApiIndexType, IndexNames } from '@koralabs/kora-labs-common';
import { RedisHandlesStore } from '../../stores/redis';
import { HandlesRepository } from '../handlesRepository';
import { handles, handlesWithDifferentLengths, handlesWithDifferentSlotNumbers, ogHandles } from './fixtures/handles';

const storeInstance = new RedisHandlesStore();
const repo = new HandlesRepository(storeInstance);

describe('getDefaultHandle', () => {
    beforeAll(async () => {
        await repo.initialize();
        repo.rollBackToGenesis();
        for (const handle of [...ogHandles, ...handlesWithDifferentLengths, ...handlesWithDifferentSlotNumbers, ...handles]) {
            storeInstance.setHashOnIndex(IndexNames.HANDLE, handle.name, handle as unknown as ApiIndexType);
        }
    });

    afterAll(() => {
        repo.destroy();
    });

    it('should sort OGs', () => {
        const handle = repo.getDefaultHandle(new Set<string>(ogHandles.map(h => h.name)));
        expect(handle).toEqual(ogHandles[0]);
    });

    it('should sort only one OG', () => {
        const handle = repo.getDefaultHandle(new Set<string>([ogHandles[1].name]));
        expect(handle).toEqual(ogHandles[1]);
    });

    it('should sort if there are multiple lengths', () => {
        const handle = repo.getDefaultHandle(new Set<string>(handlesWithDifferentLengths.map(h => h.name)));
        expect(handle).toEqual(handlesWithDifferentLengths[1]);
    });

    it('should sort if there are multiple slot numbers', () => {
        const handle = repo.getDefaultHandle(new Set<string>(handlesWithDifferentSlotNumbers.map(h => h.name)));
        expect(handle).toEqual(handlesWithDifferentSlotNumbers[0]);
    });

    it('should sort alphabetically', () => {
        const sameSlotHandles = handles.map((handle) => ({
            ...handle,
            created_slot_number: 1,
            updated_slot_number: 1
        }));
        sameSlotHandles.forEach((handle) => {
            storeInstance.setHashOnIndex(IndexNames.HANDLE, handle.name, handle as unknown as ApiIndexType);
        });
        const defaultHandle = repo.getDefaultHandle(new Set<string>(sameSlotHandles.map((handle) => handle.name)));
        expect(defaultHandle?.name).toEqual('10');
    });

    it('should sort by OG when new handle has OG', () => {
        const [firstHandle] = handles;
        const newHandle = {
            ...firstHandle,
            name: 'new-og',
            og_number: 123
        }
        storeInstance.setHashOnIndex(IndexNames.HANDLE, newHandle.name, newHandle as unknown as ApiIndexType);
        const handle = repo.getDefaultHandle(new Set<string>([firstHandle.name, newHandle.name]));
        expect(handle).toEqual(newHandle);
    });
});
