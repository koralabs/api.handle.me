import { HandleType, Holder, IHandle, ISlotHistory, Rarity, StoredHandle } from '@koralabs/kora-labs-common';
import { bech32 } from 'bech32';
import { HandlesRepository } from '../../../repositories/handlesRepository';
import { RedisHandlesStore } from '../../../stores/redis';
const policy = 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a';

export const ogHandles: IHandle[] = [
    {
        hex: 'og1-hex',
        name: 'og1',
        holder: 'stake-key1',
        image: '',
        standard_image: '',
        length: 3,
        og_number: 123,
        utxo: 'og1-hex#0',
        lovelace: 0,
        rarity: Rarity.common,
        characters: 'letters,numbers',
        numeric_modifiers: '',
        resolved_addresses: {
            ada: ''
        },
        default_in_wallet: '',
        pfp_image: '',
        bg_image: '',
        created_slot_number: Date.now(),
        updated_slot_number: Date.now(),
        has_datum: false,
        image_hash: 'image-hash',
        standard_image_hash: 'standard-image-hash',
        svg_version: '1.0.0',
        holder_type: '',
        handle_type: HandleType.NFT_SUBHANDLE,
        version: 0,
        policy
    },
    {
        hex: 'og2-hex',
        name: 'og2',
        holder: 'stake-key1',
        image: '',
        standard_image: '',
        length: 3,
        og_number: 124,
        utxo: 'og2-hex#0',
        lovelace: 0,
        rarity: Rarity.common,
        characters: 'letters,numbers',
        numeric_modifiers: '',
        resolved_addresses: {
            ada: ''
        },
        default_in_wallet: '',
        pfp_image: '',
        bg_image: '',
        created_slot_number: Date.now(),
        updated_slot_number: Date.now(),
        has_datum: false,
        image_hash: 'image-hash',
        standard_image_hash: 'standard-image-hash',
        svg_version: '1.0.0',
        holder_type: '',
        handle_type: HandleType.NFT_SUBHANDLE,
        version: 0,
        policy
    },
    {
        hex: 'og3-hex',
        name: 'og3',
        holder: 'stake-key1',
        image: '',
        standard_image: '',
        length: 3,
        og_number: 125,
        utxo: 'og3-hex#0',
        lovelace: 0,
        rarity: Rarity.common,
        characters: 'letters,numbers',
        numeric_modifiers: '',
        resolved_addresses: {
            ada: ''
        },
        default_in_wallet: '',
        pfp_image: '',
        bg_image: '',
        created_slot_number: Date.now(),
        updated_slot_number: Date.now(),
        has_datum: false,
        image_hash: 'image-hash',
        standard_image_hash: 'standard-image-hash',
        svg_version: '1.0.0',
        holder_type: '',
        handle_type: HandleType.NFT_SUBHANDLE,
        version: 0,
        policy
    }
];

export const handlesWithDifferentLengths: IHandle[] = [
    {
        hex: '100-length-hex',
        name: '100-length',
        holder: 'stake-key1',
        image: '',
        standard_image: '',
        length: 3,
        og_number: 0,
        utxo: '100-hex#0',
        lovelace: 0,
        rarity: Rarity.rare,
        characters: 'numbers',
        numeric_modifiers: '',
        resolved_addresses: {
            ada: ''
        },
        default_in_wallet: '',
        pfp_image: '',
        bg_image: '',
        created_slot_number: Date.now(),
        updated_slot_number: Date.now(),
        has_datum: false,
        image_hash: 'image-hash',
        standard_image_hash: 'standard-image-hash',
        svg_version: '1.0.0',
        holder_type: '',
        handle_type: HandleType.NFT_SUBHANDLE,
        version: 0,
        policy
    },
    {
        hex: '10-length-hex',
        name: '10-length',
        holder: 'stake-key1',
        image: '',
        standard_image: '',
        length: 2,
        og_number: 0,
        utxo: '10-length-hex#0',
        lovelace: 0,
        rarity: Rarity.ultra_rare,
        characters: 'numbers',
        numeric_modifiers: '',
        resolved_addresses: {
            ada: ''
        },
        default_in_wallet: '',
        pfp_image: '',
        bg_image: '',
        created_slot_number: Date.now(),
        updated_slot_number: Date.now(),
        has_datum: false,
        image_hash: 'image-hash',
        standard_image_hash: 'standard-image-hash',
        svg_version: '1.0.0',
        holder_type: '',
        handle_type: HandleType.NFT_SUBHANDLE,
        version: 0,
        policy
    },
    {
        hex: '1000-length-hex',
        name: '1000-length',
        holder: 'stake-key1',
        image: '',
        standard_image: '',
        length: 4,
        og_number: 0,
        utxo: '1000-length-hex#0',
        lovelace: 0,
        rarity: Rarity.rare,
        characters: 'numbers',
        numeric_modifiers: '',
        resolved_addresses: {
            ada: ''
        },
        default_in_wallet: '',
        pfp_image: '',
        bg_image: '',
        created_slot_number: Date.now(),
        updated_slot_number: Date.now(),
        has_datum: false,
        image_hash: 'image-hash',
        standard_image_hash: 'standard-image-hash',
        svg_version: '1.0.0',
        holder_type: '',
        handle_type: HandleType.NFT_SUBHANDLE,
        version: 0,
        policy
    }
];

