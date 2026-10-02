// One active ST process per user data volume, as required by the deployment.
// All Consumer reference writes and externally reachable hard deletes share it.
export function createReferenceCoordinator() {
    const tails = new Map();
    return async (context, action) => {
        const key = context?.userRoot;
        if (!key) throw new Error('AUTH_REQUIRED');
        const before = tails.get(key) || Promise.resolve();
        let release;
        const next = new Promise(resolve => { release = resolve; });
        tails.set(key, next);
        await before;
        try { return await action(); }
        finally { release(); if (tails.get(key) === next) tails.delete(key); }
    };
}
