import { WorldbookCandidateSessions } from './candidate-sessions.js';
import { WorldbookStore } from './store.js';
import { LIMITS, WorldbookFailure, fail, object, integer, source, id, newId, text } from './validation.js';
export { WorldbookFailure, LIMITS } from './validation.js';

// Only Worldbook business data. ST runtime query inputs expire in memory and
// never enter SQLite, media/governance stores or application logs.
export function createWorldbook(config, { now = () => Date.now() } = {}) {
    const stores = new Map(),
        failures = new Map(),
        runtime = new Map();
    const selections = new WorldbookCandidateSessions(now);
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
            failures.set(
                context.userRoot,
                error instanceof WorldbookFailure ? error.code : 'WORLDBOOK_UNAVAILABLE',
            );
            throw error;
        }
    }
    function expire() {
        for (const [token, value] of runtime) if (value.expiresAt <= now()) runtime.delete(token);
    }
    function runtimeInput(context, token) {
        expire();
        const value = runtime.get(id(token));
        if (
            !value ||
            !value.complete ||
            value.contextId !== context.contextId ||
            value.userRoot !== context.userRoot
        )
            fail('WORLDBOOK_RUNTIME_EXPIRED');
        return { bindings: value.bindings, observed: value.observed, unknownBooks: value.unknownBooks || [] };
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
                    operations: [
                        'summary',
                        'catalog',
                        'tree',
                        'detail',
                        'sources',
                        'runtime',
                        'command',
                        'features',
                    ].map((id) => ({
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
                        storageSchemaVersion: 2,
                        featureVersion: 1,
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
                selections.clear();
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
            if (operation === 'features') {
                const transient = input.runtimeToken ? runtimeInput(context, input.runtimeToken) : null;
                if (['roll', 'discovery', 'session-end'].includes(input.kind))
                    return selections.read(context, target, input, transient);
                return target.features.read(input, transient);
            }
            if (operation === 'summary') return target.summary(input.page);
            if (operation === 'sources') return target.sources(input.page);
            if (operation === 'detail') return target.detail(input.id);
            if (operation === 'tree') return target.tree(input.id, input);
            if (operation === 'catalog')
                return target.catalog(
                    input,
                    input.runtimeToken ? runtimeInput(context, input.runtimeToken) : null,
                );
            fail('WORLDBOOK_VALIDATION');
        },
        async command(context, value) {
            return (await store(context)).execute(value, {
                getRuntime: (token) => runtimeInput(context, token),
            });
        },
        async runtime(context, value) {
            await store(context);
            expire();
            object(
                value,
                ['token', 'offset', 'bindings', 'complete', 'mode', 'unknownBooks'],
                ['offset', 'bindings', 'complete'],
            );
            if (value.mode !== undefined && value.mode !== 'observed') fail('WORLDBOOK_VALIDATION');
            const observed = value.mode === 'observed',
                maxBindings = observed ? LIMITS.maxObservedBindings : LIMITS.maxRuntimeBindings;
            if (
                value.unknownBooks !== undefined &&
                (!observed ||
                    value.offset !== 0 ||
                    !Array.isArray(value.unknownBooks) ||
                    value.unknownBooks.length > LIMITS.maxSources)
            )
                fail('WORLDBOOK_VALIDATION');
            const unknownBooks = [
                ...new Set((value.unknownBooks || []).map((name) => text(name, 240, true))),
            ];
            integer(value.offset, 0, maxBindings);
            if (
                !Array.isArray(value.bindings) ||
                value.bindings.length > LIMITS.runtimeBatchSize ||
                typeof value.complete !== 'boolean'
            )
                fail('WORLDBOOK_VALIDATION');
            const bindings = value.bindings.map((item) => {
                object(
                    item,
                    ['locator', 'uid', ...(observed ? ['enabled'] : [])],
                    ['locator', 'uid', ...(observed ? ['enabled'] : [])],
                );
                if (observed && typeof item.enabled !== 'boolean') fail('WORLDBOOK_VALIDATION');
                const clean = source({ locator: item.locator, uid: item.uid, title: 'runtime' });
                return {
                    locator: clean.locator,
                    uid: clean.uid,
                    ...(observed ? { enabled: item.enabled } : {}),
                };
            });
            let entry,
                token = value.token;
            if (token) {
                entry = runtime.get(id(token));
                if (!entry || entry.contextId !== context.contextId || entry.userRoot !== context.userRoot)
                    fail('WORLDBOOK_RUNTIME_EXPIRED');
                if (
                    entry.observed !== observed ||
                    (value.unknownBooks &&
                        JSON.stringify(unknownBooks) !== JSON.stringify(entry.unknownBooks))
                )
                    fail('WORLDBOOK_VALIDATION');
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
                    observed,
                    unknownBooks,
                    locatorStrings: new Map(),
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
                    entry.bindings.length + bindings.length > maxBindings
                )
                    fail('WORLDBOOK_VALIDATION');
                for (const binding of bindings) {
                    if (!entry.locatorStrings.has(binding.locator))
                        entry.locatorStrings.set(binding.locator, binding.locator);
                    binding.locator = entry.locatorStrings.get(binding.locator);
                    entry.bindings.push(binding);
                }
            }
            entry.complete ||= value.complete;
            runtime.set(token, entry);
            return {
                token,
                received: entry.bindings.length,
                complete: entry.complete,
                expiresAt: entry.expiresAt,
            };
        },
    };
}
