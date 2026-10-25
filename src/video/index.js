import { VideoStore } from './store.js';
import { VideoDiscovery } from './discovery.js';
import { VIDEO_DEFAULTS, VIDEO_LIMITS } from './policy.js';
import { rootFor, openVideo } from './roots.js';
import { fail, object, uuid, text, integer, aborted } from './validation.js';
import { streamLocalFile } from '../transport/local-file-stream.js';

export function createVideo(config, { now = Date.now } = {}) {
    const policy = config.policy.video || VIDEO_DEFAULTS, discovery = new VideoDiscovery(policy, now);
    const stores = new Map(), active = new Set(), streams = new Set();
    let DatabaseSync, stopped = false;
    const authorized = context => policy.roots.filter(root => root.users.includes(context.userHandle));
    function ready(context) {
        if (stopped || !DatabaseSync || config.policy.videoError || !context?.userRoot || !authorized(context).length) fail('VIDEO_UNAVAILABLE');
    }
    async function store(context) {
        ready(context);
        if (!stores.has(context.userRoot)) stores.set(context.userRoot, (async () => {
            const item = new VideoStore(context.userRoot, DatabaseSync); await item.initialize(); return item;
        })());
        try { return await stores.get(context.userRoot); } catch (error) { stores.delete(context.userRoot); throw error; }
    }
    // Track/drain every asynchronous operation before closing a user's DB.
    async function run(context, signal, action) {
        ready(context); aborted(signal);
        if (active.size >= 8 || [...active].filter(item => item.root === context.userRoot).length >= 2) fail('RESOURCE_BUSY');
        const controller = new AbortController(), abort = () => controller.abort(); let finish;
        const entry = { root: context.userRoot, controller, done: new Promise(resolve => { finish = resolve; }) }; active.add(entry);
        signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
        try { return await action(controller.signal); }
        finally { signal?.removeEventListener('abort', abort); active.delete(entry); finish(); }
    }
    const service = {
        definition: { id: 'video', version: '0.1.0', dependsOn: ['core'],
            initialize: async () => { ({ DatabaseSync } = await import('node:sqlite')); },
            health: context => ({ state: stopped ? 'unavailable' : config.policy.videoError ? 'unavailable' : authorized(context).length ? 'ready' : 'disabled',
                reasonCode: stopped ? 'VIDEO_UNAVAILABLE' : config.policy.videoError || (authorized(context).length ? null : 'VIDEO_NOT_CONFIGURED') }),
            capabilities: [
                ['video.catalog', ['list', 'read', 'presentation']],
                ['video.sources', ['roots', 'browse', 'cancel', 'register']],
                ['video.playback', ['resolve', 'stream']],
            ].map(([id, operations]) => ({ id, contract: { major: 1, minMinor: 0, maxMinor: 0 }, operations: operations.map(id => ({ id, available: true })),
                operationAvailability: () => Object.fromEntries((id === 'video.sources' ? ['browse', 'cancel', 'register'] : id === 'video.playback' ? ['resolve'] : ['presentation']).map(id =>
                    [id, { available: config.policy.core.allowedOrigins.length > 0, reasonCode: 'ORIGIN_POLICY_MISSING' }])),
                limits: { ...VIDEO_LIMITS, maxBytes: policy.maxBytes }, constraints: { scope: 'st-user', localOnly: true, automaticGc: false } })),
            shutdown: () => service.close(),
        },
        roots(context) { ready(context); return { roots: authorized(context).map(root => ({ rootKey: root.key, label: root.label })) }; },
        browse(context, input, signal) { return run(context, signal, signal => discovery.browse(context, input, signal)); },
        cancel(context, id) { ready(context); return discovery.cancel(context, id); },
        register(context, input, signal) {
            return run(context, signal, async signal => {
                object(input, ['candidateId', 'operationId', 'title'], ['candidateId', 'operationId', 'title']);
                uuid(input.candidateId); uuid(input.operationId); const title = text(input.title), item = await store(context);
                const hash = item.requestHash([input.candidateId, title]), replay = item.receipt(input.operationId, hash, now());
                if (replay) { rootFor(policy, context, item.row(replay.mediaRef.assetId).root_key); return replay; }
                const { session, entry } = discovery.candidate(context, input.candidateId);
                const file = await openVideo(policy, context, session.rootKey, entry.relative, entry.fingerprint, signal);
                try { aborted(signal); return item.register({ operationId: input.operationId, requestHash: hash, title, rootKey: session.rootKey, relative: entry.relative, file }, now()); }
                finally { await file.handle.close(); }
            });
        },
        list(context, input = {}, signal) {
            return run(context, signal, async signal => {
                object(input, ['search', 'offset', 'limit']); const item = await store(context); aborted(signal);
                return item.list(input, authorized(context).map(root => root.key));
            });
        },
        presentation(context, ids, signal) {
            return run(context, signal, async signal => {
                if (!Array.isArray(ids) || !ids.length || ids.length > 48 || new Set(ids).size !== ids.length) fail('INVALID_REQUEST'); ids.forEach(uuid);
                const item = await store(context), items = [], missingAssetIds = []; aborted(signal);
                for (const id of ids) { try { const row = item.row(id); rootFor(policy, context, row.root_key); items.push(item.view(row)); }
                    catch (error) { if (error.code !== 'VIDEO_NOT_FOUND') throw error; missingAssetIds.push(id); } }
                return { items, missingAssetIds };
            });
        },
        read(context, id, signal) {
            return run(context, signal, async signal => {
                const item = await store(context), row = item.row(id); rootFor(policy, context, row.root_key);
                let sourceState = 'available';
                try { const file = await openVideo(policy, context, row.root_key, row.locator, row.fingerprint, signal); await file.handle.close(); }
                catch (error) { if (error.code === 'CLIENT_ABORTED') throw error; sourceState = error.code === 'VIDEO_SOURCE_CHANGED' ? 'changed' : 'unavailable'; }
                return { ...item.view(row), sourceState };
            });
        },
        resolve(context, id, signal) {
            return run(context, signal, async signal => {
                const item = await store(context), row = item.row(id);
                const file = await openVideo(policy, context, row.root_key, row.locator, row.fingerprint, signal);
                await file.handle.close();
                return { ...item.view(row), playbackPath: `/api/plugins/tavern-toolbox-server/v1/video/items/${id}/stream?context=${context.contextId}&version=${row.source_revision}` };
            });
        },
        async stream(context, id, version, range, head, output, signal) {
            ready(context); integer(version); aborted(signal);
            if (streams.size >= VIDEO_LIMITS.streamsGlobal || [...streams].filter(item => item.root === context.userRoot).length >= VIDEO_LIMITS.streamsPerUser) fail('RESOURCE_BUSY');
            const controller = new AbortController(), abort = () => controller.abort(); let finish;
            const entry = { root: context.userRoot, controller, done: new Promise(resolve => { finish = resolve; }) }; streams.add(entry);
            signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
            let file;
            try {
                const item = await store(context), row = item.row(id);
                if (version !== row.source_revision) fail('VIDEO_SOURCE_CHANGED');
                file = await openVideo(policy, context, row.root_key, row.locator, row.fingerprint, controller.signal);
                const handle = file.handle; file = null; // transfer owns close from this point
                await streamLocalFile({ handle, size: row.byte_size, mime: row.mime, range, head, output, signal: controller.signal });
            } finally { await file?.handle.close(); signal?.removeEventListener('abort', abort); streams.delete(entry); finish(); }
        },
        async close() {
            stopped = true;
            for (const item of [...active, ...streams]) item.controller.abort();
            await Promise.all([...active, ...streams].map(item => item.done)); discovery.clear();
            await Promise.all([...stores.values()].map(async pending => { try { (await pending).close(); } catch {} })); stores.clear();
        },
    };
    return service;
}
