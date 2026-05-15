import { BlockPraos, Point, RollForward } from '@cardano-ogmios/schema';
import { AssetNameLabel, delay, getDateStringFromSlot, HANDLE_POLICIES, LogCategory, Logger, Network, NETWORK, UTxOFunctionName, UTxOWithTxInfo } from '@koralabs/kora-labs-common';
import fastq from 'fastq';
import * as url from 'url';
import WebSocket from 'ws';
import { OGMIOS_HOST } from '../../config';
import { handleEraBoundaries } from '../../config/constants';
import { HandlesRepository } from '../../repositories/handlesRepository';
import { getHandleNameFromAssetName } from './utils';

class OgmiosService {
    private firstMemoryUsage: number;
    private scanningRepo: HandlesRepository;
    client?: WebSocket;

    constructor(handlesRepo: HandlesRepository) {
        this.scanningRepo = handlesRepo;
        this.firstMemoryUsage = process.memoryUsage().rss;
    }

    public async initialize() {
        await this.scanningRepo.initialize();

        const exsistingMetrics = this.scanningRepo.getMetrics();

        this.scanningRepo.setMetrics({
            currentSlot: exsistingMetrics?.currentSlot ?? handleEraBoundaries[process.env.NETWORK ?? 'preview'].slot,
            currentBlockHash: exsistingMetrics?.currentBlockHash ?? handleEraBoundaries[process.env.NETWORK ?? 'preview'].id,
            firstSlot: handleEraBoundaries[process.env.NETWORK ?? 'preview'].slot,
            firstMemoryUsage: this.firstMemoryUsage,
            startTimestamp: Date.now()
        });

        // attempt ogmios resume (see if starting point exists or errors)
        const firstStartingPoint = await this.scanningRepo.getStartingPoint({
            [UTxOFunctionName.ADD_UTXO]: this.scanningRepo.addUTxO.bind(this.scanningRepo),
            [UTxOFunctionName.UPDATE_HANDLE_INDEXES]: this.scanningRepo.updateHandleIndexes.bind(this.scanningRepo)
        });
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
                    this.scanningRepo.rollBackToGenesis();
                    await this._resume(initialStartingPoint);
                    break;
                } else {
                    try {
                        // try to resume from first file's starting point
                        // it's possible that a bad starting point was saved (e.g., from a forked block)
                        await this._resume(firstStartingPoint);
                        break;
                    } catch (error: any) {
                        Logger.log({ message: `Error initializing Handles: ${error.message} code: ${error.code}`, category: LogCategory.ERROR, event: 'initializeStorage.firstFileFailed' });
                        const secondStartingPoint = await this.scanningRepo.getStartingPoint({
                            [UTxOFunctionName.ADD_UTXO]: this.scanningRepo.addUTxO.bind(this.scanningRepo),
                            [UTxOFunctionName.UPDATE_HANDLE_INDEXES]: this.scanningRepo.updateHandleIndexes.bind(this.scanningRepo)
                        }, true);
                        // If error, try the other file's starting point
                        if (error.code === 1000) {
                            this.scanningRepo.destroy();
                            if (secondStartingPoint) {
                                try {
                                    await this._resume(secondStartingPoint);
                                    break;
                                } catch (error: any) {
                                    if (error.code === 1000) {
                                        // this means the slot that came back from the files is bad
                                        this.scanningRepo.rollBackToGenesis();
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
            let response: any;
            try {
                response = JSON.parse(msg);
            } catch (error: any) {
                // A malformed Ogmios frame means the upstream is sending us
                // garbage — there's nothing useful to do but stop. NOTIFY so
                // someone investigates, then exit; the persisted cursor is
                // unchanged (setMetrics only runs on successful forward), so
                // the dropped block is picked up cleanly on restart via
                // find-intersection.
                Logger.log({
                    message: `Failed to parse Ogmios message; halting: ${error?.message ?? error}`,
                    category: LogCategory.NOTIFY,
                    event: 'OgmiosClient.parseError'
                });
                process.exit(1);
            }
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
                                    this.processBlock(block);    
                                                                    
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
        
        const currentSlot = txBlock?.slot ?? this.scanningRepo.getMetrics().currentSlot ?? 0;
        const transactionsWithUtxos: { txBody: NonNullable<BlockPraos['transactions']>[number], utxos: UTxOWithTxInfo[] }[] = [];

        for (let b = 0; b < (txBlock?.transactions ?? []).length; b++) {
            const txBody = txBlock?.transactions?.[b];
            if (!txBody) continue;
            const txId = txBody?.id;
            const utxos: UTxOWithTxInfo[] = [];

            // Iterate through all the outputs and find asset keys that start with our policyId
            for (let i = 0; i < (txBody?.outputs ?? []).length; i++) {
                const o = txBody?.outputs[i];

                const values = Object.entries(o?.value ?? {}).filter(([policyId]) => HANDLE_POLICIES.contains(NETWORK as Network, policyId));
                if (values.length) {
                    const minted = Object.entries(txBody?.mint ?? {}).filter(([policyId]) => HANDLE_POLICIES.contains(NETWORK as Network, policyId));
                    const handleAssets: [string, string[]][] = values.map(([policy, handles]) => [policy, Object.keys(handles)]);
                    const handles = handleAssets.flatMap(h => h[1])
                    const mintAssets: [string, string[]][] = minted.map(([policy, mintedHandles]) => [policy, handles.filter(k => mintedHandles[k] > 0n)]);
                    const metadata = Object.fromEntries(
                        Object.entries(txBody?.metadata?.labels ?? {}).filter(([label, labelObj]) => label == '721' && labelObj.json) // We only need 721 label
                            .map(([label, labelObj]) => {
                                const { json } = labelObj;
                                const { version, ...policies } = json as any;
                                const filteredPolicies = Object.fromEntries(
                                    Object.entries(policies)
                                        .filter(([policyId]) => HANDLE_POLICIES.contains(NETWORK as Network, policyId))
                                        .map(([policyId, assets]) => {
                                            // Only handles in this UTxO
                                            const filteredAssets = Object.fromEntries(Object.entries(assets as any).filter(([assetName]) => handles.includes(assetName) || handles.includes(Buffer.from(assetName).toString('hex'))));
                                            return [policyId, filteredAssets];
                                        })
                                        .filter(([, assets]) => Object.keys(assets as any).length > 0)
                                );

                                return [label, { ...filteredPolicies, ...(version && { version }) }];
                            })
                            // drop labels that ended up with no assets under any policyId
                            .filter(([, labelObj]) => Object.keys(labelObj as any).some(k => k !== 'version'))
                    )
                    // We need to get the datum. This can either be a string or json object.
                    const rawDatum = o?.datum || (o?.datumHash ? txBody.datums?.[o.datumHash] : undefined);
                    let datum;
                    try {
                        datum = !rawDatum ? undefined : typeof rawDatum === 'string' ? rawDatum : JSON.stringify(rawDatum);
                    } catch {
                        Logger.log({ message: `Error decoding datum for ${txId}#${i}`, category: LogCategory.ERROR, event: 'processBlock.decodingDatum' });
                    }
                    // extract handle related UTxO information
                    const utxo: UTxOWithTxInfo = {
                        id: `${txId}#${i}`,
                        tx_id: txId!,
                        index: i,
                        slot: currentSlot,
                        address: o?.address!,
                        lovelace: Number(o?.value!.ada.lovelace!),
                        datum,
                        // Normalize the language to one of plutus_v1/v2/v3 (snake_case
                        // canonical, matched by services/scripts.service.ts
                        // PLUTUS_LANGUAGE_PREFIX). Refuse to store a bare/unknown
                        // value — that's how the V3 family ended up indexed as
                        // `plutus` and the api fell back to a V2-tag hash, see
                        // scripts/backfill-script-types.ts.
                        script: (() => {
                            const cbor = o?.script?.cbor;
                            if (!cbor) return undefined;
                            const raw = `${o?.script?.language ?? ''}`.toLowerCase().replace(':', '_');
                            const normalized = raw === 'plutus_v1' || raw === 'plutusv1' ? 'plutus_v1'
                                : raw === 'plutus_v2' || raw === 'plutusv2' ? 'plutus_v2'
                                : raw === 'plutus_v3' || raw === 'plutusv3' ? 'plutus_v3'
                                : null;
                            if (!normalized) {
                                throw new Error(
                                    `ogmios script at ${txId}#${i} has unrecognized language ${JSON.stringify(o?.script?.language)} — refusing to store; downstream hash compute would fall back to PlutusV2 and produce the wrong scriptAddress`
                                );
                            }
                            return { type: normalized, cbor };
                        })(),
                        handles: handleAssets,
                        mint: mintAssets, // filtered for the minted assets in this UTxO
                        metadata, // filtered for the minted assets in this UTxO
                        blockHash: txBlock.id,
                        blockNum: txBlock.height
                    }

                    utxos.push(utxo);
                }
            }

            transactionsWithUtxos.push({ txBody, utxos });
        }

        const mintingData = this.scanningRepo.addMintDataFromUTxOs(transactionsWithUtxos.flatMap((entry) => entry.utxos));

        for (const { txBody, utxos } of transactionsWithUtxos) {
            // Look for burn transactions
            const mintAssets = Object.entries(txBody?.mint ?? {});
            for (let i = 0; i < mintAssets.length; i++) {
                const [policy, assetInfo] = mintAssets[i];
                if (HANDLE_POLICIES.contains(NETWORK as Network, policy)) {
                    for (const [assetName, quantity] of Object.entries(assetInfo)) {
                        if (quantity == BigInt(-1)) {
                            const { name, isCip67 } = getHandleNameFromAssetName(assetName);
                            if (!isCip67 || assetName.startsWith(AssetNameLabel.LBL_222) || assetName.startsWith(AssetNameLabel.LBL_000)) {
                                const handle = this.scanningRepo.getHandle(name);
                                if (!handle) continue;
                                this.scanningRepo.removeHandle(handle);
                            }
                        }
                    }
                }
            }

            // Sort the UTxOs so that Handles with 222 are first. This fixes when we look for mintingData later.
            utxos.sort(u => u.handles.some(h => h[1].some(a => a.startsWith(AssetNameLabel.LBL_222))) ? -1 : 1);

            this.scanningRepo.addUTxOsWithMintDataAndUpdateIndexes(utxos, mintingData);

            // remove all the utxos that were spent as inputs to this tx
            this.scanningRepo.removeUTxOs(txBody?.inputs.flatMap((x) => `${x.transaction.id}#${x.index}`) ?? []);
        }
    }

    Internal = {
        processBlock: this.processBlock.bind(this)
    }
}



export default OgmiosService;