export const handlesWithDifferentSlotNumbers: IHandle[] = [
    {
        hex: '10-diff-slot-hex',
        name: '10-diff-slot',
        holder: 'stake-key1',
        image: '',
        standard_image: '',
        length: 2,
        og_number: 0,
        utxo: '10-diff-slot-hex#0',
        lovelace: 0,
        rarity: Rarity.rare,
        characters: 'numbers',
        numeric_modifiers: '',
        resolved_addresses: {
            ada: ''
        },
        default_in_wallet: '',
        pfp_image: '',
        bg_image: '',
        created_slot_number: Date.now(),
        updated_slot_number: Date.now(),
        has_datum: false,
        image_hash: 'image-hash',
        standard_image_hash: 'standard-image-hash',
        svg_version: '1.0.0',
        holder_type: '',
        handle_type: HandleType.NFT_SUBHANDLE,
        version: 0,
        policy
    },
    {
        hex: '11-diff-slot-hex',
        name: '11-diff-slot',
        holder: 'stake-key1',
        image: '',
        standard_image: '',
        length: 2,
        og_number: 0,
        utxo: '11-diff-slot-hex#0',
        lovelace: 0,
        rarity: Rarity.ultra_rare,
        characters: 'numbers',
        numeric_modifiers: '',
        resolved_addresses: {
            ada: ''
        },
        default_in_wallet: '',
        pfp_image: '',
        bg_image: '',
        created_slot_number: Date.now() + 10,
        updated_slot_number: Date.now() + 10,
        has_datum: false,
        image_hash: 'image-hash',
        standard_image_hash: 'standard-image-hash',
        svg_version: '1.0.0',
        holder_type: '',
        handle_type: HandleType.NFT_SUBHANDLE,
        version: 0,
        policy
    },
    {
        hex: '12-diff-slot-hex',
        name: '12-diff-slot',
        holder: 'stake-key1',
        image: '',
        standard_image: '',
        length: 2,
        og_number: 0,
        utxo: '12-diff-slot-hex#0',
        lovelace: 0,
        rarity: Rarity.rare,
        characters: 'numbers',
        numeric_modifiers: '',
        resolved_addresses: {
            ada: ''
        },
        default_in_wallet: '',
        pfp_image: '',
        bg_image: '',
        created_slot_number: Date.now() + 20,
        updated_slot_number: Date.now() + 20,
        has_datum: false,
        image_hash: 'image-hash',
        standard_image_hash: 'standard-image-hash',
        svg_version: '1.0.0',
        holder_type: '',
        handle_type: HandleType.NFT_SUBHANDLE,
        version: 0,
        policy
    }
];

