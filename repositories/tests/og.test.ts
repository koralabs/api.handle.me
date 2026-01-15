import { RedisHandlesStore } from '../../stores/redis';
import { HandlesRepository } from '../handlesRepository';
import { handles, handlesWithDifferentLengths, handlesWithDifferentSlotNumbers, ogHandles } from './fixtures/handles';

const repo = new HandlesRepository(new RedisHandlesStore());

describe('getDefaultHandle', () => {
    it('should sort OGs', () => {
        // @ts-ignore
        const handle = repo.getDefaultHandle(ogHandles);
        expect(handle).toEqual(ogHandles[0]);
    });

    it('should sort only one OG', () => {
        // @ts-ignore
        const handle = repo.getDefaultHandle([ogHandles[1]]);
        expect(handle).toEqual(ogHandles[1]);
    });

    it('should sort if there are multiple lengths', () => {
        // @ts-ignore
        const handle = repo.getDefaultHandle(handlesWithDifferentLengths);
        expect(handle).toEqual(handlesWithDifferentLengths[1]);
    });

    it('should sort if there are multiple slot numbers', () => {
        // @ts-ignore
        const handle = repo.getDefaultHandle(handlesWithDifferentSlotNumbers);
        expect(handle).toEqual(handlesWithDifferentSlotNumbers[0]);
    });

    it('should sort alphabetically', () => {
        // @ts-ignore
        const handle = repo.getDefaultHandle(handles);
        expect(handle).toEqual(handles[1]);
    });

    it('should sort alphabetically', () => {
        // @ts-ignore
        const handle = repo.getDefaultHandle(handles, 'addr1');
        expect(handle).toEqual(handles[1]);
    });
});
