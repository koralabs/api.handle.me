import { DefaultHandleInfo, Holder } from '@koralabs/kora-labs-common';
import { RedisHandlesStore } from '../../stores/redis';
import { HandlesRepository } from '../handlesRepository';
import { handles, handlesWithDifferentLengths, handlesWithDifferentSlotNumbers, ogHandles } from './fixtures/handles';

const repo = new HandlesRepository(new RedisHandlesStore());

describe('getDefaultHandle', () => {
    const getHolder = (handles?: DefaultHandleInfo[]) => {
        const holder: Holder = {
            handles: handles ?? [],
            defaultHandle: '',
            manuallySet: false,
            type: 'todo',
            knownOwnerName: ''
        };

        return holder;
    };

    it('should sort OGs', () => {
        const handle = repo.getDefaultHandle(getHolder(ogHandles));
        expect(handle).toEqual(ogHandles[0]);
    });

    it('should sort only one OG', () => {
        const handle = repo.getDefaultHandle(getHolder([ogHandles[1]]));
        expect(handle).toEqual(ogHandles[1]);
    });

    it('should sort if there are multiple lengths', () => {
        const handle = repo.getDefaultHandle(getHolder(handlesWithDifferentLengths));
        expect(handle).toEqual(handlesWithDifferentLengths[1]);
    });

    it('should sort if there are multiple slot numbers', () => {
        const handle = repo.getDefaultHandle(getHolder(handlesWithDifferentSlotNumbers));
        expect(handle).toEqual(handlesWithDifferentSlotNumbers[0]);
    });

    it('should sort alphabetically', () => {
        const handle = repo.getDefaultHandle(getHolder(handles));
        expect(handle).toEqual(handles[1]);
    });

    it('should sort by OG when new handle has OG', () => {
        const [firstHandle] = handles;
        const newHandle = {
            ...firstHandle,
            og_number: 123
        }
        const handle = repo.getDefaultHandle(getHolder([firstHandle]), newHandle);
        expect(handle).toEqual(newHandle);
    });
});
