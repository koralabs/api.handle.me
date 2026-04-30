import { HandlePaginationModel, HandleSearchModel, HolderPaginationModel, HttpException } from '@koralabs/kora-labs-common';
import { NextFunction, Request, Response } from 'express';
import packageJson from '../package.json';
import { MAX_PAGINATED_RESULTS } from '../config/constants';
import { IRegistry } from '../interfaces/registry.interface';
import { HandleViewModel } from '../models/view/handle.view.model';
import { HandlesRepository } from '../repositories/handlesRepository';
import { decodePoliciesDatum, HANDLE_POLICIES_NAME } from '../utils/policies';

const LATEST_PROTOCOL_VERSION = '2025-11-25';
const SUPPORTED_PROTOCOL_VERSIONS = new Set<string>(['2025-03-26', '2025-06-18', LATEST_PROTOCOL_VERSION]);

const TOOL_DEFINITIONS = [
    {
        name: 'get_handle',
        description: 'Get a single handle by name or hex asset name',
        inputSchema: {
            type: 'object',
            properties: {
                handle: { type: 'string', description: 'Handle name or hex asset name when hex=true' },
                hex: { type: 'boolean', description: 'Set true to query by hex asset name' }
            },
            required: ['handle']
        }
    },
    {
        name: 'get_handle_utxo',
        description: 'Get the UTxO entry for a specific handle',
        inputSchema: {
            type: 'object',
            properties: {
                handle: { type: 'string', description: 'Handle name or hex asset name when hex=true' },
                hex: { type: 'boolean', description: 'Set true to query by hex asset name' }
            },
            required: ['handle']
        }
    },
    {
        name: 'search_handles',
        description: 'Search handles by substring with optional pagination',
        inputSchema: {
            type: 'object',
            properties: {
                search: { type: 'string', description: 'Substring to match in handle names' },
                holder_address: { type: 'string', description: 'Filter by holder address' },
                page: { type: 'integer', minimum: 1, description: '1-based page number (mutually exclusive with slot_number)' },
                slot_number: { type: 'integer', minimum: 0, description: 'Start pagination from this slot number (mutually exclusive with page)' },
                records_per_page: { type: 'integer', minimum: 1, description: 'Number of records per page' },
                sort: { type: 'string', enum: ['asc', 'desc', 'random'], description: 'Sort order' },
                names_only: { type: 'boolean', description: 'Return only handle names' }
            }
        }
    },
    {
        name: 'get_holder',
        description: 'Get holder details by address',
        inputSchema: {
            type: 'object',
            properties: {
                address: { type: 'string', description: 'Holder address' }
            },
            required: ['address']
        }
    },
    {
        name: 'list_holders',
        description: 'List holders with pagination',
        inputSchema: {
            type: 'object',
            properties: {
                page: { type: 'integer', minimum: 1, description: '1-based page number' },
                records_per_page: { type: 'integer', minimum: 1, maximum: MAX_PAGINATED_RESULTS, description: 'Number of records per page' },
                sort: { type: 'string', enum: ['asc', 'desc'], description: 'Sort order by holder count' },
                include_handles: { type: 'boolean', description: 'Include full holder handle lists' }
            }
        }
    },
    {
        name: 'get_policies',
        description: 'Get normalized handle policy settings',
        inputSchema: {
            type: 'object',
            properties: {}
        }
    },
    {
        name: 'get_stats',
        description: 'Get top-level handle and holder counts',
        inputSchema: {
            type: 'object',
            properties: {}
        }
    }
];

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
    jsonrpc: '2.0';
    id?: JsonRpcId;
    method?: string;
    params?: unknown;
}

interface JsonRpcSuccessResponse {
    jsonrpc: '2.0';
    id: JsonRpcId;
    result: unknown;
}

interface JsonRpcErrorResponse {
    jsonrpc: '2.0';
    id: JsonRpcId;
    error: {
        code: number;
        message: string;
    };
}

