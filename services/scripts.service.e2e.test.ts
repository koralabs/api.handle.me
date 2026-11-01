import { bech32AddressFromHashes, blake2b, HandleType } from '@koralabs/kora-labs-common';
import { RedisHandlesStore } from '../stores/redis';
import { IRegistry } from '../interfaces/registry.interface';
import { HandlesRepository } from '../repositories/handlesRepository';
import { getMarketplaceValidatorHashes, getScriptsIndex } from './scripts.service';

const previewRefAddresses = [
    'addr_test1xqvz92m0wjyd6tk2g7khfr2rsy4m2v8wu7ctv4jlr8mxl6ccy24k7aygm5hv53adwjx58qftk5cwaeasket97x0kdl4smpxnjx',
    'addr_test1wr97aqagfyj68389dw3xwaefndftae9ua8mpv07vsjdg7jgh8mxmh',
    'addr_test1wqufkpfr0cfg9k430terz8gl0yqv8r8gep82tv9086yv3cck0h26m'
];

const buildScriptAddress = (scriptCbor: string) => {
    if (!/^[0-9a-f]+$/i.test(scriptCbor) || scriptCbor.length % 2 !== 0) {
        throw new Error(`Unable to derive validator hash from ${scriptCbor}`);
    }
    const validatorHash = blake2b(Buffer.from(`02${scriptCbor}`, 'hex'), 28);

    return bech32AddressFromHashes(validatorHash, 'script', '', 'key', 'addr', true);
};

