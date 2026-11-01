import { AssetNameLabel, bech32AddressFromHashes, blake2b, buildHolderInfo, IApiStore, IndexNames, NETWORK, StoredHandle, UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import { encodeJsonToDatum } from '@koralabs/kora-labs-common/utils/cbor';
import request from 'supertest';
import App from '../app';

const testnet = NETWORK.toLowerCase() !== 'mainnet';
const policy = 'f0'.repeat(28);
const owner = 'aa'.repeat(28);
const stake = 'bb'.repeat(28);
const otherStake = 'cc'.repeat(28);
const validator = blake2b(Buffer.from('024e4d1001', 'hex'), 28);
const oldValidator = blake2b(Buffer.from('024e4d1002', 'hex'), 28);
const seller = bech32AddressFromHashes(owner, 'key', stake, 'key', 'addr', testnet);
const sellerStake = buildHolderInfo(seller).address;
const sellerEnterprise = bech32AddressFromHashes(owner, 'key', '', 'key', 'addr', testnet);
const payoutAddress = bech32AddressFromHashes(owner, 'key', stake, 'key', 'addr', testnet);
const listingAddress = bech32AddressFromHashes(validator, 'script', stake, 'key', 'addr', testnet);
const oldListingAddress = bech32AddressFromHashes(oldValidator, 'script', otherStake, 'key', 'addr', testnet);

// A storage-boundary fake: route, controller, script discovery, repository, and CBOR are real.
class MemoryStore {
    public hashes = new Map<string, unknown>();
    public sets = new Map<string, Set<string>>();
    public metrics = { lastSlot: 1000, currentSlot: 1000 };
    public key(index: IndexNames, key: string | number) { return `${index}:${key}`; }
    public getHashFromIndex(index: IndexNames, key: string) { return structuredClone(this.hashes.get(this.key(index, key))); }
    public getValuesFromIndexedSet(index: IndexNames, key: string) { return this.sets.get(this.key(index, key)); }
    public getMetrics() { return this.metrics; }
    public put(index: IndexNames, key: string, value: unknown) { this.hashes.set(this.key(index, key), value); }
    public add(index: IndexNames, key: string, value: string) {
        const values = this.sets.get(this.key(index, key)) ?? new Set<string>();
        values.add(value);
        this.sets.set(this.key(index, key), values);
    }
}

const addressData = {
    constructor_0: [
        { constructor_0: [`0x${owner}`] },
        { constructor_0: [{ constructor_0: [{ constructor_0: [`0x${stake}`] }] }] }
    ]
};
const datumWith = (amounts: number[] = [3_000_000, 2_000_000], ownerHash = owner, constructor = 'constructor_0') =>
    encodeJsonToDatum({ [constructor]: [amounts.map((amount) => ({ constructor_0: [structuredClone(addressData), amount] })), `0x${ownerHash}`] }, { defaultToText: false });

let store: MemoryStore;
let app: App;
let listingDatum: string;

const addScript = (name: string, cbor?: string, type = 'plutus_v2') => {
    store.add(IndexNames.SUBHANDLE, 'handlecontract', name);
    store.put(IndexNames.HANDLE, name, {
        name, hex: Buffer.from(name).toString('hex'), holder: sellerStake,
        resolved_addresses: { ada: seller }, script: cbor ? { cbor, type } : undefined
    });
};
const addListing = (name: string, address = listingAddress, datum = listingDatum, label: string = AssetNameLabel.LBL_222, hash = validator) => {
    const hex = `${label}${Buffer.from(name).toString('hex')}`;
    const id = `${name}#0`;
    store.put(IndexNames.HANDLE, name, { name, hex, policy, utxo: id, holder: sellerStake } as StoredHandle);
    store.put(IndexNames.UTXO, id, {
        id, tx_id: name, index: 0, slot: 900, blockHash: 'block', blockNum: 1,
        address, lovelace: 2_000_000, datum, handles: [[policy, [hex]]], mint: [], metadata: {}
    } as UTxOWithTxInfo);
    store.add(IndexNames.PAYMENT_KEY_HASH, hash, name);
};

describe('GET /marketplace/listings', () => {
    beforeAll(async () => {
        listingDatum = await datumWith();
        app = new App({ disableOgmios: true });
        await app.initialize();
    });
    beforeEach(() => {
        store = new MemoryStore();
        app.getServer().set('registry', { handlesStore: function () { return store as unknown as IApiStore; } });
        addScript('mkpl1@handlecontract', '4e4d1001');
        addScript('mkpl2@handlecontract', '4e4d1002');
        addScript('mkpl3@handlecontract');
        addScript('pers1@handlecontract', '4e4d1003');
        addListing('zebra', oldListingAddress, listingDatum, AssetNameLabel.LBL_222, oldValidator);
        addListing('alpha');
    });
    afterEach(() => jest.restoreAllMocks());

    // Feature: the BFF receives real listing fields across deployed versions in stable order.
    // Failure: missing route, enterprise-only address lookup, or incorrect payout sums lose listings.
    // Negative control: replacing validator payment-hash lookup with full-address lookup loses both fixtures.
    it('discovers the route and returns complete listing records without network reads', async () => {
        const fetch = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('network forbidden'));
        const res = await request(app.getServer()).get('/marketplace/listings');
        expect(res.status).toBe(200);
        expect(res.headers['x-total-count']).toBe('2');
        expect(res.body.map((item: { assetName: string }) => item.assetName)).toEqual(['alpha', 'zebra']);
        expect(res.body[0]).toEqual({
            assetName: 'alpha', assetNameHex: `${AssetNameLabel.LBL_222}${Buffer.from('alpha').toString('hex')}`,
            assetLabel: AssetNameLabel.LBL_222, policyId: policy, holder: sellerStake,
            payoutAddress, price: 5_000_000, slotNumber: 900,
            utxo: { id: 'alpha#0', tx_id: 'alpha', index: 0, slot: 900, blockHash: 'block', blockNum: 1,
                address: listingAddress, lovelace: 2_000_000, datum: listingDatum }
        });
        expect(fetch).not.toHaveBeenCalled();
    });

    // Feature: seller and substring filters compose on listing ownership rather than the validator.
    // Failure: using the marketplace address as seller or ignoring either filter returns the wrong assets.
    // Negative control: changing the requested seller stake to otherStake changes alpha to zebra.
    it('filters by seller stake, base, or payment credential and case-insensitive substring', async () => {
        for (const holder_address of [sellerStake, seller, sellerEnterprise]) {
            const res = await request(app.getServer()).get('/marketplace/listings').query({ holder_address, search: 'ALP' });
            expect(res.status).toBe(200);
            expect(res.body.map((item: { assetName: string }) => item.assetName)).toEqual(['alpha']);
            expect(res.headers['x-total-count']).toBe('1');
        }
        const other = buildHolderInfo(oldListingAddress).address;
        const res = await request(app.getServer()).get('/marketplace/listings').query({ holder_address: other });
        expect(res.body.map((item: { assetName: string }) => item.assetName)).toEqual(['zebra']);
    });

    // Feature: legacy and enterprise listings expose the datum owner and an empty legacy label.
    // Failure: treating the enterprise validator as the owner or requiring CIP-67 loses a valid listing.
    // Negative control: changing the datum owner changes the expected holder and filtered result.
    it('derives the seller for an enterprise legacy listing', async () => {
        addListing('legacy', bech32AddressFromHashes(validator, 'script', '', 'key', 'addr', testnet), listingDatum, '');
        const res = await request(app.getServer()).get('/marketplace/listings').query({ holder_address: sellerEnterprise, search: 'legacy' });
        expect(res.body).toEqual([expect.objectContaining({ assetName: 'legacy', assetLabel: '', holder: sellerEnterprise, price: 5_000_000 })]);
    });

    // Feature: no matches and no registered contracts return an explicit empty array.
    // Failure: leaking unfiltered data or treating absence as an exception breaks empty marketplace pages.
    // Negative control: switching the search to alpha makes the array non-empty.
    it('returns 200 and [] for no matches or no deployments', async () => {
        const res = await request(app.getServer()).get('/marketplace/listings?search=nomatch');
        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
        expect(res.headers['x-total-count']).toBe('0');
        store.sets.delete(store.key(IndexNames.SUBHANDLE, 'handlecontract'));
        const noContracts = await request(app.getServer()).get('/marketplace/listings');
        expect(noContracts.status).toBe(200);
        expect(noContracts.body).toEqual([]);
    });

    // Feature: malformed records cannot discard valid listings or become buyable assets.
    // Failure: trusting datum shape, numeric precision, or stale indexes returns invalid prices/UTxOs.
    // Negative control: removing per-entry validation adds invalid fixture names to this exact result.
    it('skips malformed, unsupported, unsafe, missing, stale, and reference-token records', async () => {
        addListing('bad-cbor', listingAddress, 'not-cbor');
        addListing('bad-owner', listingAddress, await datumWith([1], 'aa'));
        addListing('unsupported', listingAddress, await datumWith([1], owner, 'constructor_1'));
        addListing('empty-payouts', listingAddress, await datumWith([]));
        addListing('negative-price', listingAddress, await datumWith([-1]));
        addListing('unsafe-price', listingAddress, (await datumWith([3_000_000])).replace('1a002dc6c0', '1b0020000000000000'));
        addListing('overflow-total', listingAddress, (await datumWith([3_000_000, 1])).replace('1a002dc6c0', '1b001fffffffffffff'));
        addListing('no-utxo'); store.hashes.delete(store.key(IndexNames.UTXO, 'no-utxo#0'));
        addListing('wallet', seller);
        addListing('wrong-script', bech32AddressFromHashes('dd'.repeat(28), 'script', stake, 'key', 'addr', testnet));
        addListing('reference', listingAddress, listingDatum, AssetNameLabel.LBL_100);
        addListing('wrong-asset');
        const wrongAsset = store.hashes.get(store.key(IndexNames.UTXO, 'wrong-asset#0')) as UTxOWithTxInfo;
        wrongAsset.handles = [[policy, ['deadbeef']]];
        const res = await request(app.getServer()).get('/marketplace/listings');
        expect(res.status).toBe(200);
        expect(res.body.map((item: { assetName: string }) => item.assetName)).toEqual(['alpha', 'zebra']);
    });

    // Feature: invalid request shapes are clear 400s before storage is touched.
    // Failure: unchecked Express query values throw 500s or silently broaden filters.
    // Negative control: removing string/length/address guards makes these return 200 or 500.
    it.each([
        'search=ab', 'search=', 'search=alpha&search=zebra', 'search[x]=alpha', 'search[]=alpha',
        'holder_address=', 'holder_address=invalid', 'holder_address[x]=invalid',
        `holder_address=${sellerStake}&holder_address=${sellerStake}`, 'unknown=alpha',
        `holder_address=${bech32AddressFromHashes(owner, 'key', '', 'key', 'addr', !testnet)}`
    ])('rejects %s', async (query) => {
        const res = await request(app.getServer()).get(`/marketplace/listings?${query}`);
        expect(res.status).toBe(400);
        expect(res.body).toEqual(expect.objectContaining({ error: expect.stringMatching(/bad_request|unknown_query_params/), message: expect.any(String) }));
    });

    // Feature: marketplace reads preserve the existing freshness signal.
    // Failure: always returning 200 presents incomplete indexed data as current.
    // Negative control: hardcoding response status to 200 fails the 202 assertion.
    it('returns 202 with listing data while the index catches up', async () => {
        store.metrics = { lastSlot: 2000, currentSlot: 1000 };
        const res = await request(app.getServer()).get('/marketplace/listings');
        expect(res.status).toBe(202);
        expect(res.body.map((item: { assetName: string }) => item.assetName)).toEqual(['alpha', 'zebra']);
    });

    // Feature: storage outages remain failures, not misleading empty marketplaces.
    // Failure: a blanket repository catch converts operational failures to [].
    // Negative control: swallowing database errors makes the status 200 instead of 500.
    it('forwards storage failures to the error middleware', async () => {
        jest.spyOn(store, 'getHashFromIndex').mockImplementation(() => { throw new Error('storage unavailable'); });
        const res = await request(app.getServer()).get('/marketplace/listings');
        expect(res.status).toBe(500);
        expect(res.body.error).toBe('internal_error');
    });
});
