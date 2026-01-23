import { BlockPraos, NextBlockResponse, Point, RollForward } from '@cardano-ogmios/schema';
import { delay, getDateStringFromSlot, LogCategory, Logger, NETWORK } from '@koralabs/kora-labs-common';
import fastq from 'fastq';
import * as url from 'url';
import WebSocket from 'ws';
import { OGMIOS_HOST } from '../../config';
import { handleEraBoundaries, ScanningMode } from '../../config/constants';
import { HandlesRepository } from '../../repositories/handlesRepository';
import { processBlock } from '../processBlock';

// let firstBlockProcessed = false;

class OgmiosService {
    private firstMemoryUsage: number;
    // private handlesRepo: HandlesRepository;
    private scanningRepo: HandlesRepository;
    private scanningMode = ScanningMode.BACKFILL;
    client?: WebSocket;
    processBlockCallback?: (block: NextBlockResponse) => Promise<void>;

    constructor(handlesRepo: HandlesRepository, processBlockCallback?: (block: NextBlockResponse) => Promise<void>) {
        this.scanningRepo = handlesRepo;
        // this.handlesRepo = handlesRepo;
        this.firstMemoryUsage = process.memoryUsage().rss;
        this.processBlockCallback = processBlockCallback;
    }

    public async initialize(reset: () => Promise<void>, load: () => Promise<void>) {
        await this.scanningRepo.initialize();
        //await this.handlesRepo.initialize();

        const exsistingMetrics = this.scanningRepo.getMetrics();

        this.scanningRepo.setMetrics({
            currentSlot: exsistingMetrics?.currentSlot ?? handleEraBoundaries[process.env.NETWORK ?? 'preview'].slot,
            currentBlockHash: exsistingMetrics?.currentBlockHash ?? handleEraBoundaries[process.env.NETWORK ?? 'preview'].id,
            firstSlot: handleEraBoundaries[process.env.NETWORK ?? 'preview'].slot,
            firstMemoryUsage: this.firstMemoryUsage,
            startTimestamp: Date.now()
        });

        // attempt ogmios resume (see if starting point exists or errors)
        const firstStartingPoint = await this.scanningRepo.getStartingPoint([
            this.scanningRepo.addUTxO.bind(this.scanningRepo),
            this.scanningRepo.updateHolderIndex.bind(this.scanningRepo),
            this.scanningRepo.updateHandleIndexes.bind(this.scanningRepo)
        ]);
        // const firstStartingPoint = {id: 'eca47c4fb9ca7f8eb2c524b975da3db1d05ced0a9ef0c4ee2c40c4cf2fcb3ea5', slot: 134281477} as Point

        // eslint-disable-next-line no-constant-condition
        while (true) {
            try {
                if (!this.client) {
                    this.client = this._createWebSocketClient();
                }
                if (!firstStartingPoint) {        
                    // start from first Handle mint            
                    const initialStartingPoint = handleEraBoundaries[process.env.NETWORK ?? 'preview'];
                    await reset();
                    await this._resume(initialStartingPoint);
                    break;
                } else {
                    try {
                        await load();
                        // try to resume from first file's starting point
                        // it's possible that a bad starting point was saved (e.g., from a forked block)
                        await this._resume(firstStartingPoint);
                        break;
                    } catch (error: any) {
                        Logger.log({ message: `Error initializing Handles: ${error.message} code: ${error.code}`, category: LogCategory.ERROR, event: 'initializeStorage.firstFileFailed' });
                        const secondStartingPoint = await this.scanningRepo.getStartingPoint([
                            this.scanningRepo.addUTxO.bind(this.scanningRepo),
                            this.scanningRepo.updateHolderIndex.bind(this.scanningRepo),
                            this.scanningRepo.updateHandleIndexes.bind(this.scanningRepo)
                        ], true);
                        // If error, try the other file's starting point
                        if (error.code === 1000) {
                            this.scanningRepo.destroy();
                            if (secondStartingPoint) {
                                try {
                                    await load();
                                    await this._resume(secondStartingPoint);
                                    break;
                                } catch (error: any) {
                                    if (error.code === 1000) {
                                        // this means the slot that came back from the files is bad
                                        await reset();
                                        process.exit(2);
                                    }
                                    throw error;
                                }
                            }
                        }
                    }
                }
                this._resetClient();
            } catch (error: any) {
                Logger.log({ message: `Unable to connect Ogmios: ${error.message}`, category: LogCategory.ERROR, event: 'initializeStorage.failed.errorMessage' });
                this._resetClient();
            }
            await delay(30 * 1000);
        }
    }

