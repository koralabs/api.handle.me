import request from 'supertest';
import App from '../app';

jest.mock('../services/ogmios/ogmios.service');

const handleRecord = {
    name: 'burritos',
    utxo: 'tx_id#0',
    policy: 'f0ff',
    resolved_addresses: { ada: 'addr1' }
};
const handleHex = Buffer.from('burritos', 'utf8').toString('hex');
const mockGetMetrics = jest.fn(() => ({ handleCount: 12, holderCount: 7 }));
const mockCurrentHttpStatus = jest.fn(() => 200);
const mockGetHandle = jest.fn((handleName: string) => handleName === 'burritos'
    ? handleRecord
    : null);
const mockGetHandleByHex = jest.fn((hex: string) => hex === handleHex ? handleRecord : null);
const mockGetUTxO = jest.fn((utxoId: string) => utxoId === 'tx_id#0'
    ? { tx_id: 'tx_id', index: 0, lovelace: 1000000 }
    : null);
const mockSearch = jest.fn((_pagination: unknown, _searchModel: unknown, namesOnly = false) => ({
    searchTotal: 1,
    handles: namesOnly ? ['burritos'] : [handleRecord]
}));
const mockGetHolder = jest.fn(() => null);
const mockGetAllHolders = jest.fn(() => []);

jest.mock('../repositories/handlesRepository', () => ({
    HandlesRepository: jest.fn().mockImplementation(() => ({
        getMetrics: mockGetMetrics,
        currentHttpStatus: mockCurrentHttpStatus,
        getHandle: mockGetHandle,
        getHandleByHex: mockGetHandleByHex,
        getUTxO: mockGetUTxO,
        search: mockSearch,
        getHolder: mockGetHolder,
        getAllHolders: mockGetAllHolders
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

    // Invariant: hex handle requests resolve through the hex lookup path and return the matching handle.
    // Failure mode: ignoring the hex flag would query the plain-text index and return the wrong result.
    // Negative control: setting hex to false makes the hex lookup assertion fail.
    it('resolves a handle by hexadecimal asset name', async () => {
        const response = await callTool(36, 'get_handle', { handle: handleHex, hex: true });

        expect(response.status).toEqual(200);
        expect(response.body.result.structuredContent).toEqual(expect.objectContaining({
            status: 200,
            handle: expect.objectContaining({ name: 'burritos', utxo: 'tx_id#0' })
        }));
        expect(mockGetHandleByHex).toHaveBeenCalledWith(handleHex);
        expect(mockGetHandle).not.toHaveBeenCalled();
    });

    // Invariant: names-only searches return the repository's names without constructing handle views.
    // Failure mode: the flag could be dropped and expose full handle records instead of names.
    // Negative control: changing names_only to false makes the exact handles assertion fail.
    it('returns only names when search_handles requests names_only', async () => {
        const response = await callTool(37, 'search_handles', {
            search: 'bur',
            records_per_page: 25,
            names_only: true
        });

        expect(response.status).toEqual(200);
        expect(response.body.result.structuredContent).toEqual({
            status: 200,
            search_total: 1,
            handles: ['burritos']
        });
        expect(mockSearch).toHaveBeenCalledWith(expect.anything(), expect.anything(), true);
    });

    // Invariant: searches reject non-positive page values before querying storage.
    // Failure mode: zero or negative pages could produce unstable offsets or duplicate results.
    // Negative control: changing page to one causes the repository search to run instead.
    it('rejects a zero search page before repository access', async () => {
        const response = await callTool(38, 'search_handles', { page: 0 });

        expect(response.status).toEqual(200);
        expect(response.body.result).toEqual({
            content: [{ type: 'text', text: '`page` and `records_per_page` must be positive numbers' }],
            isError: true
        });
        expect(mockSearch).not.toHaveBeenCalled();
    });

    // Invariant: holder lookup requires a non-empty address before repository access.
    // Failure mode: empty addresses could be treated as broad or ambiguous holder queries.
    // Negative control: supplying addr1 causes the repository lookup assertion to fail.
    it('rejects an empty holder address before repository access', async () => {
        const response = await callTool(39, 'get_holder', { address: '' });

        expect(response.status).toEqual(200);
        expect(response.body.result).toEqual({
            content: [{ type: 'text', text: '`address` must be a non-empty string' }],
            isError: true
        });
        expect(mockGetHolder).not.toHaveBeenCalled();
    });

    // Invariant: holder lists accept only deterministic ascending or descending sort orders.
    // Failure mode: unsupported sorting could leak into repository pagination and reorder pages unpredictably.
    // Negative control: changing sort to desc causes the holder repository to run instead.
    it('rejects unsupported holder sorting before repository access', async () => {
        const response = await callTool(40, 'list_holders', { sort: 'random' });

        expect(response.status).toEqual(200);
        expect(response.body.result).toEqual({
            content: [{ type: 'text', text: '`sort` must be one of: asc, desc' }],
            isError: true
        });
        expect(mockGetAllHolders).not.toHaveBeenCalled();
    });
});
