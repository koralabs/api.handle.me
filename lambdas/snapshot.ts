import { hydrateKmsEnvironment } from '@koralabs/kora-labs-common';
import { handler as snapshotHandler, processSnapshot as runSnapshot } from './snapshot.app';

export const processSnapshot = async (network: string) => {
    await hydrateKmsEnvironment();
    return runSnapshot(network);
};

export const handler = async (event: any) => {
    await hydrateKmsEnvironment();
    return snapshotHandler(event);
};
