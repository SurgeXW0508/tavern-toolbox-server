import path from 'node:path';
import { constants } from 'node:fs';
import { mkdir, chmod, lstat, open, rename, unlink, readdir } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { once } from 'node:events';
import { AUDIO_MIME, singleRange } from '../network/audio-profile.js';
import { audioSignature } from './validation.js';

export const validAssetId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{32}$/.test(id);
export const assetPath = id => `/api/plugins/tavern-toolbox-server/v1/audio/assets/${id}/stream`;
export const STAGING_MAX_AGE = 24 * 60 * 60 * 1000;
// Shared by instances in this process. Recovery must not remove another live
// localization operation's staging file. A second ST process is unsupported.
const activeStaging = new Set();
export class AudioAssetFailure extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new AudioAssetFailure(code); };
const missing = error => error?.code === 'ENOENT';
async function directory(file) {
    await mkdir(file, { recursive: true, mode: 0o700 });
    const info = await lstat(file);
    if (!info.isDirectory() || info.isSymbolicLink()) fail('AUDIO_ASSET_STORE_UNAVAILABLE');
    await chmod(file, 0o700);
}
async function syncDirectory(file) { const handle = await open(file, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
async function safeUnlink(file) {
    try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) fail('AUDIO_ASSET_DATA_INVALID'); await unlink(file); }
    catch (error) { if (!missing(error)) throw error; }
}