    private _resetClient() {
        if (!this.client) return;
        if (this.client.readyState === WebSocket.CONNECTING || this.client.readyState === WebSocket.OPEN || this.client.readyState === WebSocket.CLOSING) {
            this.client.close();
        }
        this.client = undefined;
    }

    private _createWebSocketClient(): WebSocket {
        const client = new WebSocket(new url.URL(OGMIOS_HOST).toString(), {allowSynchronousEvents: false});
        client.on('message', fastq.promise(async (msg: string) => {
            const response = JSON.parse(msg);
            switch (response.id) {
                case 'find-intersection':
                    for (let i=1; i<=100; i++) {
                        this._rpcRequest('nextBlock', {}, 'next-block');
                    }
                    break;
                case 'next-block':
                    try {
                        switch (response.result.direction) {
                            case 'backward': {
                                Logger.log({
                                    message: `Rollback occurred to slot: ${JSON.stringify(response.result.point)}`,
                                    event: 'OgmiosService.rollBackward',
                                    category: LogCategory.INFO
                                });
                                break;
                            }
                            case 'forward': {
                                try {
                                    const result = response.result as RollForward;
                                    
                                    if (result.block.type !== 'praos')
                                        throw new Error(`Block type ${result.block.type} is not supported`);

                                    const block = result.block as BlockPraos
                                    await this.processBlock(block);    
                                                                    
                                    const metrics = {
                                        currentSlot: block.slot,
                                        currentBlockHash: block.id,
                                        tipBlockHash: result.tip.id,
                                        lastSlot: result.tip.slot
                                    }
                                    
                                    this.scanningRepo.setMetrics(metrics);
                                }
                                catch (error: any) {
                                    Logger.log({
                                        message: `Unhandled error processing block: BLOCK: ${JSON.stringify(response.result.block.id)} ERROR:${error.message} STACK: ${error.stack}`,
                                        category: LogCategory.NOTIFY,
                                        event: 'OgmiosService.processBlock'
                                    });
                                    //process.exit(1);
                                }
                            }
                                break;
                            default:
                                break;
                        }
                        if (this.processBlockCallback) await this.processBlockCallback(response);
                    } catch (error) {
                        Logger.log({ message: JSON.stringify(error), category: LogCategory.ERROR, event: 'OgmiosClient.Message' });
                    }
                    break;
            }
            this._rpcRequest('nextBlock', {}, 'next-block');
        }, 1).push)
        client.on('error', (error) => {
            Logger.log({ message: `OgmiosClient Error: ${error}`, category: LogCategory.ERROR, event: 'OgmiosClient.Error' });
        });
        return client;
    }

    private async _resume(startingPoint: Point) {
        const checkOpenConnection = true;
        while (checkOpenConnection) {
            if (!this.client || this.client.readyState === WebSocket.CLOSED || this.client.readyState === WebSocket.CLOSING) {
                this._resetClient();
                this.client = this._createWebSocketClient();
            }
            if (this.client.readyState === WebSocket.OPEN) break;
            await delay(30000);
        }
        Logger.log(`Resuming index at slot ${startingPoint.slot} and hash ${startingPoint.id} (${getDateStringFromSlot(startingPoint.slot)})`);
        this.scanningRepo.setMetrics({ firstSlot: handleEraBoundaries[NETWORK].slot, currentSlot: startingPoint.slot, currentBlockHash: startingPoint.id });
        this._rpcRequest('findIntersection', { points: startingPoint.slot == 0 ? ['origin'] : [startingPoint] }, 'find-intersection');
    }

    private _rpcRequest(method: string, params: any, id: string | number) {
        this.client!.send(JSON.stringify({ jsonrpc: '2.0', method, params, id }));
    }

    private processBlock = (txBlock: BlockPraos) => {
        processBlock(txBlock, this.scanningRepo);
        // if (this.scanningMode == ScanningMode.TIP) {
        //     await processBlock(txBlock, this.handlesRepo);
        // }
    }
}

export default OgmiosService;
