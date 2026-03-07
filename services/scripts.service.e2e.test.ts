import { bech32AddressFromHashes, decodeAddress, HandleType, ScriptType } from '@koralabs/kora-labs-common';
import { RedisHandlesStore } from '../stores/redis';
import { IRegistry } from '../interfaces/registry.interface';
import { HandlesRepository } from '../repositories/handlesRepository';
import { getScriptByRefAddress, getScriptsIndex } from './scripts.service';

const previewRefAddresses = [
    'addr_test1xqvz92m0wjyd6tk2g7khfr2rsy4m2v8wu7ctv4jlr8mxl6ccy24k7aygm5hv53adwjx58qftk5cwaeasket97x0kdl4smpxnjx',
    'addr_test1wr97aqagfyj68389dw3xwaefndftae9ua8mpv07vsjdg7jgh8mxmh',
    'addr_test1wqufkpfr0cfg9k430terz8gl0yqv8r8gep82tv9086yv3cck0h26m'
];

const buildScriptAddress = (refScriptAddress: string) => {
    const validatorHash = decodeAddress(refScriptAddress)?.slice(2, 58);
    if (!validatorHash) {
        throw new Error(`Unable to derive validator hash from ${refScriptAddress}`);
    }

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

    beforeEach(() => {
        repo.rollBackToGenesis();

        [
            ['pz_contract1@handlecontract', previewRefAddresses[0], 'cbor1'],
            ['pz_contract2@handlecontract', previewRefAddresses[1], 'cbor2'],
            ['demi_mint3@handlecontract', previewRefAddresses[2], 'cbor3']
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

    it('builds a script catalog from indexed @handlecontract subhandles', () => {
        // Feature: the script resolver should read real indexed subhandles and key the catalog by derived script address.
        // Failure mode: a resolver bug could key entries by refScriptAddress or miss the highest ordinal latest selection.
        // Negative control: if `pz_contract2@handlecontract` were renamed to ordinal `1`, the latest assertion below would fail.
        const scripts = getScriptsIndex(req);

        expect(scripts).toEqual({
            [buildScriptAddress(previewRefAddresses[0])]: expect.objectContaining({
                handle: 'pz_contract1@handlecontract',
                refScriptAddress: previewRefAddresses[0],
                latest: false,
                type: ScriptType.PZ_CONTRACT
            }),
            [buildScriptAddress(previewRefAddresses[1])]: expect.objectContaining({
                handle: 'pz_contract2@handlecontract',
                refScriptAddress: previewRefAddresses[1],
                latest: true,
                type: ScriptType.PZ_CONTRACT
            }),
            [buildScriptAddress(previewRefAddresses[2])]: expect.objectContaining({
                handle: 'demi_mint3@handlecontract',
                refScriptAddress: previewRefAddresses[2],
                latest: true,
                type: ScriptType.DEMI_MINT
            })
        });
    });

    it('finds a script by refScriptAddress', () => {
        // Feature: non-`/scripts` callers should resolve script metadata from the handle-held reference script address.
        // Failure mode: address enrichment paths could stop working after removing the static lookup table.
        // Negative control: querying with an unknown refScriptAddress would return `undefined` instead of this script.
        expect(getScriptByRefAddress(req, previewRefAddresses[1])).toEqual(
            expect.objectContaining({
                handle: 'pz_contract2@handlecontract',
                refScriptAddress: previewRefAddresses[1],
                latest: true
            })
        );
    });
});
