import { Metadata } from '@cardano-ogmios/schema';
import { HandlePaginationModel, HandleSearchModel, HandleType, HolderPaginationModel, Rarity, StoredHandle, UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import * as config from '../../config';
import { MetadataLabel } from '../../interfaces/ogmios.interfaces';
import { RedisHandlesStore } from '../../stores/redis';
import { HandlesRepository } from '../handlesRepository';
import { handlesFixture } from './fixtures/handles';
const policy = 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a';

const firstSlot = Date.now();

const storeInstance = new RedisHandlesStore();
const repo = new HandlesRepository(storeInstance);
repo.initialize();
repo.rollBackToGenesis();

describe('Store Tests - RedisHandlesStore', () => {
    const expectedVirtualHandle = {
        amount: 1,
        bg_image: '',
        characters: 'letters',
        created_slot_number: 0,
        default_in_wallet: 'taco',
        has_datum: false,
        hex: Buffer.from('0000000076407461636f').toString('utf-8'),
        holder: 'stake_test1urc63cmezfacz9vrqu867axmqrvgp4zsyllxzud3k6danjsn0dn70',
        holder_type: 'wallet',
        image: '',
        image_hash: '',
        length: 6,
        name: 'v@taco',
        numeric_modifiers: '',
        og_number: 0,
        payment_key_hash: '9a2bb4492f1a7b2a1c10c8cc37fe3fe2b4e613704ba5331cb94b6388',
        personalization: {
            nsfw: false,
            trial: false,
            validated_by: ''
        },
        pfp_image: '',
        rarity: Rarity.common,
        reference_token: {
            address: '',
            datum: '',
            index: 0,
            lovelace: 0,
            tx_id: '',
            slot: 0,
            id: '',
            blockHash: '',
            blockNum: 0
        },
        resolved_addresses: {
            ada: 'addr_test1qzdzhdzf9ud8k2suzryvcdl78l3tfesnwp962vcuh99k8z834r3hjynmsy2cxpc04a6dkqxcsr29qfl7v9cmrd5mm89qfmc97q'
        },
        standard_image: '',
        standard_image_hash: '',
        svg_version: '',
        handle_type: HandleType.VIRTUAL_SUBHANDLE,
        updated_slot_number: handlesFixture[1].updated_slot_number - 30,
        last_update_address: '',
        utxo: '#0',
        lovelace: 0,
        version: 0,
        pz_enabled: false,
        policy
    };

    beforeAll(async () => {
        handlesFixture.map((handle) => {
            repo.updateHolder(handle);
            return repo.save(handle);
        });
        repo.updateHolder(expectedVirtualHandle);
        repo.save(repo.Internal.buildHandle(expectedVirtualHandle));
        repo.setMetrics({
            lastSlot: Date.now() + 10000,
            firstSlot
        });
        jest.clearAllMocks();
    });

    beforeEach(() => {
        jest.clearAllMocks();        
    });
    
    /*
     * IF YOU RUN THIS ONE REPO AT A TIME IT WORKS! ¯\_(ツ)_/¯
     * The issue is, when getKeysFromIndex is called, it returns the Handle names and not the Holder addresses.
     */
    describe('getAllHolders', () => {
        it('should get holderAddress list', async () => {
            const result = repo.getAllHolders({ pagination: new HolderPaginationModel() });
            expect(result).toEqual([
                {
                    address: 'stake_test1urc63cmezfacz9vrqu867axmqrvgp4zsyllxzud3k6danjsn0dn70',
                    default_handle: 'taco',
                    handles: [
                        'barbacoa',
                        'burrito',
                        'taco',
                        'v@taco'
                    ],
                    known_owner_name: '',
                    manually_set: false,
                    total_handles: 4,
                    type: 'wallet'
                }
            ]);
        });
    });

    describe('addUtxo', () => {
        it('should add Utxo', async () => {
            const slot = 123;
            const metadata: Metadata = {
                hash: '',
                labels: {
                    [MetadataLabel.NFT]: {
                        json: {
                            [policy]: {
                                handle1: {}
                            }
                        }
                    }
                }
            };
            const utxo: UTxOWithTxInfo = {
                id: 'test-hash',
                slot,
                address: '',
                lovelace: 0,
                handles: [[policy, ['handle1', 'handle2']]],
                mint: [[policy, ['handle1', 'handle2']]],
                metadata,
                tx_id: '',
                index: 0,
                blockHash: '',
                blockNum: 0
            };

            repo.addUTxO(utxo);

            const result = repo.getUTxOs(slot);

            expect(result).toEqual([utxo]);

            repo.removeUTxOs([utxo.id]);

            const removedResult = repo.getUTxOs(slot);
            expect(removedResult).toEqual([]);
        });
    });

    describe('getAll', () => {
        it('should get all handles', async () => {
            const pagination = new HandlePaginationModel({ page: '1', handlesPerPage: '1', sort: 'asc' });
            const search = new HandleSearchModel({});
            const result = repo.search(pagination, search);
            expect(result).toEqual({ searchTotal: 4, handles: [handlesFixture[0]] });
        });

        it('should find handles by rarity', async () => {
            const pagination = new HandlePaginationModel();
            const search = new HandleSearchModel({ rarity: Rarity.common });
            const result = repo.search(pagination, search);
            expect(result).toEqual({ searchTotal: 3, handles: [handlesFixture[1], handlesFixture[2], expectedVirtualHandle] });
        });

        it('should no handles with compounded searches', async () => {
            const pagination = new HandlePaginationModel();
            const search = new HandleSearchModel({ rarity: Rarity.rare, length: '7', holder_address: 'stake_test1urc63cmezfacz9vrqu867axmqrvgp4zsyllxzud3k6danjsn0dn70' });
            const result = repo.search(pagination, search);
            expect(result).toEqual({ searchTotal: 0, handles: [] });
        });

        it('should find handle using search parameter', async () => {
            const pagination = new HandlePaginationModel();
            const search = new HandleSearchModel({ search: 'bur' });
            const result = repo.search(pagination, search);
            expect(result).toEqual({ searchTotal: 1, handles: [handlesFixture[1]] });
        });

        it('should find handles using holder_address parameter', async () => {
            const pagination = new HandlePaginationModel();
            const search = new HandleSearchModel({ holder_address: 'stake_test1urc63cmezfacz9vrqu867axmqrvgp4zsyllxzud3k6danjsn0dn70' });
            const result = repo.search(pagination, search);
            expect(result).toEqual({ searchTotal: handlesFixture.length + 1, handles: [...handlesFixture, expectedVirtualHandle] });
        });

        it('should find no handles using invalid holder_address parameter', async () => {
            const pagination = new HandlePaginationModel();
            const search = new HandleSearchModel({ holder_address: 'nope' });
            const result = repo.search(pagination, search);
            expect(result).toEqual({ searchTotal: 0, handles: [] });
        });

        it('should paginate handles by slot number', async () => {
            const { updated_slot_number } = handlesFixture[0];
            const pagination = new HandlePaginationModel({ slotNumber: `${updated_slot_number}`, handlesPerPage: '1' });
            const search = new HandleSearchModel({});
            const result = repo.search(pagination, search);
            expect(result).toEqual({ searchTotal: 4, handles: [handlesFixture[0]] });
        });

        it('should paginate handles by slot number and sort ascending by default', async () => {
            const { updated_slot_number } = handlesFixture[0];
            const pagination = new HandlePaginationModel({ slotNumber: `${updated_slot_number}` });
            const search = new HandleSearchModel({});
            const result = repo.search(pagination, search);
            expect(result).toEqual({ searchTotal: 4, handles: [handlesFixture[0], handlesFixture[1], handlesFixture[2]] });
        });

        it('should paginate handles by slot number and sort desc', async () => {
            const { updated_slot_number } = handlesFixture[1];
            const pagination = new HandlePaginationModel({ slotNumber: `${updated_slot_number}`, sort: 'desc' });
            const search = new HandleSearchModel({});
            const result = repo.search(pagination, search);
            expect(result).toEqual({ searchTotal: 4, handles: [handlesFixture[1], handlesFixture[0], expectedVirtualHandle] });
        });

        it('should find handles using handle_type parameter', async () => {
            const pagination = new HandlePaginationModel();
            const search = new HandleSearchModel({ handle_type: HandleType.VIRTUAL_SUBHANDLE });
            const result = repo.search(pagination, search);
            expect(result).toEqual({ searchTotal: 1, handles: [expectedVirtualHandle] });
        });

        it('should find handles by name using the handle parameter', async () => {
            const pagination = new HandlePaginationModel();
            const search = new HandleSearchModel({ handles: ['barbacoa', 'taco'] });
            const result = repo.search(pagination, search);
            expect(result).toEqual({ searchTotal: 2, handles: [handlesFixture[0], handlesFixture[2]] });
        });
    });

    describe('getAllHandleNames', () => {
        it('should get all handle names', async () => {
            jest.spyOn(RedisHandlesStore.prototype, 'getKeysFromIndex').mockReturnValue(handlesFixture.map((h) => h.name));
            const search = new HandleSearchModel({});
            const handles = repo.search(new HandlePaginationModel({ sort: 'asc' }), search);
            const result = (handles.handles as StoredHandle[]).map((h) => h.name);
            expect(result).toEqual(['barbacoa', 'burrito', 'taco']);
        });

        it('should search all handle names', async () => {
            jest.spyOn(RedisHandlesStore.prototype, 'getKeysFromIndex').mockReturnValue(handlesFixture.map((h) => h.name));
            const search = new HandleSearchModel({
                length: '4'
            });
            const handles = repo.search(new HandlePaginationModel({ sort: 'asc' }), search);
            const result = (handles.handles as StoredHandle[]).map((h) => h.name);
            expect(result).toEqual(['taco']);
        });

        it('should search all handle names', async () => {
            jest.spyOn(RedisHandlesStore.prototype, 'getKeysFromIndex').mockReturnValue(handlesFixture.map((h) => h.name));
            const search = new HandleSearchModel({
                length: '4-7'
            });
            const handles = repo.search(new HandlePaginationModel({ sort: 'asc' }), search);
            const result = (handles.handles as StoredHandle[]).map((h) => h.name);
            expect(result).toEqual(['burrito', 'taco', 'v@taco']);
        });

        it('should sort handles randomly', async () => {
            jest.spyOn(RedisHandlesStore.prototype, 'getKeysFromIndex').mockReturnValue(handlesFixture.map((h) => h.name));
            const search = new HandleSearchModel();
            const pagination = new HandlePaginationModel({ sort: 'random' });
            const result1 = (repo.search(pagination, search).handles as StoredHandle[]).map((h) => h.name).join(',');
            const result2 = (repo.search(pagination, search).handles as StoredHandle[]).map((h) => h.name).join(',');
            const result3 = (repo.search(pagination, search).handles as StoredHandle[]).map((h) => h.name).join(',');
            const result4 = (repo.search(pagination, search).handles as StoredHandle[]).map((h) => h.name).join(',');
            const noWayTheyreEqual = result1 == result2 && result2 == result3 && result3 == result4;
            expect(noWayTheyreEqual).toEqual(false);
        });
    });

    describe('getHandleByName', () => {
        it('should get handle by name', async () => {
            const result = repo.getHandle('barbacoa');
            expect(result).toEqual(handlesFixture[0]);
        });
    });

    describe('getHolder', () => {
        it('should get holderAddress details', async () => {
            const result = repo.getHolder('stake_test1urc63cmezfacz9vrqu867axmqrvgp4zsyllxzud3k6danjsn0dn70');
            expect(result).toEqual({
                address: 'stake_test1urc63cmezfacz9vrqu867axmqrvgp4zsyllxzud3k6danjsn0dn70',
                known_owner_name: '',
                total_handles: 4,
                default_handle: 'taco',
                manually_set: false,
                handles: [
                    'barbacoa',
                    'burrito',
                    'taco',
                    'v@taco'
                ],
                type: 'wallet'
            });
        });
    });

    describe('getHandlesByStakeKeyHashes', () => {
        it('should get handles by stakeKeyHashes', async () => {
            const result = repo.getHandlesByStakeKeyHashes(['e0f1a8e379127b811583070faf74db00d880d45027fe6171b1b69bd9ca']);
            expect(result).toEqual(['barbacoa', 'burrito', 'taco', 'v@taco']);
        });
    });

    describe('getHandleStats', () => {
        it('should get metrics', () => {
            const result = repo.getMetrics();
            expect(result).toBeTruthy();
        });
    });

    describe('getHandleDatumByName', () => {
        const datum = 'a2some2key6another2key';
        beforeAll(async () => {
            jest.spyOn(config, 'isDatumEndpointEnabled').mockReturnValue(true);
            const handle = await repo.Internal.buildHandle({
                hex: Buffer.from('salsa').toString('hex'),
                name: 'salsa',
                og_number: 0,
                image: '',
                utxo: 'test_tx#0',
                lovelace: 0,
                datum,
                image_hash: '',
                svg_version: '',
                handle_type: HandleType.HANDLE,
                policy,
                resolved_addresses: { ada: 'addr_test1qzdzhdzf9ud8k2suzryvcdl78l3tfesnwp962vcuh99k8z834r3hjynmsy2cxpc04a6dkqxcsr29qfl7v9cmrd5mm89qfmc97q' },
                updated_slot_number: 0
            });
            const difHandle = {
                ...handle,
                hex: Buffer.from('pollo-verde').toString('hex'),
                name: 'pollo-verde',
                utxo: ''
            }
            await Promise.all([
                repo.updateHolder(handle),
                repo.updateHolder(difHandle),
                repo.save(handle),
                repo.save(difHandle)
            ]);
        });

        it('should not get datum if has_datum is false', () => {
            const result = repo.getHandleDatumByName('barbacoa');

            expect(result).toEqual(null);
        });

        it('should get handle datum by name', () => {
            const result = repo.getHandleDatumByName('salsa');
            expect(result).toEqual(datum);
        });

        it('should not find handle when utxo is empty (100 before 222 token)', () => {
            try {
                repo.getHandleDatumByName('pollo-verde');
                throw new Error('expected error');
            } catch (error: any) {
                expect(error.message).toEqual('Not found');
            }
        });
    });

    describe('getSubHandles', () => {
        const rootHandleName = 'chili-verde';
        const subHandle = `taco@${rootHandleName}`;

        beforeAll(async () => {
            const handle = await repo.Internal.buildHandle({
                hex: Buffer.from(subHandle).toString('hex'),
                name: subHandle,
                og_number: 0,
                image: '',
                utxo: 'test_tx#0',
                lovelace: 0,
                datum: 'a2some2key6another2key',
                image_hash: '',
                svg_version: '',
                handle_type: HandleType.NFT_SUBHANDLE,
                policy,
                resolved_addresses: { ada: 'addr_test1qzdzhdzf9ud8k2suzryvcdl78l3tfesnwp962vcuh99k8z834r3hjynmsy2cxpc04a6dkqxcsr29qfl7v9cmrd5mm89qfmc97q' },
                updated_slot_number: 0
            });
            await Promise.all([
                repo.updateHolder(handle),
                repo.save(handle)
            ]);
        });

        it('should get subhandles for root handle', async () => {
            const result = repo.getSubHandlesByRootHandle(rootHandleName);
            expect(result.length).toEqual(1);
            expect(result).toEqual(expect.arrayContaining([expect.objectContaining({ name: subHandle })]));
        });
    });
});
