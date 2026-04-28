import { getDateStringFromSlot, LockedLambdaReason, LogCategory, Logger } from '@koralabs/kora-labs-common';
import { NextFunction, Request, Response } from 'express';
import { HealthResponseBody } from '../interfaces/ogmios.interfaces';
import { IRegistry } from '../interfaces/registry.interface';
import { HandlesRepository } from '../repositories/handlesRepository';
import { fetchHealth } from '../services/ogmios/utils';

enum HealthStatus {
    CURRENT = 'current',
    UPDATING = 'updating',
    OGMIOS_BEHIND = 'ogmios_behind',
    STORAGE_BEHIND = 'storage_behind',
    WAITING_ON_CARDANO_NODE = 'waiting_on_cardano_node'
}

const updatingLocks = new Set<LockedLambdaReason>([LockedLambdaReason.ROLLBACK_2160, LockedLambdaReason.REINDEX]);

const getHealthSlotDate = (currentSlot: number) => {
    if (process.env.NETWORK?.toLowerCase() == 'preprod') {
        return new Date((1655683200 + currentSlot) * 1000);
    }
    return getDateStringFromSlot(currentSlot);
};

class HealthController {
    public async index (req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const handleRepo = new HandlesRepository(new (req.app.get('registry') as IRegistry).handlesStore());
            const metrics = handleRepo.getMetrics();
            const { firstSlot = 0, lastSlot = 0, currentSlot = 0, firstMemoryUsage = 0, currentBlockHash = '', tipBlockHash = '', memorySize = 0, utxoSchemaVersion = 0, indexSchemaVersion = 0, handleCount = 0, holderCount = 0, startTimestamp = 0, lockLambdas } = metrics;
            const handleSlotRange = lastSlot - firstSlot;
            const currentSlotInRange = currentSlot - firstSlot;
            const transpiredMs = Date.now() - startTimestamp;
            const percentageComplete = ((currentSlotInRange / handleSlotRange) * 100).toFixed(2);
            const currentMemoryUsage = process.memoryUsage().rss;
            const indexMemorySize = Math.round(((currentMemoryUsage - firstMemoryUsage) / 1024 / 1024) * 100) / 100;
            const slotDate = getHealthSlotDate(currentSlot);
    
            const stats = {
                percentage_complete: percentageComplete ? Number(percentageComplete) : 0,
                index_memory_size: indexMemorySize,
                slot_date: slotDate,
                handle_count: handleCount,
                holder_count: holderCount,
                memory_size: memorySize,
                current_slot: currentSlot,
                last_slot: lastSlot,
                current_block_hash: currentBlockHash,
                tip_block_hash: tipBlockHash,
                utxo_schema_version: utxoSchemaVersion,
                index_schema_version: indexSchemaVersion,
                lock_lambdas: lockLambdas,
                estimated_sync_time: new Date(Date.now() + ((transpiredMs / (currentSlotInRange || 1)) * (lastSlot - currentSlot))).toISOString()
            };

            let status = HealthStatus.CURRENT;
            if (!handleRepo.isCaughtUp(metrics)) {
                status = HealthStatus.STORAGE_BEHIND;
            }
            const ogmiosScanningEnabled = process.env.ENABLE_OGMIOS_SCANNING?.toLocaleLowerCase() !== 'false';
            let ogmios: HealthResponseBody | null = null;
            if (ogmiosScanningEnabled) {
                // We don't try to connect to ogmios when scanning is disabled
                ogmios = await fetchHealth();
                const ogmiosTipSlot = Number(ogmios?.lastKnownTip?.slot ?? 0);
                const ogmiosTipHash = ogmios?.lastKnownTip?.hash ?? ogmios?.lastKnownTip?.id ?? '';
                const hasComparableOgmiosTip = ogmiosTipSlot > 0 && !!ogmiosTipHash;
                const storageMatchesOgmiosTip = hasComparableOgmiosTip && (ogmiosTipSlot - currentSlot) < 240 && currentBlockHash === ogmiosTipHash;
                if (status === HealthStatus.CURRENT && hasComparableOgmiosTip && !storageMatchesOgmiosTip) {
                    status = HealthStatus.STORAGE_BEHIND;
                }
                if ((ogmios?.networkSynchronization ?? 0) < 1) {
                    status = HealthStatus.OGMIOS_BEHIND;
                }
                if (ogmios?.connectionStatus !== 'connected') {
                    Logger.log({category:LogCategory.WARN, message: 'Ogmios can\'t connect to the node socket', event: 'healthcheck.failure'});
                    status = HealthStatus.WAITING_ON_CARDANO_NODE;
                }
            }
            if (lockLambdas && updatingLocks.has(lockLambdas)) {
                status = HealthStatus.UPDATING;
            }

            let statusCode = 200;
            if (status == HealthStatus.WAITING_ON_CARDANO_NODE)
                statusCode = 503;
            else if (status != HealthStatus.CURRENT)
                statusCode = 202;
            
            res.status(statusCode).json({
                status,
                ...(ogmiosScanningEnabled ? { ogmios } : {}),
                stats
            });
        } catch (error: any) {
            next(error);
        }
    }
}

export default HealthController;
