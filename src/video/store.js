import path from 'node:path';
import { mkdir, lstat, chmod } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fail, uuid, integer, text } from './validation.js';
import { VIDEO_LIMITS } from './policy.js';

export class VideoStore {
    constructor(root, DatabaseSync) { this.root = path.join(root, 'tavern-toolbox-server', 'video-v1'); this.DatabaseSync = DatabaseSync; }
    async initialize() {
        for (const folder of [path.dirname(this.root), this.root]) {
            await mkdir(folder, { recursive: true, mode: 0o700 });
            const info = await lstat(folder); if (!info.isDirectory() || info.isSymbolicLink()) fail('VIDEO_STORE_UNAVAILABLE');
            await chmod(folder, 0o700);
        }
        const file = path.join(this.root, 'metadata.sqlite');
        try { if ((await lstat(file)).isSymbolicLink()) fail('VIDEO_STORE_UNAVAILABLE'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const db = new this.DatabaseSync(file);
        try {
            await chmod(file, 0o600); db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL;');
            const version = db.prepare('PRAGMA user_version').get().user_version;
            if (version > 1) fail('VIDEO_SCHEMA_INCOMPATIBLE');
            if (version === 0) {
                if (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n) fail('VIDEO_STORE_UNAVAILABLE');
                db.exec(`BEGIN IMMEDIATE;
                    CREATE TABLE videos(id TEXT PRIMARY KEY, title TEXT NOT NULL, root_key TEXT NOT NULL, locator TEXT NOT NULL,
                        fingerprint TEXT NOT NULL, mime TEXT NOT NULL, byte_size INTEGER NOT NULL,
                        source_revision INTEGER NOT NULL, metadata_revision INTEGER NOT NULL, created_at INTEGER NOT NULL,
                        UNIQUE(root_key,locator));
                    CREATE INDEX video_created ON videos(created_at DESC,id DESC);
                    CREATE TABLE receipts(operation_id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, video_id TEXT NOT NULL, created_at INTEGER NOT NULL);
                    PRAGMA user_version=1; COMMIT;`);
            }
            db.prepare('SELECT id,title,root_key,locator,fingerprint,mime,byte_size,source_revision,metadata_revision,created_at FROM videos LIMIT 0').all();
            db.prepare('SELECT operation_id,request_hash,video_id,created_at FROM receipts LIMIT 0').all();
            this.db = db;
        } catch (error) { db.close(); throw error; }
    }
    row(id) { uuid(id); const row = this.db.prepare('SELECT * FROM videos WHERE id=?').get(id); if (!row) fail('VIDEO_NOT_FOUND'); return row; }
    view(row) {
        if (!['video/mp4', 'video/webm'].includes(row.mime) || !Number.isSafeInteger(row.byte_size) || row.byte_size < 1
            || !Number.isSafeInteger(row.source_revision) || row.source_revision < 1 || !Number.isSafeInteger(row.metadata_revision) || row.metadata_revision < 1) fail('VIDEO_STORE_UNAVAILABLE');
        return { kind: 'video', mediaRef: { provider: 'server', assetId: row.id }, title: row.title, mime: row.mime,
            byteSize: row.byte_size, sourceRevision: row.source_revision, metadataRevision: row.metadata_revision, createdAt: row.created_at };
    }
    list({ search = '', offset = 0, limit = 24 } = {}, rootKeys) {
        if (typeof search !== 'string' || search.length > 120) fail('INVALID_REQUEST');
        integer(offset, 0, 5000); integer(limit, 1, 48);
        const args = [JSON.stringify(rootKeys), search];
        const where = "root_key IN (SELECT value FROM json_each(?)) AND instr(lower(title),lower(?))>0";
        const total = this.db.prepare(`SELECT COUNT(*) AS n FROM videos WHERE ${where}`).get(...args).n;
        const items = this.db.prepare(`SELECT * FROM videos WHERE ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset).map(row => this.view(row));
        return { items, total, offset, limit, hasMore: offset + items.length < total };
    }
    requestHash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
    receipt(operationId, requestHash, now = Date.now()) {
        const receipt = this.db.prepare('SELECT * FROM receipts WHERE operation_id=?').get(uuid(operationId));
        if (!receipt || receipt.created_at <= now - 86400000) return null;
        if (receipt.request_hash !== requestHash) fail('VIDEO_OPERATION_CONFLICT');
        return { ...this.view(this.row(receipt.video_id)), reused: true };
    }
    register({ operationId, requestHash, title, rootKey, relative, file }, now) {
        const replay = this.receipt(operationId, requestHash, now); if (replay) return replay;
        this.db.exec('BEGIN IMMEDIATE');
        try {
            this.db.prepare('DELETE FROM receipts WHERE created_at<=?').run(now - 86400000);
            if (this.db.prepare('SELECT COUNT(*) AS n FROM receipts').get().n >= 10000) fail('RESOURCE_BUSY');
            let row = this.db.prepare('SELECT * FROM videos WHERE root_key=? AND locator=?').get(rootKey, relative);
            const reused = Boolean(row);
            if (row && row.fingerprint !== file.fingerprint) fail('VIDEO_SOURCE_CHANGED');
            if (!row) {
                if (this.db.prepare('SELECT COUNT(*) AS n FROM videos').get().n >= VIDEO_LIMITS.maxVideos) fail('VIDEO_CATALOG_FULL');
                const id = randomUUID();
                this.db.prepare('INSERT INTO videos VALUES(?,?,?,?,?,?,?,1,1,?)').run(id, text(title), rootKey, relative, file.fingerprint, file.mime, file.byteSize, now);
                row = this.row(id);
            }
            this.db.prepare('INSERT INTO receipts VALUES(?,?,?,?)').run(operationId, requestHash, row.id, now);
            this.db.exec('COMMIT'); return { ...this.view(row), reused };
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    close() { this.db.close(); }
}
