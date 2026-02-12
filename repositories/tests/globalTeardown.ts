import { RedisHandlesStore } from '../../stores/redis';
import { HandlesRepository } from '../handlesRepository';

module.exports = async () => {
    for (const store of [RedisHandlesStore]) {
        const repo = new HandlesRepository(new store());
        await repo.initialize();
        repo.destroy();
    }
}
