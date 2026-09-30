import { loadPolicy } from '../../src/config.js';
import { createNetworkPolicy } from '../../src/network/policy.js';

const config = await loadPolicy({ dataRoot: process.argv[2] });
const manager = createNetworkPolicy(config, { preparePolicy: () => () => {} }, {
    persist: async () => {
        process.send({ state: 'locked' });
        await new Promise(() => {}); // Parent pauses/kills this process while the real mutex is held.
    },
});
const view = await manager.read({ isAdmin: true });
try {
    await manager.mutate({ isAdmin: true }, 'add', {
        host: 'held.example.com', includeSubdomains: false, revision: view.revision,
    });
} catch (error) {
    process.send({ state: 'failed', code: error.code });
    process.exitCode = 1;
}
