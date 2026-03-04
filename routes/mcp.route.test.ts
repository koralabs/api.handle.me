import request from 'supertest';
import App from '../app';

jest.mock('../services/ogmios/ogmios.service');

const handleRecord = {
    name: 'burritos',
    utxo: 'tx_id#0',
    policy: 'f0ff',
    resolved_addresses: {
        ada: 'addr1'
    }
};

jest.mock('../repositories/handlesRepository', () => ({
    HandlesRepository: jest.fn().mockImplementation(() => ({
        getHandle: (handleName: string) => (handleName === 'burritos' ? handleRecord : null),
        getHandleByHex: (hex: string) => (hex === Buffer.from('burritos', 'utf8').toString('hex') ? handleRecord : null),
        getUTxO: (utxoId: string) => (utxoId === 'tx_id#0' ? { tx_id: 'tx_id', index: 0, lovelace: 1000000 } : null),
        getMetrics: () => ({ handleCount: 10, holderCount: 5 }),
        currentHttpStatus: () => 200,
        search: (_pagination: unknown, _searchModel: unknown, namesOnly = false) => namesOnly
            ? { searchTotal: 1, handles: ['burritos'] }
            : { searchTotal: 1, handles: [handleRecord] }
    }))
}));

afterAll(async () => {
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 500));
});

describe('MCP Routes Test', () => {
    let app: App | null;

    beforeEach(async () => {
        app = await new App().initialize();
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe('[GET] /mcp', () => {
        it('should return 405 when streamable-http GET/SSE is disabled', async () => {
            const response = await request(app?.getServer()).get('/mcp');

            expect(response.status).toEqual(405);
            expect(response.headers.allow).toEqual('POST');
            expect(response.body).toEqual({
                message: 'SSE transport is not enabled. Use POST /mcp with JSON-RPC.'
            });
        });
    });

    describe('[POST] /mcp', () => {
        it('should return initialize handshake with tools capability', async () => {
            const response = await request(app?.getServer())
                .post('/mcp')
                .send({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: { protocolVersion: '2025-11-25' }
                });

            expect(response.status).toEqual(200);
            expect(response.headers['mcp-protocol-version']).toEqual('2025-11-25');
            expect(response.body).toEqual({
                jsonrpc: '2.0',
                id: 1,
                result: {
                    protocolVersion: '2025-11-25',
                    capabilities: {
                        tools: {
                            listChanged: false
                        }
                    },
                    serverInfo: {
                        name: 'api.handle.me',
                        version: expect.any(String)
                    }
                }
            });
        });

        it('should list MCP tools', async () => {
            const response = await request(app?.getServer())
                .post('/mcp')
                .send({
                    jsonrpc: '2.0',
                    id: 2,
                    method: 'tools/list'
                });

            expect(response.status).toEqual(200);
            expect(response.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual(
                expect.arrayContaining(['get_handle', 'get_handle_utxo', 'search_handles', 'get_stats'])
            );
        });

        it('should call get_handle and return structured content', async () => {
            const response = await request(app?.getServer())
                .post('/mcp')
                .send({
                    jsonrpc: '2.0',
                    id: 3,
                    method: 'tools/call',
                    params: {
                        name: 'get_handle',
                        arguments: {
                            handle: 'burritos'
                        }
                    }
                });

            expect(response.status).toEqual(200);
            expect(response.body).toMatchObject({
                jsonrpc: '2.0',
                id: 3,
                result: {
                    content: [{ type: 'text', text: expect.any(String) }],
                    structuredContent: {
                        status: 200,
                        handle: {
                            name: 'burritos',
                            utxo: 'tx_id#0',
                            policy: 'f0ff',
                            resolved_addresses: {
                                ada: 'addr1'
                            }
                        }
                    }
                }
            });
            expect(response.body.result).not.toHaveProperty('isError');
        });

        it('should return tool-level error for unknown tool name', async () => {
            const response = await request(app?.getServer())
                .post('/mcp')
                .send({
                    jsonrpc: '2.0',
                    id: 4,
                    method: 'tools/call',
                    params: {
                        name: 'unknown_tool',
                        arguments: {}
                    }
                });

            expect(response.status).toEqual(200);
            expect(response.body).toEqual({
                jsonrpc: '2.0',
                id: 4,
                result: {
                    content: [{ type: 'text', text: 'Unknown tool "unknown_tool"' }],
                    isError: true
                }
            });
        });

        it('should return 202 for notifications without response id', async () => {
            const response = await request(app?.getServer())
                .post('/mcp')
                .send({
                    jsonrpc: '2.0',
                    method: 'notifications/initialized'
                });

            expect(response.status).toEqual(202);
            expect(response.text).toEqual('');
        });

        it('should reject unsupported protocol versions in header', async () => {
            const response = await request(app?.getServer())
                .post('/mcp')
                .set('MCP-Protocol-Version', '2024-01-01')
                .send({
                    jsonrpc: '2.0',
                    id: 5,
                    method: 'tools/list'
                });

            expect(response.status).toEqual(400);
            expect(response.body).toEqual({
                jsonrpc: '2.0',
                id: null,
                error: {
                    code: -32600,
                    message: 'Unsupported MCP protocol version: 2024-01-01'
                }
            });
        });
    });
});