describe('scripts service e2e', () => {
    const store = new RedisHandlesStore();
    const repo = new HandlesRepository(store);
    const registry: IRegistry = { handlesStore: RedisHandlesStore as any } as IRegistry;
    const req = {
        app: {
            get: (key: string) => key === 'registry' ? registry : undefined
        }
    } as any;

    beforeAll(async () => {
        process.env.NETWORK = 'preview';
        await repo.initialize();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    beforeEach(() => {
        repo.rollBackToGenesis();

        [
            ['pers1@handlecontract', previewRefAddresses[0], '4e4d1001'],
            ['pers2@handlecontract', previewRefAddresses[1], '4e4d1002'],
            ['demimnt3@handlecontract', previewRefAddresses[1], '4e4d1003']
        ].forEach(([name, address, cbor]) => {
            const handle = repo.Internal.buildHandle({
                name,
                hex: Buffer.from(name).toString('hex'),
                policy: 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a',
                handle_type: HandleType.NFT_SUBHANDLE,
                utxo: `${Buffer.from(name).toString('hex').slice(0, 16)}#0`,
                lovelace: 1,
                resolved_addresses: { ada: address },
                updated_slot_number: Date.now(),
                script: { cbor, type: 'plutus_v2' }
            });
            repo.updateHolder(handle);
            repo.save(handle);
        });
    });

    afterAll(() => {
        repo.destroy();
    });

    it('builds a script catalog from indexed @handlecontract subhandles', async () => {
        // Feature: the script resolver should read real indexed subhandles and key the catalog by derived script address.
        // Failure mode: a resolver bug could key entries by refScriptAddress or miss the highest ordinal latest selection.
        // Negative control: if `pers2@handlecontract` were renamed to ordinal `1`, the latest assertion below would fail.
        const scripts = await getScriptsIndex(req);

        expect(scripts).toEqual({
            [buildScriptAddress('4e4d1001')]: expect.objectContaining({
                handle: 'pers1@handlecontract',
                refScriptAddress: previewRefAddresses[0],
                latest: false,
                type: 'pers'
            }),
            [buildScriptAddress('4e4d1002')]: expect.objectContaining({
                handle: 'pers2@handlecontract',
                refScriptAddress: previewRefAddresses[1],
                latest: true,
                type: 'pers'
            }),
            [buildScriptAddress('4e4d1003')]: expect.objectContaining({
                handle: 'demimnt3@handlecontract',
                refScriptAddress: previewRefAddresses[1],
                latest: true,
                type: 'demimnt'
            })
        });
    });


    it('keeps the latest entry when two contract handles carry the same script', async () => {
        // Invariant: a `latest=true` persprx lookup always resolves while two ordinals share one script.
        // Failure caught: the non-latest persprx1 (processed after persprx2) overwrote persprx2 at the shared
        // address, leaving no latest persprx and failing every legacy mint during the mainnet repair window.
        // Negative control: restoring the unconditional `scripts[entry[0]] = entry[1]` makes this return persprx1.
        [
            ['persprx1@handlecontract', previewRefAddresses[0], '4e4d2001'],
            ['persprx2@handlecontract', previewRefAddresses[0], '4e4d2001']
        ].forEach(([name, address, cbor]) => {
            const handle = repo.Internal.buildHandle({
                name,
                hex: Buffer.from(name).toString('hex'),
                policy: 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a',
                handle_type: HandleType.NFT_SUBHANDLE,
                utxo: `${Buffer.from(name).toString('hex').slice(0, 16)}#0`,
                lovelace: 1,
                resolved_addresses: { ada: address },
                updated_slot_number: Date.now(),
                script: { cbor, type: 'plutus_v2' }
            });
            repo.updateHolder(handle);
            repo.save(handle);
        });

        const scripts = await getScriptsIndex(req, 'persprx');

        expect(scripts[buildScriptAddress('4e4d2001')]).toEqual(expect.objectContaining({
            handle: 'persprx2@handlecontract',
            latest: true
        }));
    });

    const saveScript = (name: string, cbor: string, type: string) => {
        const handle = repo.Internal.buildHandle({
            name,
            hex: Buffer.from(name).toString('hex'),
            policy: 'f0ff48bbb7bbe9d59a40f1ce90e9e9d0ff5002ec48f232b49ca0fb9a',
            handle_type: HandleType.NFT_SUBHANDLE,
            utxo: `${Buffer.from(name).toString('hex').slice(0, 16)}#0`,
            lovelace: 1,
            resolved_addresses: { ada: previewRefAddresses[2] },
            updated_slot_number: Date.now(),
            script: { cbor, type }
        });
        repo.updateHolder(handle);
        repo.save(handle);
    };

    it('narrows the catalog by family prefix and matches nothing for an unknown family', async () => {
        // Invariant: `type=pers` returns only pers-family scripts; an unknown type returns an empty catalog.
        // Failure caught: the startsWith filter being dropped would return demimnt3 too.
        // Negative control: removing the typeFilter check fails the first expectation.
        const pers = await getScriptsIndex(req, 'PERS');
        expect(Object.values(pers).map(s => s.handle).sort()).toEqual(['pers1@handlecontract', 'pers2@handlecontract']);
        expect(await getScriptsIndex(req, 'nope')).toEqual({});
    });

    it('derives the script address from the Plutus language tag and defaults unknown tags to V2', async () => {
        // Invariant: the same CBOR under V3 yields a different validator hash than V2; unknown types hash as V2.
        // Failure caught: ignoring script.type would give every language the V2 address.
        // Negative control: forcing tag '02' makes the V3 address equal the V2 one and fails the inequality.
        saveScript('mkpl1@handlecontract', '4e4d3001', 'plutusV3');
        saveScript('mkpl2@handlecontract', '4e4d3002', 'mystery');
        const scripts = await getScriptsIndex(req, 'mkpl');
        const v3 = blake2b(Buffer.from('034e4d3001', 'hex'), 28);
        const v2 = blake2b(Buffer.from('024e4d3001', 'hex'), 28);
        expect(v3).not.toEqual(v2);
        expect(Object.values(scripts).find(s => s.handle === 'mkpl1@handlecontract')?.validatorHash).toBe(v3);
        expect(Object.values(scripts).find(s => s.handle === 'mkpl2@handlecontract')?.validatorHash)
            .toBe(blake2b(Buffer.from('024e4d3002', 'hex'), 28));
        expect(getMarketplaceValidatorHashes(repo)).toEqual([v3, blake2b(Buffer.from('024e4d3002', 'hex'), 28)].sort());
    });

    it('skips scripts whose CBOR is not valid hex', async () => {
        // Invariant: malformed CBOR never produces a catalog entry or marketplace hash.
        // Failure caught: odd-length hex would be hashed into a bogus address.
        // Negative control: removing the length check lets the entry through and fails the empty expectation.
        saveScript('mkpl1@handlecontract', 'abc', 'plutus_v2');
        expect(await getScriptsIndex(req, 'mkpl')).toEqual({});
        expect(getMarketplaceValidatorHashes(repo)).toEqual([]);
    });

    it('fetches unoptimized CBOR once per family and ignores failed fetches', async () => {
        // Invariant: known families get unoptimizedCbor from the network-specific GitHub path, fetched once per family; failures leave it unset.
        // Failure caught: per-handle fetching, wrong URL, or a failed fetch breaking the catalog.
        // Negative control: removing the cache makes the call count 2 for pers.
        const fetchMock = jest.spyOn(global, 'fetch' as any).mockImplementation((async (url: string) =>
            url.includes('/pers.unoptimized.cbor')
                ? { ok: true, text: async () => ' deadbeef\n' }
                : { ok: false, text: async () => '' }) as any);
        const scripts = await getScriptsIndex(req);
        const byHandle = Object.fromEntries(Object.values(scripts).map(s => [s.handle, s.unoptimizedCbor]));
        expect(byHandle['pers1@handlecontract']).toBe('deadbeef');
        expect(byHandle['pers2@handlecontract']).toBe('deadbeef');
        expect(byHandle['demimnt3@handlecontract']).toBeUndefined();
        const urls = fetchMock.mock.calls.map(c => c[0]);
        expect(urls).toContain('https://raw.githubusercontent.com/koralabs/handles-personalization/master/deploy/preview/pers.unoptimized.cbor');
        expect(urls.filter(u => `${u}`.includes('/pers.unoptimized')).length).toBe(1);
    });
});
