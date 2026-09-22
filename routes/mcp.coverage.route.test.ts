import request from 'supertest';
import App from '../app';

jest.mock('../services/ogmios/ogmios.service');

const mockGetMetrics = jest.fn(() => ({ handleCount: 12, holderCount: 7 }));
const mockCurrentHttpStatus = jest.fn(() => 200);
const mockGetHandle = jest.fn((handleName: string) => handleName === 'burritos'
    ? { name: 'burritos', utxo: 'tx_id#0' }
    : null);
const mockGetHandleByHex = jest.fn(() => null);
const mockGetUTxO = jest.fn((utxoId: string) => utxoId === 'tx_id#0'
    ? { tx_id: 'tx_id', index: 0, lovelace: 1000000 }
    : null);

jest.mock('../repositories/handlesRepository', () => ({
    HandlesRepository: jest.fn().mockImplementation(() => ({
        getMetrics: mockGetMetrics,
        currentHttpStatus: mockCurrentHttpStatus,
        getHandle: mockGetHandle,
        getHandleByHex: mockGetHandleByHex,
        getUTxO: mockGetUTxO
    }))
}));

describe('MCP focused coverage', () => {
    let app: App;

    beforeAll(async () => {
        app = await new App().initialize();
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 500));
    });

    const callTool = (id: number, name: string, args: unknown) => request(app.getServer())
        .post('/mcp')
        .send({
            jsonrpc: '2.0',
            id,
            method: 'tools/call',
            params: { name, arguments: args }
        });

    // Invariant: clients receive the API health and exact repository totals from get_stats.
    // Failure mode: hard-coded or misnamed totals would return incorrect public statistics.
    // Negative control: changing handleCount from 12 to 13 makes the exact response assertion fail.
    it('returns current API statistics through get_stats', async () => {
        const response = await callTool(31, 'get_stats', {});

        expect(response.status).toEqual(200);
        expect(response.body.result.structuredContent).toEqual({
            status: 200,
            total_handles: 12,
            total_holders: 7
        });
        expect(mockGetMetrics).toHaveBeenCalledTimes(1);
        expect(mockCurrentHttpStatus).toHaveBeenCalledTimes(1);
    });

    // Invariant: get_handle_utxo resolves the named handle's referenced UTxO.
    // Failure mode: querying the wrong identifier would return a missing or unrelated UTxO.
    // Negative control: changing the requested handle to an unknown name makes the UTxO null.
    it('returns the referenced UTxO through get_handle_utxo', async () => {
        const response = await callTool(32, 'get_handle_utxo', { handle: 'burritos' });

        expect(response.status).toEqual(200);
        expect(response.body.result.structuredContent).toEqual({
            status: 200,
            utxo: { tx_id: 'tx_id', index: 0, lovelace: 1000000 }
        });
        expect(mockGetHandle).toHaveBeenCalledWith('burritos');
        expect(mockGetUTxO).toHaveBeenCalledWith('tx_id#0');
    });

    // Invariant: slot-based searches reject negative chain positions before querying storage.
    // Failure mode: a negative slot could create invalid pagination and misleading results.
    // Negative control: changing slot_number to zero removes the asserted tool error.
    it('rejects a negative search slot number', async () => {
        const response = await callTool(33, 'search_handles', { slot_number: -1 });

        expect(response.status).toEqual(200);
        expect(response.body.result).toEqual({
            content: [{ type: 'text', text: '`slot_number` must be a non-negative number' }],
            isError: true
        });
    });

    // Invariant: cursor searches remain deterministic and cannot request random sorting.
    // Failure mode: random ordering with a slot cursor could duplicate or skip handles.
    // Negative control: changing sort to asc removes the asserted tool error.
    it('rejects random sorting with slot-based pagination', async () => {
        const response = await callTool(34, 'search_handles', {
            slot_number: 123456,
            sort: 'random'
        });

        expect(response.status).toEqual(200);
        expect(response.body.result).toEqual({
            content: [{ type: 'text', text: '`sort` cannot be random when `slot_number` is provided' }],
            isError: true
        });
    });

    // Invariant: holder listings enforce the public maximum page size of 250 records.
    // Failure mode: oversized requests could bypass the API's bounded pagination contract.
    // Negative control: changing records_per_page to 250 removes the asserted tool error.
    it('rejects holder page sizes above the public maximum', async () => {
        const response = await callTool(35, 'list_holders', { records_per_page: 251 });

        expect(response.status).toEqual(200);
        expect(response.body.result).toEqual({
            content: [{ type: 'text', text: "'records_per_page' must be 250 or less" }],
            isError: true
        });
    });
});
