import path from 'node:path';
import { mkdir, chmod } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { parseTarget } from '../network/destination.js';

export const MAX_AUDIO_SOURCES = 512;
export const SOURCE_PAGE_SIZE = 50;
export const validSourceId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{32}$/.test(id);
export const sourcePath = id => `/api/plugins/tavern-toolbox-server/v1/audio/sources/${id}/stream`;
export class AudioSourceFailure extends Error {
    constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new AudioSourceFailure(code); };
const identity = url => createHash('sha256').update(url).digest('hex');

// Separate from image MediaStore. The optional asset binding is an identity
// boundary only; this stage has no Audio Asset storage or localization API.
class SourceStore {
    constructor(userRoot, DatabaseSync) {
        this.root = path.join(userRoot, 'tavern-toolbox-server', 'audio-sources-v1');
        this.DatabaseSync = DatabaseSync;
    }
    async initialize() {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const file = path.join(this.root, 'sources.sqlite');
        const db = new this.DatabaseSync(file);
        try {
            await chmod(file, 0o600);
            db.exec('PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL;');
            const version = db.prepare('PRAGMA user_version').get().user_version;
            if (version > 1) fail('AUDIO_SOURCE_SCHEMA_INCOMPATIBLE');
            if (version === 0) {
                if (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n)
                    fail('AUDIO_SOURCE_DATA_INVALID');
                db.exec(`BEGIN IMMEDIATE;
                    CREATE TABLE sources (
                        source_id TEXT PRIMARY KEY NOT NULL,
                        identity_hash TEXT UNIQUE NOT NULL,
                        remote_url TEXT NOT NULL,
                        backend TEXT NOT NULL CHECK(backend IN ('remote', 'local')),
                        local_asset_id TEXT,
                        created_at INTEGER NOT NULL,
                        updated_at INTEGER NOT NULL
                    );
                    PRAGMA user_version = 1;
                    COMMIT;`);
            }
            this.db = db;
            this.list(null);
        } catch (error) { db.close(); throw error; }
    }
    validate(row) {
        if (!row || !validSourceId(row.source_id) || typeof row.remote_url !== 'string' || row.remote_url.length > 2048
            || identity(row.remote_url) !== row.identity_hash || !['remote', 'local'].includes(row.backend)
            || row.local_asset_id !== null && !validSourceId(row.local_asset_id)
            || row.backend === 'local' && row.local_asset_id === null
            || ![row.created_at, row.updated_at].every(value => Number.isSafeInteger(value) && value > 0)
            || row.updated_at < row.created_at)
            fail('AUDIO_SOURCE_DATA_INVALID');
        // Validate private metadata independently of today's allowlist. Policy
        // removal must not make an existing identity unreadable or change it.
        try { parseTarget(row.remote_url, { allowHttp: true, destinationPolicy: 'public-only' }); }
        catch { fail('AUDIO_SOURCE_DATA_INVALID'); }
        return row;
    }
    public(row) {
        this.validate(row);
        return { sourceId: row.source_id, backend: row.backend, hostname: new URL(row.remote_url).hostname,
            localAssetId: row.local_asset_id, createdAt: row.created_at, updatedAt: row.updated_at,
            playbackPath: sourcePath(row.source_id) };
    }
    get(id) {
        if (!validSourceId(id)) fail('AUDIO_SOURCE_NOT_FOUND');
        const row = this.db.prepare('SELECT * FROM sources WHERE source_id = ?').get(id);
        if (!row) fail('AUDIO_SOURCE_NOT_FOUND');
        return this.validate(row);
    }
    list(cursor) {
        if (cursor !== null && !validSourceId(cursor)) fail('INVALID_REQUEST');
        const rows = this.db.prepare('SELECT * FROM sources WHERE source_id > ? ORDER BY source_id LIMIT ?')
            .all(cursor || '', SOURCE_PAGE_SIZE + 1);
        return { sources: rows.slice(0, SOURCE_PAGE_SIZE).map(row => this.public(row)),
            nextCursor: rows.length > SOURCE_PAGE_SIZE ? rows[SOURCE_PAGE_SIZE - 1].source_id : null };
    }
    create(url) {
        const hash = identity(url);
        let begun = false;
        try {
            this.db.exec('BEGIN IMMEDIATE'); begun = true;
            const old = this.db.prepare('SELECT * FROM sources WHERE identity_hash = ?').get(hash);
            if (old) {
                if (old.remote_url !== url) fail('AUDIO_SOURCE_DATA_INVALID');
                const result = { source: this.public(old), reused: true };
                this.db.exec('COMMIT'); begun = false; return result;
            }
            if (this.db.prepare('SELECT COUNT(*) AS n FROM sources').get().n >= MAX_AUDIO_SOURCES) fail('AUDIO_SOURCES_FULL');
            const id = randomBytes(24).toString('base64url'), now = Date.now();
            this.db.prepare('INSERT INTO sources VALUES (?, ?, ?, ?, NULL, ?, ?)').run(id, hash, url, 'remote', now, now);
            const result = { source: this.public(this.get(id)), reused: false };
            this.db.exec('COMMIT'); begun = false; return result;
        } catch (error) { if (begun) this.db.exec('ROLLBACK'); throw error; }
    }
    remove(id) {
        this.get(id);
        this.db.prepare('DELETE FROM sources WHERE source_id = ?').run(id);
        // Removing a Source never deletes an Asset. This stage has none.
        return { removed: true };
    }
    close() { this.db.close(); }
}

