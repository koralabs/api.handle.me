import { scripts } from '../config/scripts';
import { ScriptDetails, ScriptType } from '@koralabs/kora-labs-common';
import ScriptsController from './scripts.controller'

const mockResponse = () => {
    const res = {json: jest.fn(), status: jest.fn(), send: jest.fn()};
    res.json = jest.fn().mockReturnValue(res);
    res.send = jest.fn().mockReturnValue(res);
    res.status = jest.fn().mockReturnValue(res);
    return res;
}

afterAll(async () => {
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 500));
});

describe('Scripts Routes Test', () => {
    const originalNetwork = process.env.NETWORK;

    afterAll(() => {
        process.env.NETWORK = originalNetwork;
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('[GET] /scripts', () => {
        it('Should only find 1 latest script for each type and network', async () => {
            const mainnet = scripts.mainnet;
            const preprod = scripts.preprod;
            const preview = scripts.preview;

            expect(Object.values(mainnet).filter((script) => script.latest && script.type === ScriptType.PZ_CONTRACT).length).toEqual(1);
            expect(Object.values(preprod).filter((script) => script.latest && script.type === ScriptType.PZ_CONTRACT).length).toEqual(1);
            expect(Object.values(preview).filter((script) => script.latest && script.type === ScriptType.PZ_CONTRACT).length).toEqual(1);
            // types
            // expect(Object.values(mainnet).filter((script) => script.latest && script.type === ScriptType.SUB_HANDLE_SETTINGS).length).toEqual(1);
            // expect(Object.values(preprod).filter((script) => script.latest && script.type === ScriptType.SUB_HANDLE_SETTINGS).length).toEqual(1);
            expect(Object.values(preview).filter((script) => script.latest && script.type === ScriptType.SUB_HANDLE_SETTINGS).length).toEqual(1);
        });

        it('Should return scripts data', async () => {
            const scriptsController = new ScriptsController();
            const response = mockResponse();
            await scriptsController.index(
                // @ts-expect-error
                {query: {}},
                response,
                () => {}
            );
            expect(response.status).toHaveBeenCalledTimes(0);
            expect(response.json).toHaveBeenCalledWith(scripts[process.env.NETWORK ?? 'preview']);
        });

        it('Should return latest pz_contract script with only latest param', async () => {
            const network = process.env.NETWORK ?? 'preview';
            const [key, latestScript] = Object.entries(scripts[network]).find(([_, value]) => value.latest && value.type === ScriptType.PZ_CONTRACT) as [string, ScriptDetails];
            delete latestScript.cbor;
            delete latestScript.refScriptAddress;
            delete latestScript.refScriptUtxo;
            const scriptsController = new ScriptsController();
            const response = mockResponse();
            await scriptsController.index(
                // @ts-expect-error
                {query: {latest: true}},
                response,
                () => {}
            );

            expect(response.status).toHaveBeenCalledTimes(0);
            expect(response.json).toHaveBeenCalledWith({
                ...latestScript,
                scriptAddress: key
            });
        });

        it('Should return latest sub_handle_settings script', async () => {
            const network = process.env.NETWORK ?? 'preview';
            const [key, latestScript] = Object.entries(scripts[network]).find(([_, value]) => value.latest && value.type === ScriptType.SUB_HANDLE_SETTINGS) as [string, ScriptDetails];
            delete latestScript.cbor;
            delete latestScript.refScriptAddress;
            delete latestScript.refScriptUtxo;
            const scriptsController = new ScriptsController();
            const response = mockResponse();
            await scriptsController.index(
                // @ts-expect-error
                {query: {latest: true, type: ScriptType.SUB_HANDLE_SETTINGS}},
                response,
                () => {}
            );

            expect(response.status).toHaveBeenCalledTimes(0);
            expect(response.json).toHaveBeenCalledWith({
                ...latestScript,
                scriptAddress: key
            });
        });

        it('Should return 404 when latest script is requested for unknown type', async () => {
            const scriptsController = new ScriptsController();
            const response = mockResponse();
            await scriptsController.index(
                // @ts-expect-error
                {query: {latest: true, type: 'unknown'}},
                response,
                () => {}
            );

            expect(response.status).toHaveBeenCalledWith(404);
            expect(response.send).toHaveBeenCalledWith({ message: 'Latest script not found' });
        });

        it('Should fall back to preview network when NETWORK env is missing', async () => {
            delete process.env.NETWORK;
            const scriptsController = new ScriptsController();
            const response = mockResponse();

            await scriptsController.index(
                // @ts-expect-error
                {query: {}},
                response,
                () => {}
            );

            expect(response.json).toHaveBeenCalledWith(scripts.preview);
        });
    });
});
