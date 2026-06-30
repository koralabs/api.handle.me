import { loadAfterHydratingKmsEnvironment } from '@koralabs/kora-labs-common/aws';

await loadAfterHydratingKmsEnvironment(() => import('./express.app'));
