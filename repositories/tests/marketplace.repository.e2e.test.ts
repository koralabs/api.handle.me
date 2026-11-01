import { AssetNameLabel, bech32AddressFromHashes, blake2b, buildHolderInfo, HandleType, IndexNames, UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import { encodeJsonToDatum } from '@koralabs/kora-labs-common/utils/cbor';
import request from 'supertest';
import App from '../../app';
import { RedisHandlesStore } from '../../stores/redis';
import { HandlesRepository } from '../handlesRepository';

const policy = 'f0'.repeat(28);
const owner = 'aa'.repeat(28);
const stake = 'bb'.repeat(28);
const validator = blake2b(Buffer.from('024e4d1001', 'hex'), 28);
const seller = bech32AddressFromHashes(owner, 'key', stake, 'key', 'addr', true);
const holder = buildHolderInfo(seller).address;
const address = bech32AddressFromHashes(validator, 'script', stake, 'key', 'addr', true);

describe('marketplace listing API with Valkey indexes', () => {
    const store = new RedisHandlesStore();
    const repo = new HandlesRepository(store);
    let app: App;
    let datum: string;

    const saveHandle = (name: string, resolvedAddress: string, script?: { cbor: string; type: string }) => {
        const hex = `${AssetNameLabel.LBL_222}${Buffer.from(name).toString('hex')}`;
        const handle = repo.Internal.buildHandle({
            name, hex, policy, utxo: `${name}#0`, lovelace: 2_000_000,
            handle_type: name.includes('@') ? HandleType.NFT_SUBHANDLE : HandleType.HANDLE,
            resolved_addresses: { ada: resolvedAddress }, updated_slot_number: 900,
            script
        });
        repo.updateHolder(handle);
        repo.save(handle);
        return handle;
    };

    beforeAll(async () => {
        if (process.env.REDIS_PORT !== '6380') throw new Error('Marketplace integration tests require test Valkey port 6380');
        await repo.initialize();
        app = new App({ disableOgmios: true });
        await app.initialize();
        app.getServer().set('registry', { handlesStore: RedisHandlesStore });
        datum = await encodeJsonToDatum({ constructor_0: [[{
            constructor_0: [{ constructor_0: [
                { constructor_0: [`0x${owner}`] },
                { constructor_0: [{ constructor_0: [{ constructor_0: [`0x${stake}`] }] }] }
            ] }, 7_000_000]
        }], `0x${owner}`] }, { defaultToText: false });
    });

    beforeEach(() => {
        repo.rollBackToGenesis();
        saveHandle('mkpl1@handlecontract', seller, { cbor: '4e4d1001', type: 'plutus_v2' });
        for (const name of ['alpha', 'broken']) {
            const handle = saveHandle(name, address);
            repo.addUTxO({
                id: handle.utxo, tx_id: name, index: 0, slot: 900, blockHash: 'block', blockNum: 1,
                address, lovelace: 2_000_000, datum: name === 'broken' ? 'deadbeef' : datum,
                handles: [[policy, [handle.hex]]], mint: [], metadata: {}
            } as UTxOWithTxInfo);
        }
        repo.setMetrics({ lastSlot: 1000, currentSlot: 1000 });
    });
    afterAll(() => repo.destroy());

    // Feature: actual persisted script/payment indexes produce a complete BFF-compatible listing.
    // Failure: wrong index names, Valkey rehydration, or script discovery produces missing/wrong assets.
    // Negative control: deleting alpha's persisted UTxO makes the same request return an empty array.
    it('serves persisted listings and omits malformed or removed UTxOs', async () => {
        const res = await request(app.getServer()).get('/marketplace/listings');
        expect(res.status).toBe(200);
        expect(res.headers['x-total-count']).toBe('1');
        expect(res.body).toEqual([expect.objectContaining({
            assetName: 'alpha', assetNameHex: `${AssetNameLabel.LBL_222}${Buffer.from('alpha').toString('hex')}`,
            policyId: policy, holder, payoutAddress: seller, price: 7_000_000, slotNumber: 900,
            utxo: expect.objectContaining({ id: 'alpha#0', address, datum })
        })]);
        store.removeKeyFromIndex(IndexNames.UTXO, 'alpha#0');
        const removed = await request(app.getServer()).get('/marketplace/listings');
        expect(removed.status).toBe(200);
        expect(removed.body).toEqual([]);
        expect(removed.headers['x-total-count']).toBe('0');
    });

    // Feature: seller filters find staked script outputs and compose with name searches.
    // Failure: filtering the validator instead of the seller stake empties a seller's marketplace.
    // Negative control: a different stake credential must return [] for the same indexed asset.
    it('filters persisted listings by seller and substring', async () => {
        const matched = await request(app.getServer()).get('/marketplace/listings').query({ holder_address: holder, search: 'ALP' });
        expect(matched.status).toBe(200);
        expect(matched.body.map((item: { assetName: string }) => item.assetName)).toEqual(['alpha']);
        const other = buildHolderInfo(bech32AddressFromHashes(owner, 'key', 'cc'.repeat(28), 'key', 'addr', true)).address;
        const empty = await request(app.getServer()).get('/marketplace/listings').query({ holder_address: other });
        expect(empty.status).toBe(200);
        expect(empty.body).toEqual([]);
    });

    // Feature: invalid requests remain client errors even with real storage available.
    // Failure: unchecked structured queries fail late as 500 or return unfiltered records.
    // Negative control: changing the query to search=alpha makes it return the persisted listing.
    it('rejects invalid shapes without affecting existing handle lookups', async () => {
        const invalid = await request(app.getServer()).get('/marketplace/listings?search[x]=alpha');
        expect(invalid.status).toBe(400);
        expect(invalid.body.error).toBe('bad_request');
        const existing = await request(app.getServer()).get('/handles/alpha');
        expect(existing.status).toBe(200);
        expect(existing.body).toEqual(expect.objectContaining({ name: 'alpha', policy }));
    });
});
