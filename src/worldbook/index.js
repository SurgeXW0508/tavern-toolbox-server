import { randomUUID } from 'node:crypto';
import { MEDIA_COMMANDS } from './media.js';
import { WorldbookCandidateSessions } from './candidate-sessions.js';
import { WorldbookStore } from './store.js';
import { LIMITS, WorldbookFailure, fail, object, integer, source, id, newId, text } from './validation.js';
export { WorldbookFailure, LIMITS } from './validation.js';

// Only Worldbook business data. ST runtime query inputs expire in memory and
// never enter SQLite, media/governance stores or application logs.
export function createWorldbook(config, { now = () => Date.now(), media, coordinate = async (_context, action) => action() } = {}) {
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
    const api = {
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
                        storageSchemaVersion: 3,
                        featureVersion: 1,
                        reconcileVersion: 1,
                        scope: 'st-user',
                        storage: 'sqlite',
                        identity: 'independent-material-and-source',
                        revision: 'entity-and-column-structure',
                        runtime: 'frontend-owned',
                        optionalMediaCapability: 'worldbook.media',
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
            if (MEDIA_COMMANDS.has(value?.action)) fail('WORLDBOOK_VALIDATION');
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
    api.mediaDefinition = { id:'worldbook-media', version:'0.1.0', dependsOn:['core','worldbook','media'],
        capabilities:[{ id:'worldbook.media', contract:{major:1,minMinor:0,maxMinor:0},
            operations:['read','command'].map(id=>({id,available:true})),
            operationAvailability:()=>({command:{available:config.policy.core.allowedOrigins.length>0,reasonCode:'ORIGIN_POLICY_MISSING'}}),
            limits:{maxGallery:6,maxReadMaterials:20},constraints:{kinds:['image'],revision:'material-media-cas',mediaRefProvider:'server'} }],
        health: async context=>{await store(context);return media.definition.health(context);} };
    api.readMedia = async (context,input) => {
        object(input,['materialIds','coversOnly'],['materialIds']);
        if(!Array.isArray(input.materialIds)||input.materialIds.length<1||input.materialIds.length>20||new Set(input.materialIds).size!==input.materialIds.length
            ||input.coversOnly!==undefined&&typeof input.coversOnly!=='boolean') fail('WORLDBOOK_VALIDATION');
        const target=await store(context);
        return {items:input.materialIds.map(value=>{id(value);const revision=target.media.revision(value);
            return input.coversOnly?{id:value,revision,cover:target.media.cover(value)}:target.media.read(value);})};
    };
    api.mediaCommand = async (context,value) => coordinate(context,async()=>{
        object(value,['commandId','action','data'],['commandId','action','data']);
        if(!MEDIA_COMMANDS.has(value.action)) fail('WORLDBOOK_VALIDATION');
        const target=await store(context);
        // Replays retain the original receipt even after a later unlink or asset removal.
        if(typeof value.commandId==='string'&&target.one('SELECT id FROM commands WHERE id=?',value.commandId))
            return target.execute(value,{mediaValidated:true});
        const refs=target.media.validate(value.action,value.data);
        if(target.media.revision(value.data.id)!==value.data.revision) fail('WORLDBOOK_MEDIA_CONFLICT');
        for(const ref of refs) {
            try {const asset=await media.metadata(context,ref.assetId),health=await media.health(context,ref.assetId);
                if(asset.kind!=='image'||health.original!=='healthy') fail('WORLDBOOK_MEDIA_UNAVAILABLE');}
            catch {fail('WORLDBOOK_MEDIA_UNAVAILABLE');}
        }
        return target.execute(value,{mediaValidated:true});
    });
    api.referenceProvider={id:'worldbook',consumer:'worldbook',label:'世界书',contextBound:true,
        enumerate:async context=>(await store(context)).media.groups(),
        mutate:async(context,body)=>{
            if(!['unlink','replace'].includes(body.action)) fail('WORLDBOOK_VALIDATION');
            const result=await api.mediaCommand(context,{commandId:`${now()}-${randomUUID()}`,action:`media-reference-${body.action}`,
                data:{id:body.groupId,revision:body.revision,referenceId:body.referenceId,
                    ...(body.action==='replace'?{kind:'image',mediaRef:body.mediaRef}:{})}});
            return {revision:result.media.revision};
        }};
    return api;
}