export const handles: IHandle[] = [
    {
        hex: '11-hex',
        name: '11',
        holder: 'stake-key1',
        image: '',
        standard_image: '',
        length: 2,
        og_number: 0,
        utxo: '11-hex#0',
        lovelace: 0,
        rarity: Rarity.ultra_rare,
        characters: 'numbers',
        numeric_modifiers: '',
        resolved_addresses: {
            ada: ''
        },
        default_in_wallet: '',
        pfp_image: '',
        bg_image: '',
        created_slot_number: Date.now(),
        updated_slot_number: Date.now(),
        has_datum: false,
        image_hash: 'image-hash',
        standard_image_hash: 'standard-image-hash',
        svg_version: '1.0.0',
        holder_type: '',
        handle_type: HandleType.NFT_SUBHANDLE,
        version: 0,
        policy
    },
    {
        hex: '10-hex',
        name: '10',
        holder: 'stake-key1',
        image: '',
        standard_image: '',
        length: 2,
        og_number: 0,
        utxo: '10-hex#0',
        lovelace: 0,
        rarity: Rarity.rare,
        characters: 'numbers',
        numeric_modifiers: '',
        resolved_addresses: {
            ada: ''
        },
        default_in_wallet: '',
        pfp_image: '',
        bg_image: '',
        created_slot_number: Date.now(),
        updated_slot_number: Date.now(),
        has_datum: false,
        image_hash: 'image-hash',
        standard_image_hash: 'standard-image-hash',
        svg_version: '1.0.0',
        holder_type: '',
        handle_type: HandleType.NFT_SUBHANDLE,
        version: 0,
        policy
    },
    {
        hex: '12-hex',
        name: '12',
        holder: 'stake-key1',
        image: '',
        standard_image: '',
        length: 2,
        og_number: 0,
        utxo: '12-hex#0',
        lovelace: 0,
        rarity: Rarity.rare,
        characters: 'numbers',
        numeric_modifiers: '',
        resolved_addresses: {
            ada: ''
        },
        default_in_wallet: '',
        pfp_image: '',
        bg_image: '',
        created_slot_number: Date.now(),
        updated_slot_number: Date.now(),
        has_datum: false,
        image_hash: 'image-hash',
        standard_image_hash: 'standard-image-hash',
        svg_version: '1.0.0',
        holder_type: '',
        handle_type: HandleType.NFT_SUBHANDLE,
        version: 0,
        policy
    }
];

export const handlesFixture: StoredHandle[] = [
    {
        hex: '6261726261636f61',
        name: 'barbacoa',
        holder: 'stake_test1urc63cmezfacz9vrqu867axmqrvgp4zsyllxzud3k6danjsn0dn70',
        image: '',
        standard_image: '',
        length: 8,
        og_number: 0,
        utxo: 'utxo1#0',
        policy,
        lovelace: 0,
        rarity: Rarity.basic,
        characters: 'letters',
        numeric_modifiers: '',
        resolved_addresses: {
            ada: 'addr_test1qzdzhdzf9ud8k2suzryvcdl78l3tfesnwp962vcuh99k8z834r3hjynmsy2cxpc04a6dkqxcsr29qfl7v9cmrd5mm89qfmc97q'
        },
        default_in_wallet: 'taco',
        pfp_image: '',
        bg_image: '',
        created_slot_number: Date.now(),
        updated_slot_number: Date.now(),
        has_datum: false,
        amount: 1,
        image_hash: '',
        last_update_address: '',
        standard_image_hash: '',
        svg_version: '1.0.0',
        holder_type: 'wallet',
        version: 0,
        handle_type: HandleType.HANDLE,
        payment_key_hash: '9a2bb4492f1a7b2a1c10c8cc37fe3fe2b4e613704ba5331cb94b6388'
    },
    {
        hex: '6275727269746f',
        name: 'burrito',
        holder: 'stake_test1urc63cmezfacz9vrqu867axmqrvgp4zsyllxzud3k6danjsn0dn70',
        image: '',
        standard_image: '',
        length: 7,
        og_number: 0,
        utxo: 'utxo2#0',
        policy,
        lovelace: 0,
        rarity: Rarity.common,
        characters: 'letters',
        numeric_modifiers: '',
        resolved_addresses: {
            ada: 'addr_test1qzdzhdzf9ud8k2suzryvcdl78l3tfesnwp962vcuh99k8z834r3hjynmsy2cxpc04a6dkqxcsr29qfl7v9cmrd5mm89qfmc97q'
        },
        default_in_wallet: 'taco',
        pfp_image: '',
        bg_image: '',
        created_slot_number: Date.now() + 10,
        updated_slot_number: Date.now() + 10,
        has_datum: false,
        amount: 1,
        image_hash: '',
        last_update_address: '',
        standard_image_hash: '',
        svg_version: '1.0.0',
        holder_type: 'wallet',
        version: 0,
        handle_type: HandleType.HANDLE,
        payment_key_hash: '9a2bb4492f1a7b2a1c10c8cc37fe3fe2b4e613704ba5331cb94b6388'
    },
    {
        hex: '7461636f',
        name: 'taco',
        holder: 'stake_test1urc63cmezfacz9vrqu867axmqrvgp4zsyllxzud3k6danjsn0dn70',
        image: '',
        standard_image: '',
        length: 4,
        og_number: 0,
        utxo: 'utxo3#0',
        policy,
        lovelace: 0,
        rarity: Rarity.common,
        characters: 'letters',
        numeric_modifiers: '',
        resolved_addresses: {
            ada: 'addr_test1qzdzhdzf9ud8k2suzryvcdl78l3tfesnwp962vcuh99k8z834r3hjynmsy2cxpc04a6dkqxcsr29qfl7v9cmrd5mm89qfmc97q'
        },
        default_in_wallet: 'taco',
        pfp_image: '',
        bg_image: '',
        created_slot_number: Date.now() + 20,
        updated_slot_number: Date.now() + 20,
        has_datum: false,
        amount: 1,
        image_hash: '',
        last_update_address: '',
        standard_image_hash: '',
        svg_version: '1.0.0',
        holder_type: 'wallet',
        version: 0,
        handle_type: HandleType.HANDLE,
        payment_key_hash: '9a2bb4492f1a7b2a1c10c8cc37fe3fe2b4e613704ba5331cb94b6388'
    }
];

