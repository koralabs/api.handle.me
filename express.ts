import { loadAfterHydratingKmsEnvironment } from '@koralabs/kora-labs-common';

await loadAfterHydratingKmsEnvironment(() => import('./express.app'));