export function createAudioSources(config, audio) {
    const stores = new Map(), failures = new Map();
    let DatabaseSync, runtimeError = null, stopped = false;
    async function store(context) {
        if (stopped || !DatabaseSync || !context?.userRoot) fail(runtimeError || 'AUDIO_SOURCE_UNAVAILABLE');
        if (!stores.has(context.userRoot)) stores.set(context.userRoot, (async () => {
            const item = new SourceStore(context.userRoot, DatabaseSync); await item.initialize(); return item;
        })());
        try { const item = await stores.get(context.userRoot); failures.delete(context.userRoot); return item; }
        catch (error) {
            stores.delete(context.userRoot);
            failures.set(context.userRoot, error instanceof AudioSourceFailure ? error.code : 'AUDIO_SOURCE_STORE_UNAVAILABLE');
            throw error;
        }
    }
    return {
        definition: { id: 'audio-sources', version: '0.1.0', dependsOn: ['core'],
            capabilities: [{ id: 'audio.sources', contract: { major: 1, minMinor: 0, maxMinor: 0 },
                operations: ['create', 'list', 'read', 'delete', 'stream'].map(id => ({ id, available: true })),
                operationAvailability: () => ({ create: { available: config.policy.core.allowedOrigins.length > 0, reasonCode: 'ORIGIN_POLICY_MISSING' },
                    delete: { available: config.policy.core.allowedOrigins.length > 0, reasonCode: 'ORIGIN_POLICY_MISSING' },
                    stream: { available: audio.definition.capabilities[0].operations.find(op => op.id === 'stream').available,
                        reasonCode: 'CAPABILITY_UNAVAILABLE' } }),
                limits: { maxSources: MAX_AUDIO_SOURCES, pageSize: SOURCE_PAGE_SIZE, maxUrlLength: 2048 },
                constraints: { scope: 'st-user', persistence: 'sqlite', sourceIdentity: 'canonical-url-sha256',
                    stablePath: true, backends: ['remote'], localAssets: false, allowlist: 'independent' } }],
            initialize: async () => {
                try { ({ DatabaseSync } = await import('node:sqlite')); }
                catch { runtimeError = 'AUDIO_SOURCE_RUNTIME_UNAVAILABLE'; throw new Error(runtimeError); }
            },
            health: async context => {
                try { await store(context); return { state: 'ready', reasonCode: null }; }
                catch { return { state: 'unavailable', reasonCode: runtimeError || failures.get(context?.userRoot) || 'AUDIO_SOURCE_STORE_UNAVAILABLE' }; }
            },
            shutdown: async () => {
                stopped = true;
                for (const pending of stores.values()) { try { (await pending).close(); } catch {} }
                stores.clear();
            },
        },
        async create(context, raw) {
            // Creating/reusing identity is a metadata operation, not permission
            // to access it. This also permits reuse after allowlist removal;
            // each actual Remote stream still applies current Network policy.
            const target = parseTarget(raw, { allowHttp: true, destinationPolicy: 'public-only' });
            if (target.url.href.length > 2048) fail('INVALID_REQUEST');
            if (/\.(?:m3u8|mpd)$/i.test(target.url.pathname)) fail('UNSUPPORTED_MEDIA_TYPE');
            return (await store(context)).create(target.url.href);
        },
        async list(context, cursor = null) { return (await store(context)).list(cursor); },
        async read(context, id) { const item = await store(context); return item.public(item.get(id)); },
        async remove(context, id) { return (await store(context)).remove(id); },
        async stream(context, id, range, output, signal) {
            const row = (await store(context)).get(id);
            if (signal.aborted) fail('CLIENT_ABORTED');
            if (row.backend !== 'remote') fail('AUDIO_SOURCE_BACKEND_UNAVAILABLE');
            // No direct/local fallback. Every Range GET re-enters current
            // Network policy/DNS/redirect approval and the shared Audio budget.
            return audio.relay(row.remote_url, context.contextId, range, output, signal);
        },
    };
}