// @ts-ignore
export const slotHistoryFixture: Map<number, ISlotHistory> = new Map([
    [0, {}],
    [1, {
        barbacoa: {
            old: null
        },
        burrito: {
            old: null
        },
        taco: {
            old: null
        }
    }],
    [2, {
        barbacoa: {
            old: { resolved_addresses: { ada: 'addr_test1qzdzhdzf9ud8k2suzryvcdl78l3tfesnwp962vcuh99k8z834r3hjynmsy2cxpc04a6dkqxcsr29qfl7v9cmrd5mm89qfmc97q' } }
        }
    }],
    [3, {
        burrito: {
            old: { resolved_addresses: { ada: 'addr_test1qzdzhdzf9ud8k2suzryvcdl78l3tfesnwp962vcuh99k8z834r3hjynmsy2cxpc04a6dkqxcsr29qfl7v9cmrd5mm89qfmc97q' } }
        }
    }],
    [4, {
        barbacoa: {
            old: { resolved_addresses: { ada: 'addr_test1qzdzhdzf9ud8k2suzryvcdl78l3tfesnwp962vcuh99k8z834r3hjynmsy2cxpc04a6dkqxcsr29qfl7v9cmrd5mm89qfmc97q' } }
        }
    }]
]);

export const holdersFixture = new Map<string, Holder>([
    [
        'addr1',
        {
            handles: ['burritos'],
            default_handle: 'burritos',
            manually_set: false,
            type: 'script',
            known_owner_name: 'funnable.token',
            total_handles: 1,
            address: 'addr_test1qqq9v5l5j6s4k2suzryvcdl78l3tfesnwp962vcuh99k8z834r3hjynmsy2cxpc04a6dkqxcsr29qfl7v9cmrd5mm89qfmc97q'
        }
    ],
    [
        'addr2',
        {
            handles: ['tacos', 'fajitas'],
            default_handle: 'tacos',
            manually_set: false,
            type: 'wallet',
            known_owner_name: '',
            total_handles: 2,
            address: 'addr_test1qqq9v5l5j6s4k2suzryvcdl78l3tfesnwp962vcuh99k8z834r3hjynmsy2cxpc04a6dkqxcsr29qfl7v9cmrd5mm89qfmc97q'
        }
    ]
]);

