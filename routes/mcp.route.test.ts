import { HttpException } from '@koralabs/kora-labs-common';
import * as cbor from '@koralabs/kora-labs-common/utils/cbor';
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

const mockGetHandle = jest.fn((handleName: string) => (handleName === 'burritos' ? handleRecord : null));
const mockGetHandleByHex = jest.fn((hex: string) => (hex === Buffer.from('burritos', 'utf8').toString('hex') ? handleRecord : null));
const mockGetUTxO = jest.fn((utxoId: string) => (utxoId === 'tx_id#0' ? { tx_id: 'tx_id', index: 0, lovelace: 1000000 } : null));
const mockGetMetrics = jest.fn(() => ({ handleCount: 10, holderCount: 5 }));
const mockCurrentHttpStatus = jest.fn(() => 200);
const mockSearch = jest.fn((_pagination: unknown, _searchModel: unknown, namesOnly = false) => namesOnly
    ? { searchTotal: 1, handles: ['burritos'] }
    : { searchTotal: 1, handles: [handleRecord] });
const mockGetHolder = jest.fn((address: string) => {
    if (address !== 'addr1') return undefined;
    return {
        address,
        type: 'base',
        known_owner_name: '',
        default_handle: 'burritos',
        manually_set: false,
        total_handles: 1,
        handles: ['burritos']
    };
});
const mockGetAllHolders = jest.fn(({ includeHandles }: { includeHandles?: boolean }) => [{
    address: 'addr1',
    type: 'base',
    known_owner_name: '',
    default_handle: 'burritos',
    manually_set: false,
    total_handles: 1,
    handles: includeHandles ? ['burritos'] : []
}]);
const mockGetHandleDatumByName = jest.fn((handleName: string) => {
    if (handleName !== 'handle_policies') {
        throw new HttpException(404, 'Not found');
    }
    return 'd87980';
});