export class AudioAssetStore {
    constructor(userRoot, DatabaseSync, limits, references) {
        this.root = path.join(userRoot, 'tavern-toolbox-server', 'audio-assets-v1');
        this.originals = path.join(this.root, 'originals'); this.staging = path.join(this.root, 'staging');
        this.DatabaseSync = DatabaseSync; this.limits = limits; this.references = references;
    }
    file(id) { if (!validAssetId(id)) fail('AUDIO_ASSET_NOT_FOUND'); return path.join(this.originals, id + '.audio'); }
    stage(id) { if (!validAssetId(id)) fail('INVALID_REQUEST'); return path.join(this.staging, id + '.part'); }
    async initialize() {
        await directory(path.dirname(this.root));
        for (const dir of [this.root, this.originals, this.staging]) await directory(dir);
        const file = path.join(this.root, 'metadata.sqlite');
        try { if ((await lstat(file)).isSymbolicLink()) fail('AUDIO_ASSET_DATA_INVALID'); } catch (error) { if (!missing(error)) throw error; }
        const db = new this.DatabaseSync(file);
        try {
            await chmod(file, 0o600); db.exec('PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL;');
            const version = db.prepare('PRAGMA user_version').get().user_version;
            if (version > 1) fail('AUDIO_ASSET_SCHEMA_INCOMPATIBLE');
            if (version === 0) {
                if (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n) fail('AUDIO_ASSET_DATA_INVALID');
                db.exec(`BEGIN IMMEDIATE;
                    CREATE TABLE assets (asset_id TEXT PRIMARY KEY NOT NULL, digest TEXT UNIQUE NOT NULL,
                        mime TEXT NOT NULL, byte_size INTEGER NOT NULL, created_at INTEGER NOT NULL,
                        state TEXT NOT NULL, health TEXT NOT NULL, staging_id TEXT);
                    PRAGMA user_version = 1; COMMIT;`);
            }
            this.db = db; await this.recover();
        } catch (error) { db.close(); throw error; }
    }
    validate(row) {
        if (!row || !validAssetId(row.asset_id) || !/^[a-f0-9]{64}$/.test(row.digest || '')
            || !AUDIO_MIME.includes(row.mime) || !Number.isSafeInteger(row.byte_size) || row.byte_size < 1 || row.byte_size > 1024 ** 3
            || !Number.isSafeInteger(row.created_at) || row.created_at < 1
            || !['pending', 'ready', 'deleting'].includes(row.state) || !['healthy', 'missing', 'corrupt'].includes(row.health)
            || row.staging_id !== null && !validAssetId(row.staging_id)) fail('AUDIO_ASSET_DATA_INVALID');
        return row;
    }
    get(id, any = false) {
        if (!validAssetId(id)) fail('AUDIO_ASSET_NOT_FOUND');
        const row = this.db.prepare('SELECT * FROM assets WHERE asset_id = ?').get(id);
        if (!row || !any && row.state !== 'ready') fail('AUDIO_ASSET_NOT_FOUND');
        return this.validate(row);
    }
    async quick(row) {
        this.validate(row);
        try {
            const info = await lstat(this.file(row.asset_id));
            if (!info.isFile() || info.isSymbolicLink() || info.size !== row.byte_size) return 'corrupt';
            return row.health;
        } catch (error) { return missing(error) ? 'missing' : 'corrupt'; }
    }
    async view(row, referenceCount) {
        this.validate(row);
        return { assetId: row.asset_id, mime: row.mime, byteSize: row.byte_size, createdAt: row.created_at,
            health: await this.quick(row), referenceCount: referenceCount ?? await this.references(row.asset_id), playbackPath: assetPath(row.asset_id) };
    }
    async digestFile(file, row, signal) {
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
            const info = await handle.stat();
            if (!info.isFile() || info.size !== row.byte_size) return false;
            const hash = createHash('sha256'), chunk = Buffer.alloc(64 * 1024); let position = 0, prefix;
            for (;;) {
                if (signal?.aborted) fail('CLIENT_ABORTED');
                const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
                if (!bytesRead) break;
                if (!prefix) prefix = Buffer.from(chunk.subarray(0, Math.min(bytesRead, 4096)));
                hash.update(chunk.subarray(0, bytesRead)); position += bytesRead;
            }
            return position === row.byte_size && hash.digest('hex') === row.digest && audioSignature(row.mime, prefix || Buffer.alloc(0), row.byte_size);
        } finally { await handle.close(); }
    }
    async check(id, signal) {
        const row = this.get(id); let health;
        try { health = await this.digestFile(this.file(id), row, signal) ? 'healthy' : 'corrupt'; }
        catch (error) { if (signal?.aborted) throw error; health = missing(error) ? 'missing' : 'corrupt'; }
        this.db.prepare('UPDATE assets SET health = ? WHERE asset_id = ?').run(health, id);
        return this.view(this.get(id));
    }
    async recover() {
        for (const raw of this.db.prepare("SELECT * FROM assets WHERE state != 'ready'").all()) {
            const row = this.validate(raw);
            if (row.staging_id && activeStaging.has(this.stage(row.staging_id))) continue;
            if (await this.references(row.asset_id)) fail('AUDIO_ASSET_DATA_INVALID');
            if (row.state === 'deleting') { await this.finishDelete(row); continue; }
            let good = false;
            try { good = await this.digestFile(this.file(row.asset_id), row); } catch {}
            if (!good && row.staging_id) {
                try {
                    if (await this.digestFile(this.stage(row.staging_id), row)) {
                        await rename(this.stage(row.staging_id), this.file(row.asset_id)); await syncDirectory(this.originals); good = true;
                    }
                } catch {}
            }
            if (good) this.db.prepare("UPDATE assets SET state = 'ready', health = 'healthy', staging_id = NULL WHERE asset_id = ?").run(row.asset_id);
            else { await safeUnlink(this.file(row.asset_id)); this.db.prepare('DELETE FROM assets WHERE asset_id = ?').run(row.asset_id); }
            if (row.staging_id) await safeUnlink(this.stage(row.staging_id));
        }
        for (const name of await readdir(this.staging)) {
            if (!/^[A-Za-z0-9_-]{32}\.part$/.test(name)) continue;
            const file = path.join(this.staging, name);
            if (activeStaging.has(file)) continue;
            const info = await lstat(file);
            if (info.isFile() && !info.isSymbolicLink() && info.mtimeMs < Date.now() - STAGING_MAX_AGE) await unlink(file);
        }
    }
    async download(audio, context, url, signal, progress) {
        const stagingId = randomBytes(24).toString('base64url'), file = this.stage(stagingId);
        activeStaging.add(file);
        let handle, sink;
        try {
            handle = await open(file, 'wx', 0o600);
            const hash = createHash('sha256'); let bytes = 0, prefix = Buffer.alloc(0), mime, length;
            sink = new Writable({ highWaterMark: 1, write: (chunk, _encoding, callback) => {
                const perform = async () => {
                    if (signal.aborted) fail('CLIENT_ABORTED');
                    bytes += chunk.length;
                    if (bytes > this.limits.maxBytes) fail('REMOTE_RESOURCE_TOO_LARGE');
                    hash.update(chunk);
                    if (prefix.length < 4096) prefix = Buffer.concat([prefix, chunk.subarray(0, 4096 - prefix.length)]);
                    let offset = 0;
                    while (offset < chunk.length) { const result = await handle.write(chunk, offset, chunk.length - offset); offset += result.bytesWritten; }
                    progress?.(bytes, length);
                };
                void perform().then(() => callback(), callback);
            } });
            sink.setHeader = (key, value) => {
                if (key.toLowerCase() === 'content-type') mime = value;
                if (key.toLowerCase() === 'content-length') length = Number(value);
            };
            const completion = finished(sink); completion.catch(() => {});
            await audio.download(url, context.contextId, sink, signal, this.limits.maxBytes);
            await completion;
            if (signal.aborted) fail('CLIENT_ABORTED');
            if (sink.statusCode !== 200 || bytes !== length || !audioSignature(mime, prefix, bytes)) fail('AUDIO_ASSET_INVALID_CONTENT');
            await handle.sync(); await handle.close(); handle = null;
            return { stagingId, file, digest: hash.digest('hex'), mime, byteSize: bytes };
        } catch (error) {
            sink?.destroy(); if (handle) await handle.close().catch(() => {});
            try { await safeUnlink(file); } catch { fail('AUDIO_STAGING_CLEANUP_FAILED'); }
            finally { activeStaging.delete(file); } throw error;
        }
    }
    async discard(stage) { try { await safeUnlink(stage.file); } finally { activeStaging.delete(stage.file); } }
    async commit(stage) {
        // Caller holds the Audio reference lock. Duplicate content needs no
        // extra quota and never creates another identity or physical file.
        const existing = this.db.prepare('SELECT * FROM assets WHERE digest = ?').get(stage.digest);
        if (existing) {
            this.validate(existing);
            if (existing.state !== 'ready') fail('AUDIO_ASSET_STORE_UNAVAILABLE');
            if (existing.mime !== stage.mime || existing.byte_size !== stage.byteSize) fail('AUDIO_ASSET_DATA_INVALID');
            if (await this.quick(existing) !== 'healthy' || !await this.digestFile(this.file(existing.asset_id), existing)) {
                await rename(stage.file, this.file(existing.asset_id)); await syncDirectory(this.originals);
                this.db.prepare("UPDATE assets SET health = 'healthy' WHERE asset_id = ?").run(existing.asset_id);
            }
            await this.discard(stage); return this.get(existing.asset_id);
        }
        const records = this.db.prepare('SELECT * FROM assets').all(); records.forEach(row => this.validate(row));
        const used = records.reduce((sum, row) => sum + row.byte_size, 0);
        if (records.length >= 4096) fail('AUDIO_ASSETS_FULL');
        if (used + stage.byteSize > this.limits.quotaBytes) fail('AUDIO_QUOTA_EXCEEDED');
        const id = randomBytes(24).toString('base64url');
        this.db.prepare("INSERT INTO assets VALUES (?, ?, ?, ?, ?, 'pending', 'healthy', ?)")
            .run(id, stage.digest, stage.mime, stage.byteSize, Date.now(), stage.stagingId);
        try {
            await rename(stage.file, this.file(id)); await syncDirectory(this.originals);
            this.db.prepare("UPDATE assets SET state = 'ready', staging_id = NULL WHERE asset_id = ?").run(id);
            activeStaging.delete(stage.file); return this.get(id);
        } catch (error) {
            // Leave recognized pending metadata if cleanup itself cannot finish;
            // startup recovery owns it. Source has not been bound yet.
            try { await safeUnlink(this.file(id)); await this.discard(stage); this.db.prepare('DELETE FROM assets WHERE asset_id = ?').run(id); } catch {}
            throw error;
        }
    }
    async list(cursor = null) {
        if (cursor !== null && !validAssetId(cursor)) fail('INVALID_REQUEST');
        const all = this.db.prepare("SELECT * FROM assets WHERE state = 'ready' ORDER BY asset_id").all();
        let totalBytes = 0, healthy = 0, corrupt = 0, orphan = 0;
        const references = await this.references(null);
        for (const row of all) {
            this.validate(row); totalBytes += row.byte_size;
            if (await this.quick(row) === 'healthy') healthy++; else corrupt++;
            if (!references.get(row.asset_id)) orphan++;
        }
        const page = all.filter(row => row.asset_id > (cursor || '')).slice(0, 51);
        const assets = await Promise.all(page.slice(0, 50).map(row => this.view(row, references.get(row.asset_id) || 0)));
        return { assets, nextCursor: page.length > 50 ? page[49].asset_id : null,
            summary: { count: all.length, totalBytes, healthy, corrupt, orphan, quotaBytes: this.limits.quotaBytes, maxBytes: this.limits.maxBytes } };
    }
    async finishDelete(row) {
        await safeUnlink(this.file(row.asset_id)); await syncDirectory(this.originals);
        this.db.prepare('DELETE FROM assets WHERE asset_id = ?').run(row.asset_id);
    }
    async remove(id) {
        const row = this.get(id, true);
        if (await this.references(id)) fail('AUDIO_ASSET_REFERENCED');
        this.db.prepare("UPDATE assets SET state = 'deleting' WHERE asset_id = ?").run(id);
        await this.finishDelete(row); return { removed: true };
    }
    async stream(id, range, output, signal) {
        if (signal.aborted) fail('CLIENT_ABORTED');
        const row = this.get(id);
        if (await this.quick(row) !== 'healthy') fail('AUDIO_ASSET_UNHEALTHY');
        singleRange(range);
        let handle;
        try {
            handle = await open(this.file(id), constants.O_RDONLY | constants.O_NOFOLLOW);
            const info = await handle.stat(); if (!info.isFile() || info.size !== row.byte_size) fail('AUDIO_ASSET_UNHEALTHY');
        } catch (error) { await handle?.close(); if (error instanceof AudioAssetFailure) throw error; fail('AUDIO_ASSET_UNHEALTHY'); }
        // Open file is pinned before releasing the reference lock. Subsequent
        // delete/repair cannot redirect this request to Network or a new file.
        return async () => {
            const abort = () => output.destroy?.(); signal.addEventListener('abort', abort, { once: true });
            if (signal.aborted) abort();
            try {
                if (signal.aborted) fail('CLIENT_ABORTED');
                let start = 0, end = row.byte_size - 1;
                if (range) {
                    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
                    start = match[1] ? Number(match[1]) : Math.max(0, row.byte_size - Number(match[2]));
                    end = match[1] && match[2] ? Math.min(end, Number(match[2])) : end;
                }
                output.setHeader('Accept-Ranges', 'bytes');
                if (start >= row.byte_size) {
                    output.statusCode = 416; output.setHeader('Content-Range', `bytes */${row.byte_size}`); output.setHeader('Content-Length', '0'); output.end(); return;
                }
                output.statusCode = range ? 206 : 200; output.setHeader('Content-Type', row.mime);
                output.setHeader('Content-Length', String(end - start + 1));
                if (range) output.setHeader('Content-Range', `bytes ${start}-${end}/${row.byte_size}`);
                const chunk = Buffer.alloc(64 * 1024); let position = start;
                while (position <= end) {
                    if (signal.aborted) fail('CLIENT_ABORTED');
                    const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, end - position + 1), position);
                    if (!bytesRead) fail('AUDIO_ASSET_UNHEALTHY');
                    // A response retains this buffer until drain; always pause
                    // here so reusing the buffer cannot mutate queued bytes.
                    if (!output.write(Buffer.from(chunk.subarray(0, bytesRead)))) await once(output, 'drain', { signal });
                    position += bytesRead;
                }
                output.end();
            } finally { signal.removeEventListener('abort', abort); await handle.close(); }
        };
    }
    close() { this.db.close(); }
}
