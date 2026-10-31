import { LogCategory, Logger } from '@koralabs/kora-labs-common';

// A block that Koios has not indexed yet pauses the scan and the next invocation retries it. Koios
// normally catches up within a few invocations, so only a block that stays paused is alertable.
export const COVERAGE_PAUSE_WARN_AFTER = 10;

let pausedBlockHash = '';
let consecutivePauses = 0;

export const reportCoveragePause = (event: string, blockHash: string, message: string): void => {
    consecutivePauses = blockHash === pausedBlockHash ? consecutivePauses + 1 : 1;
    pausedBlockHash = blockHash;
    if (consecutivePauses < COVERAGE_PAUSE_WARN_AFTER) {
        Logger.local(message);
        return;
    }
    Logger.log({ message: `${message} paused_invocations=${consecutivePauses}`, category: LogCategory.WARN, event });
};

export const resetCoveragePauseForTest = (): void => {
    pausedBlockHash = '';
    consecutivePauses = 0;
};
