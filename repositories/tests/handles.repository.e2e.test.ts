import { buildHolderInfo, HandlePaginationModel, HandleSearchModel, HandleType, HolderPaginationModel, Rarity, StoredHandle } from '@koralabs/kora-labs-common';
import { RedisHandlesStore } from '../../stores/redis';
import { HandlesRepository } from '../handlesRepository';
import { handlesFixture } from './fixtures/handles';

const policy = 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a';
const holder = 'stake_test1urc63cmezfacz9vrqu867axmqrvgp4zsyllxzud3k6danjsn0dn70';
const address = 'addr_test1qzdzhdzf9ud8k2suzryvcdl78l3tfesnwp962vcuh99k8z834r3hjynmsy2cxpc04a6dkqxcsr29qfl7v9cmrd5mm89qfmc97q';
const secondAddress = 'addr_test1qz8zyhdetz270qzfvkym38wx4wsqzx0m49urfu3wjkqsuchs8t4235v9t0x5grxm2hel388ypz0q3fng8k6am5hqzacq0fc746';

describe('HandlesRepository query e2e', () => {
    const store = new RedisHandlesStore();
    const repo = new HandlesRepository(store);

    const seedHandles = () => {
        const seeded = handlesFixture.map((fixture, index) =>
            repo.Internal.buildHandle({
                ...fixture,
                has_datum: index === 0,
                datum: index === 0 ? 'datum_0' : undefined
            })
        );

        seeded.forEach((handle) => {
            repo.updateHolder(handle);
            repo.save(handle);
        });

        const virtual = repo.Internal.buildHandle({
            hex: Buffer.from('0000000076407461636f').toString('utf-8'),
            name: 'v@taco',
            policy,
            handle_type: HandleType.VIRTUAL_SUBHANDLE,
            utxo: '#0',
            lovelace: 0,
            image: '',
            standard_image: '',
            image_hash: '',
            standard_image_hash: '',
            svg_version: '',
            version: 0,
            pz_enabled: false,
            resolved_addresses: { ada: address },
            updated_slot_number: seeded[1].updated_slot_number - 30
        });
        virtual.holder = holder;
        virtual.holder_type = 'wallet';

        repo.updateHolder(virtual);
        repo.save(virtual);

        const slots = [...seeded.map((handle) => handle.updated_slot_number), virtual.updated_slot_number].sort((a, b) => a - b);
        repo.setMetrics({
            firstSlot: slots[0],
            lastSlot: slots[slots.length - 1] + 100,
            handleCount: 4
        });
    };

    beforeAll(async () => {
        await repo.initialize();
    });

    beforeEach(() => {
        repo.rollBackToGenesis();
        seedHandles();
    });

    afterAll(() => {
        repo.destroy();
    });

    it('returns holder details with default handle and names', () => {
        const holders = repo.getAllHolders({ pagination: new HolderPaginationModel() });
        const mainHolder = holders.find((item) => item.address === holder);

        expect(mainHolder).toEqual(
            expect.objectContaining({
                address: holder,
                default_handle: 'taco',
                total_handles: 4,
                manually_set: false,
                type: 'wallet'
            })
        );
        expect(mainHolder?.handles).toEqual(expect.arrayContaining(['barbacoa', 'burrito', 'taco', 'v@taco']));
    });

    it('orders holders by total handle count with desc default and asc override', () => {
        const secondHolder = buildHolderInfo(secondAddress);
        const tiny = repo.Internal.buildHandle({
            hex: Buffer.from('tiny-second').toString('hex'),
            name: 'tiny-second',
            policy,
            handle_type: HandleType.HANDLE,
            utxo: 'utxo_second#0',
            lovelace: 1,
            resolved_addresses: { ada: secondAddress },
            updated_slot_number: Date.now()
        });
        tiny.holder = secondHolder.address;
        tiny.holder_type = secondHolder.type;
        repo.updateHolder(tiny);
        repo.save(tiny);

        const desc = repo.getAllHolders({ pagination: new HolderPaginationModel({ recordsPerPage: '10' }) });
        const asc = repo.getAllHolders({ pagination: new HolderPaginationModel({ recordsPerPage: '10', sort: 'asc' }) });

        expect(desc[0].total_handles).toBeGreaterThanOrEqual(desc[1].total_handles);
        expect(asc[0].total_handles).toBeLessThanOrEqual(asc[1].total_handles);
    });

    it('filters handles by rarity, holder and type', () => {
        const byRarity = repo.search(new HandlePaginationModel(), new HandleSearchModel({ rarity: Rarity.common }));
        expect(byRarity.searchTotal).toBeGreaterThanOrEqual(3);
        expect((byRarity.handles as StoredHandle[]).map((handle) => handle.name)).toEqual(expect.arrayContaining(['burrito', 'taco', 'v@taco']));

        const byHolder = repo.search(new HandlePaginationModel(), new HandleSearchModel({ holder_address: holder }));
        expect(byHolder.searchTotal).toBe(4);

        const byType = repo.search(new HandlePaginationModel(), new HandleSearchModel({ handle_type: HandleType.VIRTUAL_SUBHANDLE }));
        expect(byType.searchTotal).toBe(1);
        expect((byType.handles as StoredHandle[])[0].name).toBe('v@taco');
    });

    it('supports slot pagination and search term filtering', () => {
        const firstSlot = handlesFixture[0].updated_slot_number;
        const pageBySlot = repo.search(
            new HandlePaginationModel({ slotNumber: `${firstSlot}`, handlesPerPage: '1' }),
            new HandleSearchModel({ handles: ['barbacoa', 'burrito', 'taco', 'v@taco'] })
        );
        expect(pageBySlot.searchTotal).toBe(4);
        expect((pageBySlot.handles as StoredHandle[]).length).toBe(1);
        expect((pageBySlot.handles as StoredHandle[])[0].name).toBe('barbacoa');

        const searchByName = repo.search(new HandlePaginationModel(), new HandleSearchModel({ search: 'bur' }));
        expect(searchByName.searchTotal).toBe(1);
        expect((searchByName.handles as StoredHandle[])[0].name).toBe('burrito');
    });

    it('supports names-only output, random sort, and slot-range boundary short-circuits', () => {
        const namesOnly = repo.search(new HandlePaginationModel({ sort: 'random', handlesPerPage: '3' }), new HandleSearchModel(), true);
        expect(namesOnly.searchTotal).toBeGreaterThan(0);
        expect(namesOnly.handles.every((name) => typeof name === 'string')).toBe(true);

        const noRangeMatches = repo.search(new HandlePaginationModel(), new HandleSearchModel({ length: '27-28' }), true);
        expect(noRangeMatches.searchTotal).toBe(0);
        expect(noRangeMatches.handles).toEqual([]);

        const { firstSlot = 0, lastSlot = 0 } = repo.getMetrics();
        const ascBeyondTip = repo.search(
            new HandlePaginationModel({ slotNumber: `${lastSlot + 10_000}`, handlesPerPage: '1', sort: 'asc' }),
            new HandleSearchModel()
        );
        expect(ascBeyondTip.handles).toEqual([]);

        const descBeforeGenesis = repo.search(
            new HandlePaginationModel({ slotNumber: `${firstSlot - 10_000}`, handlesPerPage: '1', sort: 'desc' }),
            new HandleSearchModel()
        );
        expect(descBeforeGenesis.handles).toEqual([]);
    });

    it('returns datum only for handles that have datum', () => {
        expect(repo.getHandleDatumByName('barbacoa')).toBe('datum_0');
        expect(repo.getHandleDatumByName('burrito')).toBeNull();
        expect(() => repo.getHandleDatumByName('unknown-handle')).toThrow('Not found');
    });

    it('indexes and returns subhandles by root handle', () => {
        const subHandleName = 'tiny@taco';
        const subHandle = repo.Internal.buildHandle({
            hex: Buffer.from(subHandleName).toString('hex'),
            name: subHandleName,
            policy,
            handle_type: HandleType.NFT_SUBHANDLE,
            utxo: 'utxo_sub#0',
            lovelace: 1,
            resolved_addresses: { ada: address },
            updated_slot_number: Date.now()
        });
        subHandle.holder = holder;
        subHandle.holder_type = 'wallet';

        repo.updateHolder(subHandle);
        repo.save(subHandle);

        const subHandles = repo.getSubHandlesByRootHandle('taco').map((handle) => handle.name);
        expect(subHandles).toContain(subHandleName);
    });
});
