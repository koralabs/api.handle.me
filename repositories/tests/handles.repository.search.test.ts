import { IndexNames } from '@koralabs/kora-labs-common';
import { HandlesRepository } from '../handlesRepository';

describe('HandlesRepository search', () => {
    it('pages unfiltered results without enumerating the full HANDLE set', () => {
        // Feature: unfiltered /handles queries should return quickly via paginated store access.
        // Failure mode: enumerating the full HANDLE set (smembers) can time out as the dataset grows.
        // Negative control: the store mock throws if getKeysFromIndex is called without pagination options.

        const handleByName = new Map<string, any>([
            ['alpha', { name: 'alpha', hex: 'aa', holder: 'holder-alpha' }],
            ['bravo', { name: 'bravo', hex: 'bb', holder: 'holder-bravo' }]
        ]);

        const pipelineResults: any[] = [];
        const store: any = {
            getMetrics: jest.fn().mockReturnValue({ handleCount: 3 }),
            getKeysFromIndex: jest.fn((index: IndexNames, options?: any) => {
                if (index !== IndexNames.HANDLE) throw new Error('unexpected index');
                if (!options) throw new Error('should not enumerate full HANDLE set');
                return ['alpha', 'bravo'];
            }),
            getHashFromIndex: jest.fn((_index: IndexNames, key: string) => {
                const handle = handleByName.get(key);
                pipelineResults.push(handle);
                return handle;
            }),
            getValuesFromIndexedSet: jest.fn((index: IndexNames, key: string) => {
                const result =
                    index === IndexNames.DEFAULT_HANDLE
                        ? new Set<string>()
                        : index === IndexNames.HOLDER
                            ? new Set<string>([`${key}`.replace('holder-', '')])
                            : undefined;
                pipelineResults.push(result);
                return result;
            }),
            pipeline: jest.fn((commands: () => void) => {
                pipelineResults.length = 0;
                commands();
                return [...pipelineResults];
            })
        };

        const repo = new HandlesRepository(store);
        const result = repo.search({ page: 1, handlesPerPage: 2 } as any, undefined, false);

        expect(store.getKeysFromIndex).toHaveBeenCalledWith(
            IndexNames.HANDLE,
            expect.objectContaining({
                limit: { offset: 0, count: 2 }
            })
        );
        expect(result.searchTotal).toBe(3);
        expect(result.handles.map((h: any) => h.name)).toEqual(['alpha', 'bravo']);
    });

    it('falls back to store handle count when metrics are missing', () => {
        // Feature: searchTotal should still be populated for unfiltered pagination even when metrics are absent.
        // Failure mode: missing metrics previously forced full enumeration of all handles.
        // Negative control: the store mock throws if getKeysFromIndex is called without pagination options.

        const pipelineResults: any[] = [];
        const store: any = {
            getMetrics: jest.fn().mockReturnValue({}),
            count: jest.fn().mockReturnValue(42),
            getKeysFromIndex: jest.fn((index: IndexNames, options?: any) => {
                if (index !== IndexNames.HANDLE) throw new Error('unexpected index');
                if (!options) throw new Error('should not enumerate full HANDLE set');
                return [];
            }),
            pipeline: jest.fn((commands: () => void) => {
                pipelineResults.length = 0;
                commands();
                return [...pipelineResults];
            })
        };

        const repo = new HandlesRepository(store);
        const result = repo.search({ page: 1, handlesPerPage: 100 } as any, undefined, true);

        expect(result.searchTotal).toBe(42);
        expect(result.handles).toEqual([]);
        expect(store.count).toHaveBeenCalledTimes(1);
    });
});
