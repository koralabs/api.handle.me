import { HandleType, HolderHandleNames, IPersonalization, IReferenceToken, IndexNames, StoredHandle, UTxO } from '@koralabs/kora-labs-common';
import { RedisHandlesStore } from '../../stores/redis';
import { HandlesRepository } from '../handlesRepository';
import { handlesFixture } from './fixtures/handles';

const policy = 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a';
const holder = 'stake_test1urc63cmezfacz9vrqu867axmqrvgp4zsyllxzud3k6danjsn0dn70';
const address = 'addr_test1qzdzhdzf9ud8k2suzryvcdl78l3tfesnwp962vcuh99k8z834r3hjynmsy2cxpc04a6dkqxcsr29qfl7v9cmrd5mm89qfmc97q';
const movedAddress = 'addr_test1qz8zyhdetz270qzfvkym38wx4wsqzx0m49urfu3wjkqsuchs8t4235v9t0x5grxm2hel388ypz0q3fng8k6am5hqzacq0fc746';
const movedHolder = 'stake_test1urcr464g6xz4hn2ypnd4tulcnnjq38sg5e5rmdwa6tspwuqn7lhlg';

const defaultReferenceToken: IReferenceToken = {
    tx_id: 'default_ref_tx',
    id: 'default_ref_tx#0',
    slot: 0,
    index: 0,
    lovelace: 0,
    datum: '',
    address: '',
    blockHash: '',
    blockNum: 0
};

const slot = (() => {
    let value = Date.now();
    return () => {
        value += 10;
        return value;
    };
})();