export const createRandomHandles = async (store: RedisHandlesStore, count: number, saveToHandleStore = false): Promise<StoredHandle[]> => {
    const repo = new HandlesRepository(store);
    const handles: StoredHandle[] = [];
    for (let i = 0; i < count; i++) {
        const handleName = createRandomHandleName();
        if (!repo.getHandle(handleName)) {
            const handle = await repo.Internal.buildHandle({
                name: handleName,
                hex: Buffer.from(handleName).toString('hex'),
                policy,
                image: `ipfs://${Buffer.from(handleName).toString('hex')}`,
                og_number: Math.floor(Math.random() * 2438),
                handle_type: HandleType.HANDLE,
                utxo: createRandomUtxo(),
                lovelace: 0,
                resolved_addresses: {ada: createRandomAddress()},
                updated_slot_number: i
            });
            if (saveToHandleStore) {
                repo.updateHolder(handle);
                repo.save(handle);
            }
            handles.push(handle);
        }
    }
    return handles;
};

export const createRandomUtxo = (): string => {
    let result = '';
    const characters = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let counter = 0;
    while (counter < 32) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
        counter += 1;
    }
    return `${result}#${Math.floor(Math.random() * 10)}`;
};

export const createRandomAddress = (): string => {
    return bech32.encode('addr_test', [0, 4, Math.floor(Math.random() * 32), 12, 18, 20, 22, 11, 25, 9, 29, 24, 30, 27, 11, 16, 13, 3, 8, 30, 9, 31, 25, 9, 30, 4, 0, 23, 31, 3, 14, 7, 13, 26, 15, 25, 7, 26, 24, 30, 7, 9, 24, 11, 12, 30, 14, 2, 10, 7, 13, 0, 10, 1, 30, 10, 25, 31, 20, 1, 8, 27, 14, 11, 15, 25, 9, 8, 24, 26, 10, 26, 6, 22, 1, 4, 23, 16, 14, 16, 0, 22, 4, 0, 22, 8, 26, 10, 10, 1, Math.floor(Math.random() * 32), 16], 108);
};

export const createRandomHandleName = (): string => {
    let result = '';
    const characters = 'abcdefghijklmnopqrstuvwxyz0123456789_.-';
    let counter = 0;
    while (counter < Math.ceil(Math.random() * 15)) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
        counter += 1;
    }
    return result;
};

export const performRandomHandleUpdates = async (store: RedisHandlesStore, count: number, beginningSlot = 0) => {
    const repo = new HandlesRepository(store);
    for (let i = 0; i < count; i++) {
        switch (i % 3) {
            case 0: { // add
                const handleName = createRandomHandleName();
                if (!repo.getHandle(handleName)) {
                    const newHandle = await repo.Internal.buildHandle({
                        name: handleName,
                        hex: Buffer.from(handleName).toString('hex'),
                        policy,
                        image: `ipfs://${Buffer.from(handleName).toString('hex')}`,
                        og_number: Math.floor(Math.random() * 2438),
                        handle_type: HandleType.HANDLE,
                        utxo: createRandomUtxo(),
                        lovelace: 0,
                        resolved_addresses: {ada: createRandomAddress()},
                        updated_slot_number: beginningSlot + i
                    });
                    repo.updateHolder(newHandle);
                    repo.save(newHandle);
                }
                break;
            }
            case 1: { // update
                const handleNames = (repo.search().handles as StoredHandle[]).map(h => h.name);
                const oldHandle = repo.getHandle(handleNames[Math.floor(Math.random() * handleNames.length)]) ?? undefined;
                const handle = {
                    ...oldHandle,
                    utxo: createRandomUtxo(),
                    resolved_addresses: { ada: createRandomAddress() },
                    updated_slot_number: beginningSlot + i
                } as StoredHandle;
                repo.updateHolder(handle)
                repo.save(handle, oldHandle);
                break;
            }
            case 2: { // remove
                const handleNames = (repo.search().handles as StoredHandle[]).map(h => h.name);
                const handle = repo.getHandle(handleNames[Math.floor(Math.random() * handleNames.length)]);
                if (handle)
                    repo.removeHandle(handle);
                break;
            }
        }
    }
};