jest.mock('../repositories/handlesRepository', () => ({
    HandlesRepository: jest.fn().mockImplementation(() => ({
        getHandle: mockGetHandle,
        getHandleByHex: mockGetHandleByHex,
        getUTxO: mockGetUTxO,
        getMetrics: mockGetMetrics,
        currentHttpStatus: mockCurrentHttpStatus,
        search: mockSearch,
        getHolder: mockGetHolder,
        getAllHolders: mockGetAllHolders,
        getHandleDatumByName: mockGetHandleDatumByName
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
        jest.restoreAllMocks();
    });

    describe('[GET] /mcp', () => {
        it('returns 405 with capability descriptor body so clients probing GET can self-bootstrap', async () => {
            const response = await request(app?.getServer()).get('/mcp');

            expect(response.status).toEqual(405);
            expect(response.headers.allow).toEqual('POST');
            expect(response.headers['mcp-protocol-version']).toBeDefined();
            expect(response.body).toEqual(expect.objectContaining({
                error: 'method_not_allowed',
                message: expect.any(String),
                docs: expect.any(String),
                protocol: 'Model Context Protocol',
                transport: 'streamable-http',
                latest_protocol_version: expect.any(String),
                supported_protocol_versions: expect.arrayContaining([expect.any(String)]),
                server_info: expect.objectContaining({
                    name: 'api.handle.me',
                    version: expect.any(String)
                }),
                tools: expect.arrayContaining([
                    expect.objectContaining({ name: expect.any(String) })
                ]),
                links: expect.objectContaining({
                    openapi: '/openapi.json',
                    swagger_ui: '/swagger'
                })
            }));
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
                expect.arrayContaining([
                    'get_handle',
                    'get_handle_utxo',
                    'search_handles',
                    'get_holder',
                    'list_holders',
                    'get_policies',
                    'get_stats'
                ])
            );
        });

        it('should support slot-based handle search pagination', async () => {
            const response = await request(app?.getServer())
                .post('/mcp')
                .send({
                    jsonrpc: '2.0',
                    id: 21,
                    method: 'tools/call',
                    params: {
                        name: 'search_handles',
                        arguments: {
                            search: 'bur',
                            holder_address: 'addr1',
                            slot_number: 123456,
                            records_per_page: 10,
                            sort: 'asc',
                            names_only: true
                        }
                    }
                });

            expect(response.status).toEqual(200);
            expect(response.body.result.structuredContent).toEqual({
                status: 200,
                search_total: 1,
                handles: ['burritos']
            });
            expect(mockSearch).toHaveBeenCalledTimes(1);
            expect(mockSearch.mock.calls[0][0]).toEqual(expect.objectContaining({
                handlesPerPage: 10,
                sort: 'asc',
                slotNumber: 123456
            }));
            expect(mockSearch.mock.calls[0][1]).toEqual(expect.objectContaining({
                search: 'bur',
                holder_address: 'addr1'
            }));
            expect(mockSearch.mock.calls[0][2]).toEqual(true);
        });

        it('should reject page when slot_number is provided', async () => {
            const response = await request(app?.getServer())
                .post('/mcp')
                .send({
                    jsonrpc: '2.0',
                    id: 26,
                    method: 'tools/call',
                    params: {
                        name: 'search_handles',
                        arguments: {
                            slot_number: 123456,
                            page: 2
                        }
                    }
                });

            expect(response.status).toEqual(200);
            expect(response.body).toEqual({
                jsonrpc: '2.0',
                id: 26,
                result: {
                    content: [{ type: 'text', text: '`page` cannot be used with `slot_number`' }],
                    isError: true
                }
            });
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

        it('should call get_holder and return holder details', async () => {
            const response = await request(app?.getServer())
                .post('/mcp')
                .send({
                    jsonrpc: '2.0',
                    id: 22,
                    method: 'tools/call',
                    params: {
                        name: 'get_holder',
                        arguments: {
                            address: 'addr1'
                        }
                    }
                });

            expect(response.status).toEqual(200);
            expect(response.body.result.structuredContent).toEqual({
                status: 200,
                holder: {
                    address: 'addr1',
                    type: 'base',
                    known_owner_name: '',
                    default_handle: 'burritos',
                    manually_set: false,
                    total_handles: 1,
                    handles: ['burritos']
                }
            });
        });

        it('should call list_holders with pagination options', async () => {
            const response = await request(app?.getServer())
                .post('/mcp')
                .send({
                    jsonrpc: '2.0',
                    id: 23,
                    method: 'tools/call',
                    params: {
                        name: 'list_holders',
                        arguments: {
                            page: 1,
                            records_per_page: 25,
                            sort: 'desc',
                            include_handles: true
                        }
                    }
                });

            expect(response.status).toEqual(200);
            expect(response.body.result.structuredContent).toEqual({
                status: 200,
                holders: [{
                    address: 'addr1',
                    type: 'base',
                    known_owner_name: '',
                    default_handle: 'burritos',
                    manually_set: false,
                    total_handles: 1,
                    handles: ['burritos']
                }]
            });
            expect(mockGetAllHolders).toHaveBeenCalledWith({
                pagination: expect.objectContaining({
                    page: 1,
                    recordsPerPage: 25,
                    sort: 'desc'
                }),
                includeHandles: true
            });
        });

        it('should call get_policies and normalize policy keys', async () => {
            jest.spyOn(cbor, 'decodeCborToJson').mockReturnValue({
                '0xf0ff': [47931333, 0, 0]
            } as any);

            const response = await request(app?.getServer())
                .post('/mcp')
                .send({
                    jsonrpc: '2.0',
                    id: 24,
                    method: 'tools/call',
                    params: {
                        name: 'get_policies',
                        arguments: {}
                    }
                });

            expect(response.status).toEqual(200);
            expect(response.body.result.structuredContent).toEqual({
                status: 200,
                policies: {
                    f0ff: {
                        first_minting_slot: 47931333,
                        last_minting_slot: null,
                        sunset_slot: null
                    }
                }
            });
            expect(cbor.decodeCborToJson).toHaveBeenCalledWith({
                cborString: 'd87980',
                schema: {},
                defaultKeyType: 'hex'
            });
        });

        it('should return null policies when handle_policies is missing', async () => {
            mockGetHandleDatumByName.mockImplementationOnce(() => {
                throw new HttpException(404, 'Not found');
            });

            const response = await request(app?.getServer())
                .post('/mcp')
                .send({
                    jsonrpc: '2.0',
                    id: 25,
                    method: 'tools/call',
                    params: {
                        name: 'get_policies',
                        arguments: {}
                    }
                });

            expect(response.status).toEqual(200);
            expect(response.body.result.structuredContent).toEqual({
                status: 200,
                policies: null
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