describe('HandlesRepository lifecycle e2e', () => {
    const store = new RedisHandlesStore();
    const repo = new HandlesRepository(store);

    const seedBaseHandles = () => {
        for (const [index, fixture] of handlesFixture.entries()) {
            const handle = repo.Internal.buildHandle({
                ...fixture,
                datum: `fixture_datum_${index}`,
                has_datum: true
            });
            repo.updateHolder(handle);
            repo.save(handle);
        }
    };

    beforeAll(async () => {
        await repo.initialize();
    });

    afterAll(() => {
        repo.destroy();
    });

    beforeEach(() => {
        repo.rollBackToGenesis();
        seedBaseHandles();
        jest.clearAllMocks();
    });

    it('saves a new handle and indexes it under holder', () => {
        const newHandle = repo.Internal.buildHandle({
            hex: Buffer.from('nachos').toString('hex'),
            name: 'nachos',
            og_number: 0,
            utxo: 'utxo123#0',
            policy,
            lovelace: 0,
            image: 'ipfs://123',
            datum: 'datum123',
            image_hash: '0x123',
            svg_version: '1.0.0',
            standard_image: 'ipfs://123',
            standard_image_hash: '0x123',
            handle_type: HandleType.HANDLE,
            resolved_addresses: { ada: address },
            updated_slot_number: slot()
        });
        newHandle.holder = holder;
        newHandle.holder_type = 'wallet';

        repo.updateHolder(newHandle);
        repo.save(newHandle);

        const saved = repo.getHandle('nachos');
        expect(saved).toEqual(
            expect.objectContaining({
                name: 'nachos',
                utxo: 'utxo123#0',
                has_datum: true,
                datum: 'datum123',
                holder,
                policy,
                image: 'ipfs://123'
            })
        );

        const holderHandles = store.getValuesFromIndexedSet(IndexNames.HOLDER, holder) as HolderHandleNames;
        expect(holderHandles.has('nachos')).toBe(true);
    });

    it('preserves personalization when handle UTxO updates later', () => {
        const personalization: IPersonalization = {
            designer: { font_shadow_color: '0xtodo' },
            validated_by: 'todo',
            trial: false,
            nsfw: false
        };

        const first = repo.Internal.buildHandle({
            hex: Buffer.from('chimichanga').toString('hex'),
            name: 'chimichanga',
            personalization,
            reference_token: defaultReferenceToken,
            policy,
            image: 'ipfs://seed',
            resolved_addresses: { ada: address },
            updated_slot_number: slot()
        });
        first.holder = holder;
        first.holder_type = 'wallet';

        repo.updateHolder(first);
        repo.save(first);

        const current = repo.getHandle('chimichanga') as StoredHandle;
        const moved = repo.Internal.buildHandle({
            ...current,
            utxo: 'utxo123#1',
            lovelace: 100,
            resolved_addresses: { ada: movedAddress },
            updated_slot_number: slot()
        });
        moved.holder = movedHolder;
        moved.holder_type = 'wallet';

        repo.updateHolder(moved);
        repo.Internal.removeHandleFromHolder(current.holder, moved.name);
        repo.save(moved, current);

        const updated = repo.getHandle('chimichanga');
        expect(updated).toEqual(
            expect.objectContaining({
                name: 'chimichanga',
                personalization,
                utxo: 'utxo123#1',
                holder: movedHolder,
                resolved_addresses: { ada: movedAddress }
            })
        );
        expect(updated?.created_slot_number).toBe(first.created_slot_number);
    });

    it('sets and unsets manually selected default handle', () => {
        const handleName = 'tortilla-soup';

        const initial = repo.Internal.buildHandle({
            hex: Buffer.from(handleName).toString('hex'),
            name: handleName,
            og_number: 0,
            utxo: 'utxo123#0',
            policy,
            image: 'ipfs://123',
            handle_type: HandleType.HANDLE,
            resolved_addresses: { ada: address },
            updated_slot_number: slot(),
            default: true
        });
        initial.holder = holder;
        initial.holder_type = 'wallet';

        repo.updateHolder(initial);
        repo.save(initial);

        expect(repo.getHandle(handleName)?.default_in_wallet).toBe(handleName);

        const current = repo.getHandle(handleName) as StoredHandle;
        const removeDefault = repo.Internal.buildHandle({
            ...current,
            updated_slot_number: slot(),
            default: false
        });
        removeDefault.holder = holder;
        removeDefault.holder_type = 'wallet';

        repo.updateHolder(removeDefault);
        repo.save(removeDefault, current);

        expect(repo.getHandle(handleName)?.default_in_wallet).toBe('taco');

        const defaultSet = store.getValuesFromIndexedSet(IndexNames.DEFAULT_HANDLE, holder) as Set<string> | undefined;
        expect(defaultSet?.has(handleName) ?? false).toBe(false);
    });

    it('stores subhandle settings and indexes subhandles by root', () => {
        const rootName = 'shrimp-taco';
        const root = repo.Internal.buildHandle({
            hex: Buffer.from(rootName).toString('hex'),
            name: rootName,
            og_number: 0,
            utxo: 'utxo123#0',
            policy,
            handle_type: HandleType.HANDLE,
            resolved_addresses: { ada: address },
            updated_slot_number: slot()
        });
        root.holder = holder;
        root.holder_type = 'wallet';

        repo.updateHolder(root);
        repo.save(root);

        const settingsUtxo: UTxO = {
            tx_id: 'settings_tx',
            id: 'settings_tx#0',
            slot: 0,
            index: 0,
            lovelace: 1,
            datum: 'a2436e6674a1',
            address,
            blockHash: 'hash',
            blockNum: 0
        };

        const currentRoot = repo.getHandle(rootName) as StoredHandle;
        const rootWithSettings = repo.Internal.buildHandle({
            ...currentRoot,
            updated_slot_number: slot(),
            subhandle_settings: {
                payment_address: 'abc',
                utxo: settingsUtxo
            }
        });

        repo.save(rootWithSettings, currentRoot);

        const subName = 'tiny@shrimp-taco';
        const sub = repo.Internal.buildHandle({
            hex: Buffer.from(subName).toString('hex'),
            name: subName,
            og_number: 0,
            utxo: 'utxo_sub#0',
            policy,
            handle_type: HandleType.NFT_SUBHANDLE,
            resolved_addresses: { ada: address },
            updated_slot_number: slot()
        });
        sub.holder = holder;
        sub.holder_type = 'wallet';

        repo.updateHolder(sub);
        repo.save(sub);

        const savedRoot = repo.getHandle(rootName);
        expect(savedRoot?.subhandle_settings).toEqual(
            expect.objectContaining({
                payment_address: 'abc',
                utxo: settingsUtxo
            })
        );

        const subHandles = repo.getSubHandlesByRootHandle(rootName).map((h) => h.name);
        expect(subHandles).toContain(subName);
    });

    it('moves holder index on transfer and removes indexes on burn', () => {
        const handleName = 'salsa';

        const minted = repo.Internal.buildHandle({
            hex: Buffer.from(handleName).toString('hex'),
            name: handleName,
            og_number: 0,
            utxo: 'utxo_salsa1#0',
            policy,
            image: 'ipfs://123',
            datum: 'datum',
            handle_type: HandleType.HANDLE,
            resolved_addresses: { ada: address },
            updated_slot_number: slot()
        });
        minted.holder = holder;
        minted.holder_type = 'wallet';

        repo.updateHolder(minted);
        repo.save(minted);

        const current = repo.getHandle(handleName) as StoredHandle;
        const moved = repo.Internal.buildHandle({
            ...current,
            utxo: 'utxo_salsa2#0',
            datum: '',
            resolved_addresses: { ada: movedAddress },
            updated_slot_number: slot()
        });
        moved.holder = movedHolder;
        moved.holder_type = 'wallet';

        repo.updateHolder(moved);
        repo.Internal.removeHandleFromHolder(current.holder, handleName);
        repo.save(moved, current);

        const oldHolderHandles = store.getValuesFromIndexedSet(IndexNames.HOLDER, holder) as Set<string>;
        const newHolderHandles = store.getValuesFromIndexedSet(IndexNames.HOLDER, movedHolder) as Set<string>;

        expect(oldHolderHandles.has(handleName)).toBe(false);
        expect(newHolderHandles.has(handleName)).toBe(true);

        repo.removeHandle(repo.getHandle(handleName) as StoredHandle);

        expect(repo.getHandle(handleName)).toBeNull();
        expect((store.getValuesFromIndexedSet(IndexNames.HOLDER, movedHolder) as Set<string>).has(handleName)).toBe(false);
    });

    it('persists cross-chain resolved addresses for handle resolution consumers', () => {
        const handleName = 'crosschain';
        const crossChainHandle = repo.Internal.buildHandle({
            hex: Buffer.from(handleName).toString('hex'),
            name: handleName,
            og_number: 0,
            utxo: 'utxo_cross#0',
            policy,
            image: 'ipfs://cross',
            handle_type: HandleType.HANDLE,
            resolved_addresses: {
                ada: address,
                btc: 'bc1qdemo',
                eth: '0xabc'
            } as any,
            updated_slot_number: slot()
        });
        crossChainHandle.holder = holder;
        crossChainHandle.holder_type = 'wallet';

        repo.updateHolder(crossChainHandle);
        repo.save(crossChainHandle);

        expect(repo.getHandle(handleName)).toEqual(
            expect.objectContaining({
                name: handleName,
                resolved_addresses: expect.objectContaining({
                    ada: address,
                    btc: 'bc1qdemo',
                    eth: '0xabc'
                }),
                holder
            })
        );
    });
});
