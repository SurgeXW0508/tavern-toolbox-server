import { AudioReadSessions, BROWSE_TTL_MS } from './read-sessions.js';
import { scanAudioRows } from './scan.js';
import { AUDIO_ASSET_DEFAULTS, AUDIO_DEFAULTS } from '../config.js';
import { AudioAssetStore, AudioAssetFailure } from './store.js';
import { coordinateAudio } from './coordination.js';

export function createAudioAssets(config, references) {
    const policy = config.policy.audioAssets || AUDIO_ASSET_DEFAULTS;
    const limits = { ...policy, maxBytes: Math.min(policy.maxBytes, (config.policy.audio || AUDIO_DEFAULTS).maxResourceBytes) };
    const stores = new Map(), streams = new Set(), deletionObservers = new Set(); let DatabaseSync, stopped = false, runtimeError;
    const streamLimits = { localStreamsPerUser: 4, localStreamsGlobal: 16 };
    async function store(context) {
        if (stopped || !DatabaseSync || config.policy.audioAssetsError || !context?.userRoot)
            throw new AudioAssetFailure(runtimeError || config.policy.audioAssetsError || 'AUDIO_ASSET_UNAVAILABLE');
        if (!stores.has(context.userRoot)) stores.set(context.userRoot, coordinateAudio(context.userRoot, async () => {
            const item = new AudioAssetStore(context.userRoot, DatabaseSync, limits, id => references(context, id));
            await item.initialize(); return item;
        }));
        try { return await stores.get(context.userRoot); }
        catch (error) { stores.delete(context.userRoot); throw error; }
    }
    const readSessions = new AudioReadSessions();
    const service = {
        limits, store, readSessions,
        onDelete(observer) { deletionObservers.add(observer); return () => deletionObservers.delete(observer); },
        definition: { id: 'audio-assets', version: '0.1.0', dependsOn: ['core'],
            capabilities: [{ id: 'audio.assets', contract: { major: 1, minMinor: 0, maxMinor: 0 },
                operations: ['list', 'browse', 'read', 'stream', 'check', 'delete', 'cleanup'].map(id => ({ id, available: true })),
                operationAvailability: () => Object.fromEntries(['check', 'delete', 'cleanup'].map(id => [id, {
                    available: config.policy.core.allowedOrigins.length > 0, reasonCode: 'ORIGIN_POLICY_MISSING' }])),
                limits: { ...limits, ...streamLimits, pageSize: 50, maxAssets: 4096, browseTtlMs: BROWSE_TTL_MS }, constraints: { scope: 'st-user', persistence: 'sqlite-files',
                    assetIdentity: 'content-sha256', referenceScope: 'audio-sources', localOnly: true, singleRangeOnly: true } }],
            initialize: async () => { try { ({ DatabaseSync } = await import('node:sqlite')); }
                catch { runtimeError = 'AUDIO_ASSET_RUNTIME_UNAVAILABLE'; throw new Error(runtimeError); } },
            health: async context => { try { await store(context); return { state: 'ready', reasonCode: null }; }
                catch (error) { return { state: 'unavailable', reasonCode: error instanceof AudioAssetFailure ? error.code : 'AUDIO_ASSET_STORE_UNAVAILABLE' }; } },
            // Sources owns shutdown ordering: abort/await jobs before closing
            // either SQLite store. This module has no independent network work.
        },
        async list(context, cursor) { const item = await store(context); return coordinateAudio(context.userRoot, () => item.list(cursor)); },
        async browse(context, cursor = null, signal) {
            const item = await store(context);
            return readSessions.read(context, {
                key: 'assets', cursor, signal,
                capture: async () => ({ records: item.records(), stamp: item.readStamp(),
                    references: [...await item.references(null)].sort(([a], [b]) => a.localeCompare(b)) }),
                build: async (data, signal) => {
                    const references = new Map(data.references);
                    const rows = await scanAudioRows(data.records, row => item.view(row, references.get(row.asset_id) || 0), signal);
                    return { rows, summary: { count: rows.length, totalBytes: rows.reduce((sum, row) => sum + row.byteSize, 0),
                        healthy: rows.filter(row => row.health === 'healthy').length,
                        corrupt: rows.filter(row => row.health !== 'healthy').length,
                        orphan: rows.filter(row => row.referenceCount === 0).length,
                        quotaBytes: limits.quotaBytes, maxBytes: limits.maxBytes } };
                },
                checkPage: (rows, signal, data) => item.sameHealth(rows, data.records, signal),
                view: (entry, offset, nextCursor) => ({ assets: entry.rows.slice(offset, offset + 50), nextCursor, summary: entry.summary }),
            });
        },
        async read(context, id) { const item = await store(context); return coordinateAudio(context.userRoot, () => item.view(item.get(id))); },
        async check(context, id, signal) { const item = await store(context); return coordinateAudio(context.userRoot, () => item.check(id, signal)); },
        async remove(context, id) { const item = await store(context); return coordinateAudio(context.userRoot, async () => { const result = await item.remove(id); for (const observer of deletionObservers) await observer(context, id); return result; }); },
        async cleanup(context, ids) {
            const item = await store(context);
            return coordinateAudio(context.userRoot, async () => {
                // The UI confirms exact IDs observed as orphan; a new orphan
                // appearing after confirmation is never silently included.
                for (const id of ids) { item.get(id); if (await references(context, id)) throw new AudioAssetFailure('AUDIO_ASSET_REFERENCED'); }
                const removed = [];
                for (const id of ids) { await item.remove(id); for (const observer of deletionObservers) await observer(context, id); removed.push(id); }
                return { removed };
            });
        },
        async stream(context, id, range, output, signal) {
            if (stopped) throw new AudioAssetFailure('AUDIO_ASSET_UNAVAILABLE');
            if (streams.size >= streamLimits.localStreamsGlobal || [...streams].filter(entry => entry.root === context.userRoot).length >= streamLimits.localStreamsPerUser)
                throw new AudioAssetFailure('RESOURCE_BUSY');
            const controller = new AbortController(), abort = () => controller.abort(); let release;
            signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
            const entry = { root: context.userRoot, controller, done: new Promise(resolve => { release = resolve; }) }; streams.add(entry);
            try {
                const item = await store(context);
                if (controller.signal.aborted) throw new AudioAssetFailure('CLIENT_ABORTED');
                const transfer = await coordinateAudio(context.userRoot, () => item.stream(id, range, output, controller.signal));
                return await transfer();
            } catch (error) {
                if (controller.signal.aborted) throw new AudioAssetFailure('CLIENT_ABORTED'); throw error;
            } finally { signal.removeEventListener('abort', abort); streams.delete(entry); release(); }
        },
        async close() {
            stopped = true; await readSessions.close(); for (const entry of streams) entry.controller.abort(); await Promise.all([...streams].map(entry => entry.done));
            for (const [root, pending] of stores) { try { await coordinateAudio(root, async () => (await pending).close()); } catch {} } stores.clear();
        },
    };
    return service;
}
