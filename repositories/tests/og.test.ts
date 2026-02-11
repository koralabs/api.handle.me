import { ApiIndexType, IndexNames } from '@koralabs/kora-labs-common';
import { RedisHandlesStore } from '../../stores/redis';
import { HandlesRepository } from '../handlesRepository';
import { handles, handlesWithDifferentLengths, handlesWithDifferentSlotNumbers, ogHandles } from './fixtures/handles';

const storeInstance = new RedisHandlesStore().initialize();
const repo = new HandlesRepository(storeInstance);

describe('getDefaultHandle', () => {
    beforeAll(() => {
        for (const handle of [...ogHandles, ...handlesWithDifferentLengths, ...handlesWithDifferentSlotNumbers, ...handles]) {
            storeInstance.setHashOnIndex(IndexNames.HANDLE, handle.name, handle as unknown as ApiIndexType);
        }
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
        const handle = repo.getDefaultHandle(new Set<string>(handles.map(h => h.name)));
        expect(handle).toEqual(handles[1]);
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
