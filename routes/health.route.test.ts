import { IApiMetrics } from '@koralabs/kora-labs-common';
import request from 'supertest';
import App from '../app';
import { HealthResponseBody } from '../interfaces/ogmios.interfaces';
import * as ogmiosUtils from '../services/ogmios/utils';

jest.mock('../services/ogmios/ogmios.service');

const getStats = (): IApiMetrics => ({
    firstSlot: 1, 
    lastSlot: 100, 
    currentSlot: 50, 
    firstMemoryUsage: 0, 
    currentBlockHash: '', 
    memorySize: 0, 
    indexSchemaVersion: 0, 
    handleCount: 100, 
    startTimestamp: Date.now()
});
const caughtUp = jest.fn().mockReturnValue(true);
jest.mock('../repositories/handlesRepository', () => ({
    HandlesRepository: jest.fn().mockImplementation(() => ({
        getHandle: (handleName: string) => {
            if (['nope'].includes(handleName)) return null;

            return {
                handle: handleName
            };
        },
        getAll: () => {
            return [
                {
                    handle: 'burritos'
                }
            ];
        },
        getAllHandleNames: () => {
            return ['burritos', 'tacos', 'barbacoa'];
        },
        getMetrics: () => {
            return getStats();
        },
        currentHttpStatus: () => {
            return 200;
        },
        isCaughtUp: () => caughtUp()
    }))
}));

afterAll(async () => {
    await new Promise<void>((resolve) => setTimeout(() => resolve(), 500));
});

describe('Health Routes Test', () => {
    let app: App | null;
    const originalEnableOgmiosScanning = process.env.ENABLE_OGMIOS_SCANNING;
    beforeEach(async () => {
        process.env.ENABLE_OGMIOS_SCANNING = '';
        app = await new App().initialize();
    });

    afterEach(() => {
        jest.clearAllMocks();
        process.env.ENABLE_OGMIOS_SCANNING = originalEnableOgmiosScanning;
    });

    const getMockResponse = ({ networkSynchronization = 0 }: { networkSynchronization?: number }): HealthResponseBody => ({
        startTime: '',
        lastKnownTip: {
            slot: 0,
            hash: '',
            blockNo: 0
        },
        lastTipUpdate: '',
        networkSynchronization,
        currentEra: '',
        metrics: {
            activeConnections: 0,
            runtimeStats: {
                cpuTime: 0,
                currentHeapSize: 0,
                gcCpuTime: 0,
                maxHeapSize: 0
            },
            sessionDurations: {
                max: 0,
                mean: 0,
                min: 0
            },
            totalConnections: 0,
            totalMessages: 0,
            totalUnrouted: 0
        },
        connectionStatus: 'connected',
        currentEpoch: 0,
        slotInEpoch: 0
    });

    describe('[GET] /health', () => {
        it('Should skip ogmios health checks when scanning is disabled', async () => {
            process.env.ENABLE_OGMIOS_SCANNING = 'false';
            const fetchHealthSpy = jest.spyOn(ogmiosUtils, 'fetchHealth');
            caughtUp.mockReturnValue(true);

            const response = await request(app?.getServer()).get('/health');

            expect(response.status).toEqual(200);
            expect(response.body).toEqual({
                ogmios: '(ogmios scanning is disabled)',
                stats: {
                    current_block_hash: expect.any(String),
                    index_memory_size: expect.any(Number),
                    current_slot: expect.any(Number),
                    estimated_sync_time: expect.any(String),
                    memory_size: expect.any(Number),
                    handle_count: expect.any(Number),
                    holder_count: expect.any(Number),
                    percentage_complete: expect.any(Number),
                    slot_date: expect.any(String),
                    index_schema_version: expect.any(Number),
                    utxo_schema_version: expect.any(Number)
                },
                status: 'current'
            });
            expect(fetchHealthSpy).not.toHaveBeenCalled();
        });

        it('Should return 503 and health stats when ogmios does not connect', async () => {
            jest.spyOn(ogmiosUtils, 'fetchHealth').mockResolvedValue(null);
            const response = await request(app?.getServer()).get('/health');
            expect(response.status).toEqual(503);
            expect(response.body).toEqual({
                ogmios: null,
                stats: {
                    current_block_hash: expect.any(String),
                    index_memory_size: expect.any(Number),
                    current_slot: expect.any(Number),
                    estimated_sync_time: expect.any(String),
                    memory_size: expect.any(Number),
                    handle_count: expect.any(Number),
                    holder_count: expect.any(Number),
                    percentage_complete: expect.any(Number),
                    slot_date: expect.any(String),
                    index_schema_version: expect.any(Number),
                    utxo_schema_version: expect.any(Number)
                },
                status: 'waiting_on_cardano_node'
            });
        });

        it('Should return 202 when current slot is not caught up', async () => {
            const ogmiosResult = getMockResponse({
                networkSynchronization: 1
            });
            jest.spyOn(ogmiosUtils, 'fetchHealth').mockResolvedValue(ogmiosResult);
            caughtUp.mockReturnValue(false);
            const response = await request(app?.getServer()).get('/health');
            expect(response.status).toEqual(202);
            expect(response.body).toEqual({
                ogmios: expect.any(Object),
                stats: {
                    current_block_hash: expect.any(String),
                    index_memory_size: expect.any(Number),
                    current_slot: expect.any(Number),
                    estimated_sync_time: expect.any(String),
                    memory_size: expect.any(Number),
                    handle_count: expect.any(Number),
                    holder_count: expect.any(Number),
                    percentage_complete: expect.any(Number),
                    slot_date: expect.any(String),
                    index_schema_version: expect.any(Number),
                    utxo_schema_version: expect.any(Number)
                },
                status: 'storage_behind'
            });
        });

        it('Should return 200 everything is caught up', async () => {
            const ogmiosResult = getMockResponse({networkSynchronization: 1});
            jest.spyOn(ogmiosUtils, 'fetchHealth').mockResolvedValue(ogmiosResult);
            caughtUp.mockReturnValue(true);
            const response = await request(app?.getServer()).get('/health');
            expect(response.status).toEqual(200);
            expect(response.body).toEqual({
                ogmios: ogmiosResult,
                stats: {
                    current_block_hash: expect.any(String),
                    index_memory_size: expect.any(Number),
                    current_slot: expect.any(Number),
                    estimated_sync_time: expect.any(String),
                    memory_size: expect.any(Number),
                    handle_count: expect.any(Number),
                    holder_count: expect.any(Number),
                    percentage_complete: expect.any(Number),
                    slot_date: expect.any(String),
                    index_schema_version: expect.any(Number),
                    utxo_schema_version: expect.any(Number)
                },
                status: 'current'
            });
        });
    });
});
