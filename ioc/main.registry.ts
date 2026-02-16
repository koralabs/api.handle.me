import { IRegistry } from '../interfaces/registry.interface';
import { RedisHandlesStore } from '../stores/redis';

const registry: IRegistry = {
    ['handlesStore']: RedisHandlesStore
};

export default registry as IRegistry