import path from 'node:path';
import { mkdir, chmod, lstat } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { parseTarget } from '../network/destination.js';
import { createAudioAssets } from '../audio-assets/index.js';
import { AudioAssetFailure } from '../audio-assets/store.js';
import { coordinateAudio } from '../audio-assets/coordination.js';

export const MAX_AUDIO_SOURCES = 512;
export const SOURCE_PAGE_SIZE = 50;
export const validSourceId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{32}$/.test(id);
export const sourcePath = id => `/api/plugins/tavern-toolbox-server/v1/audio/sources/${id}/stream`;
export class AudioSourceFailure extends Error {
    constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new AudioSourceFailure(code); };
const identity = url => createHash('sha256').update(url).digest('hex');

// Source identity is independent of content digest and physical Audio Assets.
class SourceStore {
    constructor(userRoot, DatabaseSync) {
        this.root = path.join(userRoot, 'tavern-toolbox-server', 'audio-sources-v1');
        this.DatabaseSync = DatabaseSync;
    }
    async initialize() {
        const parent = path.dirname(this.root); await mkdir(parent, { recursive: true, mode: 0o700 });
        if ((await lstat(parent)).isSymbolicLink()) fail('AUDIO_SOURCE_DATA_INVALID');
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        if ((await lstat(this.root)).isSymbolicLink()) fail('AUDIO_SOURCE_DATA_INVALID');
        const file = path.join(this.root, 'sources.sqlite');
        try { if ((await lstat(file)).isSymbolicLink()) fail('AUDIO_SOURCE_DATA_INVALID'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const db = new this.DatabaseSync(file);
        try {
            await chmod(file, 0o600);
            db.exec('PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL;');
            const version = db.prepare('PRAGMA user_version').get().user_version;
            if (version > 2) fail('AUDIO_SOURCE_SCHEMA_INCOMPATIBLE');
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
            if (version < 2) db.exec('BEGIN IMMEDIATE; ALTER TABLE sources ADD COLUMN revision INTEGER NOT NULL DEFAULT 0; PRAGMA user_version = 2; COMMIT;');
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
        if (!Number.isSafeInteger(row.revision) || row.revision < 0) fail('AUDIO_SOURCE_DATA_INVALID');
        // Validate private metadata independently of today's allowlist. Policy
        // removal must not make an existing identity unreadable or change it.
        try { parseTarget(row.remote_url, { allowHttp: true, destinationPolicy: 'public-only' }); }
        catch { fail('AUDIO_SOURCE_DATA_INVALID'); }
        return row;
    }
    public(row) {
        this.validate(row);
        return { sourceId: row.source_id, backend: row.backend, hostname: new URL(row.remote_url).hostname,
            localAssetId: row.local_asset_id, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
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
            this.db.prepare('INSERT INTO sources VALUES (?, ?, ?, ?, NULL, ?, ?, 0)').run(id, hash, url, 'remote', now, now);
            const result = { source: this.public(this.get(id)), reused: false };
            this.db.exec('COMMIT'); begun = false; return result;
        } catch (error) { if (begun) this.db.exec('ROLLBACK'); throw error; }
    }
    lookup(url) { const row = this.db.prepare('SELECT * FROM sources WHERE identity_hash = ?').get(identity(url));
        if (row && row.remote_url !== url) fail('AUDIO_SOURCE_DATA_INVALID'); return row ? this.public(row) : null; }
    references(id) {
        // Validate every row before claiming zero references. A malformed
        // registry cannot authorize deletion of an apparently orphan Asset.
        const rows = this.db.prepare('SELECT * FROM sources').all(); rows.forEach(row => this.validate(row));
        const counts = new Map();
        for (const row of rows) if (row.local_asset_id) counts.set(row.local_asset_id, (counts.get(row.local_asset_id) || 0) + 1);
        return id === null ? counts : counts.get(id) || 0;
    }
    update(id, revision, backend, assetId) {
        const row = this.get(id);
        if (row.revision !== revision) fail('AUDIO_SOURCE_CONFLICT');
        if (row.backend === backend && row.local_asset_id === assetId) return this.public(row);
        this.db.prepare('UPDATE sources SET backend = ?, local_asset_id = ?, updated_at = ?, revision = revision + 1 WHERE source_id = ? AND revision = ?')
            .run(backend, assetId, Math.max(Date.now(), row.updated_at), id, revision);
        return this.public(this.get(id));
    }
    remove(id, revision) {
        const row = this.get(id);
        if (revision !== undefined && row.revision !== revision) fail('AUDIO_SOURCE_CONFLICT');
        this.db.prepare('DELETE FROM sources WHERE source_id = ?').run(id);
        // External media-library references are unknowable. Asset is retained.
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
    const assets = createAudioAssets(config, async (context, id) => (await store(context)).references(id));
    const jobs = new Map(), active = new Map();
    const LEASE_MS = 45000, JOB_TTL = 10 * 60000, MAX_JOBS = 1024, MAX_USER_JOBS = 128;
    const terminal = job => ['completed', 'failed', 'cancelled'].includes(job.state);
    const key = (context, id) => context.userRoot + ':' + id;
    const jobView = job => ({ jobId: job.id, sourceId: job.sourceId, state: job.state,
        receivedBytes: job.bytes, totalBytes: job.total, code: job.code, details: job.details,
        ...(job.source ? { source: job.source } : {}) });
    function sweep() {
        const now = Date.now();
        for (const [id, job] of jobs) {
            if (terminal(job) && job.updated < now - JOB_TTL) jobs.delete(id);
            else if (!terminal(job) && (job.lease < now || job.created < now - 2 * 60 * 60 * 1000)) job.controller.abort();
        }
    }
    const timer = setInterval(sweep, 1000); timer.unref();
    async function enrich(context, source) {
        if (!source.localAssetId) return { ...source, asset: null };
        try { return { ...source, asset: await assets.read(context, source.localAssetId) }; }
        catch (error) { return { ...source, asset: { assetId: source.localAssetId, health: 'unavailable', code:
            error instanceof AudioAssetFailure ? error.code : 'AUDIO_ASSET_UNAVAILABLE' } }; }
    }
    function jobFor(context, id) {
        const job = validSourceId(id) ? jobs.get(id) : null;
        if (!job || job.userRoot !== context.userRoot || job.contextId !== context.contextId) fail('AUDIO_JOB_NOT_FOUND');
        job.lease = Date.now() + LEASE_MS; return job;
    }
    async function execute(job, context, row, repair) {
        let stage, item, finalState;
        try {
            item = await assets.store(context);
            if (job.controller.signal.aborted) fail('CLIENT_ABORTED');
            job.state = 'downloading';
            stage = await item.download(audio, context, row.remote_url, job.controller.signal, (bytes, total) => {
                job.bytes = bytes; job.total = total ?? null;
            });
            job.state = 'committing';
            const source = await coordinateAudio(context.userRoot, async () => {
                if (job.controller.signal.aborted) fail('CLIENT_ABORTED');
                const registry = await store(context), current = registry.get(row.source_id);
                if (current.revision !== row.revision) fail('AUDIO_SOURCE_CONFLICT');
                const asset = await item.commit(stage);
                // Once the complete Asset is durable, binding is a synchronous
                // CAS write in this same critical section; cancellation never
                // leaves a half-Local Source. Crash here yields a known orphan.
                return registry.update(row.source_id, row.revision, 'local', asset.asset_id);
            });
            job.source = await enrich(context, source); finalState = 'completed';
        } catch (error) {
            job.code = job.controller.signal.aborted ? 'CLIENT_ABORTED' : /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code || '')
                ? error.code : 'AUDIO_LOCALIZE_FAILED';
            finalState = job.code === 'CLIENT_ABORTED' ? 'cancelled' : 'failed';
            if (job.code === 'TARGET_NOT_ALLOWED' && /^[a-z0-9.-]{1,253}$/.test(error.details?.hostname || '')) job.details = { hostname: error.details.hostname };
        } finally {
            if (stage) await item.discard(stage).catch(() => {});
            job.updated = Date.now(); job.state = finalState; active.delete(key(context, row.source_id));
        }
    }
    const service = {
        assets,
        definition: { id: 'audio-sources', version: '0.1.0', dependsOn: ['core'],
            capabilities: [{ id: 'audio.sources', contract: { major: 1, minMinor: 0, maxMinor: 0 },
                operations: ['create', 'list', 'read', 'delete', 'stream', 'lookup', 'restore', 'localize', 'backend', 'releaseLocal', 'repair', 'job', 'cancel'].map(id => ({ id, available: true })),
                operationAvailability: () => Object.fromEntries(['create', 'delete', 'lookup', 'restore', 'localize', 'backend', 'releaseLocal', 'repair', 'cancel'].map(id => [id, {
                    available: config.policy.core.allowedOrigins.length > 0, reasonCode: 'ORIGIN_POLICY_MISSING' }])),
                limits: { maxSources: MAX_AUDIO_SOURCES, pageSize: SOURCE_PAGE_SIZE, maxUrlLength: 2048 },
                constraints: { scope: 'st-user', persistence: 'sqlite', sourceIdentity: 'canonical-url-sha256',
                    stablePath: true, backends: ['remote', 'local'], localAssets: true, allowlist: 'independent', jobLeaseMs: LEASE_MS } }],
            initialize: async () => {
                try { ({ DatabaseSync } = await import('node:sqlite')); }
                catch { runtimeError = 'AUDIO_SOURCE_RUNTIME_UNAVAILABLE'; throw new Error(runtimeError); }
                await assets.definition.initialize();
            },
            health: async context => {
                try { await store(context); return { state: 'ready', reasonCode: null }; }
                catch { return { state: 'unavailable', reasonCode: runtimeError || failures.get(context?.userRoot) || 'AUDIO_SOURCE_STORE_UNAVAILABLE' }; }
            },
            shutdown: async () => {
                stopped = true;
                clearInterval(timer); for (const job of jobs.values()) if (!terminal(job)) job.controller.abort();
                await Promise.all([...jobs.values()].map(job => job.task).filter(Boolean));
                await assets.close(); jobs.clear(); active.clear();
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
            const item = await store(context);
            const result = await coordinateAudio(context.userRoot, () => item.create(target.url.href));
            return { ...result, source: await enrich(context, result.source) };
        },
        async lookup(context, raw) { const target = parseTarget(raw, { allowHttp: true, destinationPolicy: 'public-only' });
            if (target.url.href.length > 2048) fail('INVALID_REQUEST');
            const value = (await store(context)).lookup(target.url.href); return { source: value ? await enrich(context, value) : null }; },
        async list(context, cursor = null) { const page = (await store(context)).list(cursor);
            return { ...page, sources: await Promise.all(page.sources.map(source => enrich(context, source))) }; },
        async read(context, id) { const item = await store(context); return enrich(context, item.public(item.get(id))); },
        // Sensitive recovery metadata, explicit selected Source only. Never in list/read.
        async restore(context, id) { const row = (await store(context)).get(id); return { sourceId: id, url: row.remote_url }; },
        async remove(context, id, revision) { const item = await store(context);
            return coordinateAudio(context.userRoot, () => item.remove(id, revision)); },
        async backend(context, id, revision, backend, release = false) {
            const registry = await store(context), item = backend === 'local' ? await assets.store(context) : null;
            const source = await coordinateAudio(context.userRoot, async () => {
                const row = registry.get(id);
                if (!['remote', 'local'].includes(backend) || !Number.isSafeInteger(revision) || revision < 0) fail('INVALID_REQUEST');
                if (backend === 'local' && (!row.local_asset_id || await item.quick(item.get(row.local_asset_id)) !== 'healthy')) fail('AUDIO_ASSET_UNHEALTHY');
                return registry.update(id, revision, backend, release ? null : row.local_asset_id);
            });
            return enrich(context, source);
        },
        async localize(context, id, revision, repair = false, startSignal) {
            if (startSignal?.aborted) fail('CLIENT_ABORTED');
            sweep(); const registry = await store(context), item = await assets.store(context);
            return coordinateAudio(context.userRoot, async () => {
                if (startSignal?.aborted) fail('CLIENT_ABORTED');
                const row = registry.get(id);
                if (!Number.isSafeInteger(revision) || revision !== row.revision) fail('AUDIO_SOURCE_CONFLICT');
                const old = active.get(key(context, id)); if (old) return jobView(old);
                if (jobs.size >= MAX_JOBS || [...jobs.values()].filter(job => job.userRoot === context.userRoot).length >= MAX_USER_JOBS) fail('RESOURCE_BUSY');
                const now = Date.now(), job = { id: randomBytes(24).toString('base64url'), sourceId: id, userRoot: context.userRoot,
                    contextId: context.contextId, state: 'pending', bytes: 0, total: null, code: null, details: {}, controller: new AbortController(),
                    lease: now + LEASE_MS, created: now, updated: now };
                if (!repair && row.local_asset_id && await item.quick(item.get(row.local_asset_id)) === 'healthy') {
                    job.source = { ...registry.update(id, revision, 'local', row.local_asset_id), asset: await item.view(item.get(row.local_asset_id)) };
                    job.state = 'completed'; jobs.set(job.id, job); return jobView(job);
                }
                const running = [...jobs.values()].filter(job => !terminal(job));
                if (running.length >= assets.limits.globalConcurrency || running.filter(job => job.userRoot === context.userRoot).length >= assets.limits.perUserConcurrency) fail('RESOURCE_BUSY');
                jobs.set(job.id, job); active.set(key(context, id), job);
                // Start after returning from the reference lock; downloads and
                // Asset initialization must never run inside that lock.
                const abortStart = () => job.controller.abort();
                startSignal?.addEventListener('abort', abortStart, { once: true });
                job.task = new Promise(resolve => setImmediate(resolve)).then(() => execute(job, context, row, repair))
                    .finally(() => startSignal?.removeEventListener('abort', abortStart));
                return jobView(job);
            });
        },
        job(context, id) { return jobView(jobFor(context, id)); },
        cancel(context, id) { const job = jobFor(context, id); if (!terminal(job)) job.controller.abort(); return jobView(job); },
        async stream(context, id, range, output, signal) {
            const row = (await store(context)).get(id);
            if (signal.aborted) fail('CLIENT_ABORTED');
            if (row.backend === 'local') return assets.stream(context, row.local_asset_id, range, output, signal);
            // No direct/local fallback. Every Range GET re-enters current
            // Network policy/DNS/redirect approval and the shared Audio budget.
            return audio.relay(row.remote_url, context.contextId, range, output, signal);
        },
    };
    return service;
}