class MCPController {
    private static createRepo(req: Request): HandlesRepository {
        return new HandlesRepository(new (req.app.get('registry') as IRegistry).handlesStore());
    }

    private static parseRequest(body: unknown): JsonRpcRequest | null {
        if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
        return body as JsonRpcRequest;
    }

    private static jsonError(id: JsonRpcId, code: number, message: string): JsonRpcErrorResponse {
        return {
            jsonrpc: '2.0',
            id,
            error: { code, message }
        };
    }

    private static jsonResult(id: JsonRpcId, result: unknown): JsonRpcSuccessResponse {
        return {
            jsonrpc: '2.0',
            id,
            result
        };
    }

    private static respondWithProtocol(res: Response, body: JsonRpcErrorResponse | JsonRpcSuccessResponse, status = 200) {
        res
            .status(status)
            .set('MCP-Protocol-Version', LATEST_PROTOCOL_VERSION)
            .json(body);
    }

    private static toolResponse(payload: unknown, isError = false) {
        if (isError) {
            return {
                content: [{ type: 'text', text: String(payload) }],
                isError: true
            };
        }

        return {
            content: [{ type: 'text', text: JSON.stringify(payload) }],
            structuredContent: payload
        };
    }

    private static validateVersionHeader(req: Request): string | null {
        const requestedVersion = req.header('MCP-Protocol-Version');
        if (!requestedVersion) return null;
        if (SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion)) return null;
        return requestedVersion;
    }

    private static async callTool(name: string, args: unknown, req: Request): Promise<unknown> {
        const typedArgs = (args && typeof args === 'object') ? (args as Record<string, unknown>) : {};
        const handleRepo = MCPController.createRepo(req);

        if (name === 'get_stats') {
            const metrics = handleRepo.getMetrics();
            return {
                status: handleRepo.currentHttpStatus(),
                total_handles: metrics.handleCount ?? 0,
                total_holders: metrics.holderCount ?? 0
            };
        }

        if (name === 'search_handles') {
            const pageArg = typedArgs.page;
            const page = Number(pageArg ?? 1);
            const slotNumberArg = typedArgs.slot_number;
            const slotNumber = slotNumberArg === undefined ? undefined : Number(slotNumberArg);
            const recordsPerPage = Number(typedArgs.records_per_page ?? 100);
            const namesOnly = typedArgs.names_only === true;

            if (!Number.isFinite(page) || page <= 0 || !Number.isFinite(recordsPerPage) || recordsPerPage <= 0) {
                throw new Error('`page` and `records_per_page` must be positive numbers');
            }
            if (slotNumber !== undefined && (!Number.isFinite(slotNumber) || slotNumber < 0)) {
                throw new Error('`slot_number` must be a non-negative number');
            }
            if (slotNumber !== undefined && pageArg !== undefined) {
                throw new Error('`page` cannot be used with `slot_number`');
            }

            const sort = typedArgs.sort;
            if (sort && sort !== 'asc' && sort !== 'desc' && sort !== 'random') {
                throw new Error('`sort` must be one of: asc, desc, random');
            }
            if (slotNumber !== undefined && sort === 'random') {
                throw new Error('`sort` cannot be random when `slot_number` is provided');
            }

            const searchModel = new HandleSearchModel({
                search: typeof typedArgs.search === 'string' ? typedArgs.search : undefined,
                holder_address: typeof typedArgs.holder_address === 'string' ? typedArgs.holder_address : undefined
            });
            const pagination = new HandlePaginationModel({
                page: slotNumber === undefined ? `${page}` : undefined,
                handlesPerPage: `${recordsPerPage}`,
                sort: sort as 'asc' | 'desc' | 'random' | undefined,
                slotNumber: slotNumber === undefined ? undefined : `${slotNumber}`
            });

            const results = handleRepo.search(pagination, searchModel, namesOnly);
            if (namesOnly) {
                return {
                    status: handleRepo.currentHttpStatus(),
                    search_total: results.searchTotal,
                    handles: results.handles
                };
            }

            return {
                status: handleRepo.currentHttpStatus(),
                search_total: results.searchTotal,
                handles: (results.handles as object[])
                    .filter((handle) => Boolean((handle as Record<string, unknown>)?.utxo))
                    .map((handle) => new HandleViewModel(handle as any))
            };
        }

        if (name === 'get_holder') {
            const address = typedArgs.address;
            if (typeof address !== 'string' || !address.length) {
                throw new Error('`address` must be a non-empty string');
            }

            return {
                status: handleRepo.currentHttpStatus(),
                holder: handleRepo.getHolder(address) ?? null
            };
        }

        if (name === 'list_holders') {
            const page = Number(typedArgs.page ?? 1);
            const recordsPerPage = Number(typedArgs.records_per_page ?? 100);

            if (!Number.isFinite(page) || page <= 0 || !Number.isFinite(recordsPerPage) || recordsPerPage <= 0) {
                throw new Error('`page` and `records_per_page` must be positive numbers');
            }
            if (recordsPerPage > MAX_PAGINATED_RESULTS) {
                throw new Error(`'records_per_page' must be ${MAX_PAGINATED_RESULTS} or less`);
            }

            const sort = typedArgs.sort;
            if (sort && sort !== 'asc' && sort !== 'desc') {
                throw new Error('`sort` must be one of: asc, desc');
            }

            const pagination = new HolderPaginationModel({
                page: `${page}`,
                recordsPerPage: `${recordsPerPage}`,
                sort: sort as 'asc' | 'desc' | undefined
            });

            return {
                status: handleRepo.currentHttpStatus(),
                holders: handleRepo.getAllHolders({
                    pagination,
                    includeHandles: typedArgs.include_handles === true
                })
            };
        }

        if (name === 'get_policies') {
            let policiesDatum: string | null;
            try {
                policiesDatum = handleRepo.getHandleDatumByName(HANDLE_POLICIES_NAME);
            } catch (error) {
                if (error instanceof HttpException && error.status === 404) {
                    return {
                        status: handleRepo.currentHttpStatus(),
                        policies: null
                    };
                }
                throw error;
            }

            if (!policiesDatum) {
                return {
                    status: handleRepo.currentHttpStatus(),
                    policies: null
                };
            }

            return {
                status: handleRepo.currentHttpStatus(),
                policies: await decodePoliciesDatum(policiesDatum)
            };
        }

        if (name === 'get_handle' || name === 'get_handle_utxo') {
            const handleArg = typedArgs.handle;
            if (typeof handleArg !== 'string' || !handleArg.length) {
                throw new Error('`handle` must be a non-empty string');
            }
            const useHex = typedArgs.hex === true;
            const handle = useHex ? handleRepo.getHandleByHex(handleArg) : handleRepo.getHandle(handleArg);

            if (name === 'get_handle') {
                return {
                    status: handleRepo.currentHttpStatus(),
                    handle: handle ? new HandleViewModel(handle) : null
                };
            }

            return {
                status: handleRepo.currentHttpStatus(),
                utxo: handle?.utxo ? handleRepo.getUTxO(handle.utxo) : null
            };
        }

        throw new Error(`Unknown tool "${name}"`);
    }

    public async post(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const unsupportedVersion = MCPController.validateVersionHeader(req);
            if (unsupportedVersion) {
                MCPController.respondWithProtocol(
                    res,
                    MCPController.jsonError(null, -32600, `Unsupported MCP protocol version: ${unsupportedVersion}`),
                    400
                );
                return;
            }

            const message = MCPController.parseRequest(req.body);
            if (!message || message.jsonrpc !== '2.0' || !message.method) {
                MCPController.respondWithProtocol(res, MCPController.jsonError(null, -32600, 'Invalid JSON-RPC request'));
                return;
            }

            if (!Object.prototype.hasOwnProperty.call(message, 'id')) {
                res.status(202).set('MCP-Protocol-Version', LATEST_PROTOCOL_VERSION).end();
                return;
            }

            switch (message.method) {
                case 'initialize': {
                    const requestedVersion = (message.params as Record<string, unknown> | undefined)?.protocolVersion;
                    if (requestedVersion && (typeof requestedVersion !== 'string' || !SUPPORTED_PROTOCOL_VERSIONS.has(requestedVersion))) {
                        MCPController.respondWithProtocol(res, MCPController.jsonError(message.id ?? null, -32602, 'Unsupported protocolVersion'));
                        return;
                    }

                    MCPController.respondWithProtocol(
                        res,
                        MCPController.jsonResult(message.id ?? null, {
                            protocolVersion: LATEST_PROTOCOL_VERSION,
                            capabilities: {
                                tools: { listChanged: false }
                            },
                            serverInfo: {
                                name: 'api.handle.me',
                                version: packageJson.version
                            }
                        })
                    );
                    return;
                }
                case 'ping':
                    MCPController.respondWithProtocol(res, MCPController.jsonResult(message.id ?? null, {}));
                    return;
                case 'tools/list':
                    MCPController.respondWithProtocol(
                        res,
                        MCPController.jsonResult(message.id ?? null, {
                            tools: TOOL_DEFINITIONS
                        })
                    );
                    return;
                case 'tools/call': {
                    const params = message.params as Record<string, unknown> | undefined;
                    if (!params) {
                        MCPController.respondWithProtocol(res, MCPController.jsonError(message.id ?? null, -32602, 'Invalid tool call'));
                        return;
                    }
                    const toolName = params.name;
                    if (typeof toolName !== 'string' || !toolName.length) {
                        MCPController.respondWithProtocol(res, MCPController.jsonError(message.id ?? null, -32602, 'Invalid tool call'));
                        return;
                    }

                    try {
                        const payload = await MCPController.callTool(toolName, params.arguments, req);
                        MCPController.respondWithProtocol(
                            res,
                            MCPController.jsonResult(message.id ?? null, MCPController.toolResponse(payload))
                        );
                    } catch (error: unknown) {
                        MCPController.respondWithProtocol(
                            res,
                            MCPController.jsonResult(
                                message.id ?? null,
                                MCPController.toolResponse(
                                    error instanceof Error ? error.message : 'Tool execution failed',
                                    true
                                )
                            )
                        );
                    }
                    return;
                }
                default:
                    MCPController.respondWithProtocol(res, MCPController.jsonError(message.id ?? null, -32601, `Method not found: ${message.method}`));
                    return;
            }
        } catch (error) {
            next(error);
        }
    }

    public async get(_req: Request, res: Response, _next: NextFunction): Promise<void> {
        // GET /mcp returns a discoverability descriptor instead of a bare 405 +
        // one-sentence message. Status stays 405 (POST is the only valid verb
        // for the JSON-RPC transport) but the body advertises the capability surface
        // so an MCP client probing GET can self-bootstrap without out-of-band knowledge.
        res
            .status(405)
            .set('Allow', 'POST')
            .set('MCP-Protocol-Version', LATEST_PROTOCOL_VERSION)
            .json({
                error: 'method_not_allowed',
                message: 'SSE transport is not enabled. Use POST /mcp with JSON-RPC 2.0.',
                docs: 'https://api.handle.me/',
                protocol: 'Model Context Protocol',
                transport: 'streamable-http',
                latest_protocol_version: LATEST_PROTOCOL_VERSION,
                supported_protocol_versions: [...SUPPORTED_PROTOCOL_VERSIONS],
                server_info: { name: 'api.handle.me', version: packageJson.version },
                tools: TOOL_DEFINITIONS,
                links: {
                    openapi: '/openapi.json',
                    openapi_yaml: '/swagger/swagger.yml',
                    swagger_ui: '/swagger',
                    home: '/'
                }
            });
    }
}

export default MCPController;
