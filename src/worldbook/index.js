import { WorldbookStore } from './store.js';
import { LIMITS, WorldbookFailure, fail, object, integer, source, id, newId } from './validation.js';
export { WorldbookFailure, LIMITS } from './validation.js';

// Only Worldbook business data. ST runtime query inputs expire in memory and
// never enter SQLite, media/governance stores or application logs.
export function createWorldbook(config, { now = () => Date.now() } = {}) {
    const stores = new Map(),
        failures = new Map(),
        runtime = new Map();
    let DatabaseSync,
        stopped = false;
    async function store(context) {
        if (stopped || !DatabaseSync || !context?.userRoot) fail('WORLDBOOK_UNAVAILABLE');
        if (!stores.has(context.userRoot))
            stores.set(
                context.userRoot,
                (async () => {
                    const item = new WorldbookStore(context.userRoot, DatabaseSync, { now });
                    await item.initialize();
                    return item;
                })(),
            );
        try {
            const item = await stores.get(context.userRoot);
            failures.delete(context.userRoot);
            return item;
        } catch (error) {
            stores.delete(context.userRoot);
            failures.set(context.userRoot, error instanceof WorldbookFailure ? error.code : 'WORLDBOOK_UNAVAILABLE');
            throw error;
        }
    }
    function expire() {
        for (const [token, value] of runtime) if (value.expiresAt <= now()) runtime.delete(token);
    }
    function runtimeInput(context, token) {
        expire();
        const value = runtime.get(id(token));
        if (!value || !value.complete || value.contextId !== context.contextId || value.userRoot !== context.userRoot)
            fail('WORLDBOOK_RUNTIME_EXPIRED');
        return value.bindings;
    }
    return {
        definition: {
            id: 'worldbook',
            version: '0.1.0',
            dependsOn: ['core'],
            capabilities: [
                {
                    id: 'worldbook.core',
                    contract: { major: 1, minMinor: 0, maxMinor: 0 },
                    operations: ['summary', 'catalog', 'tree', 'detail', 'sources', 'runtime', 'command'].map((id) => ({
                        id,
                        available: true,
                    })),
                    operationAvailability: () =>
                        Object.fromEntries(
                            ['runtime', 'command'].map((op) => [
                                op,
                                {
                                    available: config.policy.core.allowedOrigins.length > 0,
                                    reasonCode: 'ORIGIN_POLICY_MISSING',
                                },
                            ]),
                        ),
                    limits: LIMITS,
                    constraints: {
                        schemaVersion: 1,
                        scope: 'st-user',
                        storage: 'sqlite',
                        identity: 'independent-material-and-source',
                        revision: 'entity-and-column-structure',
                        runtime: 'frontend-owned',
                        media: false,
                    },
                },
            ],
            initialize: async () => {
                ({ DatabaseSync } = await import('node:sqlite'));
            },
            health: async (context) => {
                try {
                    await store(context);
                    return { state: 'ready', reasonCode: null };
                } catch {
                    return {
                        state: 'unavailable',
                        reasonCode: failures.get(context?.userRoot) || 'WORLDBOOK_UNAVAILABLE',
                    };
                }
            },
            shutdown: async () => {
                stopped = true;
                runtime.clear();
                for (const pending of stores.values()) {
                    try {
                        (await pending).close();
                    } catch {}
                }
                stores.clear();
            },
        },
        store,
        async read(context, operation, input) {
            const target = await store(context);
            if (operation === 'summary') return target.summary(input.page);
            if (operation === 'sources') return target.sources(input.page);
            if (operation === 'detail') return target.detail(input.id);
            if (operation === 'tree') return target.tree(input.id, input);
            if (operation === 'catalog')
                return target.catalog(input, input.runtimeToken ? runtimeInput(context, input.runtimeToken) : null);
            fail('WORLDBOOK_VALIDATION');
        },
        async command(context, value) {
            return (await store(context)).execute(value);
        },
        async runtime(context, value) {
            await store(context);
            expire();
            object(value, ['token', 'offset', 'bindings', 'complete'], ['offset', 'bindings', 'complete']);
            integer(value.offset, 0, LIMITS.maxRuntimeBindings);
            if (
                !Array.isArray(value.bindings) ||
                value.bindings.length > LIMITS.runtimeBatchSize ||
                typeof value.complete !== 'boolean'
            )
                fail('WORLDBOOK_VALIDATION');
            const bindings = value.bindings.map((item) => {
                object(item, ['locator', 'uid'], ['locator', 'uid']);
                const clean = source({ ...item, title: 'runtime' });
                return { locator: clean.locator, uid: clean.uid };
            });
            let entry,
                token = value.token;
            if (token) {
                entry = runtime.get(id(token));
                if (!entry || entry.contextId !== context.contextId || entry.userRoot !== context.userRoot)
                    fail('WORLDBOOK_RUNTIME_EXPIRED');
            } else {
                if (value.offset !== 0) fail('WORLDBOOK_VALIDATION');
                const owned = [...runtime.entries()].filter(([, row]) => row.userRoot === context.userRoot);
                if (owned.length >= 2) runtime.delete(owned[0][0]);
                if (runtime.size >= 8) fail('RESOURCE_BUSY');
                token = newId('runtime');
                entry = {
                    contextId: context.contextId,
                    userRoot: context.userRoot,
                    bindings: [],
                    expiresAt: now() + LIMITS.runtimeTtlMs,
                    complete: false,
                };
            }
            // Exact offset makes retry of a transferred batch safe; modified retries fail closed.
            if (value.offset < entry.bindings.length || entry.complete) {
                if (
                    value.offset + bindings.length > entry.bindings.length ||
                    (value.complete && value.offset + bindings.length !== entry.bindings.length) ||
                    JSON.stringify(entry.bindings.slice(value.offset, value.offset + bindings.length)) !==
                        JSON.stringify(bindings)
                )
                    fail('WORLDBOOK_VALIDATION');
            } else {
                if (
                    entry.complete ||
                    value.offset !== entry.bindings.length ||
                    entry.bindings.length + bindings.length > LIMITS.maxRuntimeBindings
                )
                    fail('WORLDBOOK_VALIDATION');
                entry.bindings.push(...bindings);
            }
            entry.complete ||= value.complete;
            runtime.set(token, entry);
            return { token, received: entry.bindings.length, complete: entry.complete, expiresAt: entry.expiresAt };
        },
    };
}
