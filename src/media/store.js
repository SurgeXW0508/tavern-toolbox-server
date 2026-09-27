import { randomUUID, createHash } from 'node:crypto';
import { open, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { MediaFailure } from './validation.js';
import { validateImage } from './validation.js';

const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXT = Object.freeze({ jpeg: 'jpg', png: 'png', webp: 'webp', gif: 'gif' });

async function durableWrite(target, bytes) {
    const temporary = `${target}.${randomUUID()}.tmp`;
    let handle;
    try {
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close(); handle = null;
        await rename(temporary, target);
        const directory = await open(path.dirname(target), 'r');
        try { await directory.sync(); } finally { await directory.close(); }
    } finally {
        await handle?.close();
        await rm(temporary, { force: true }).catch(() => {});
    }
}

export class MediaStore {
    constructor(root, policy, DatabaseSync) {
        this.root = path.join(root, 'tavern-toolbox-server', 'media-v1');
        this.policy = policy;
        this.DatabaseSync = DatabaseSync;
        this.tail = Promise.resolve();
    }

    async initialize() {
        await mkdir(path.join(this.root, 'originals'), { recursive: true, mode: 0o700 });
        await mkdir(path.join(this.root, 'derived'), { recursive: true, mode: 0o700 });
        await mkdir(path.join(this.root, 'staging'), { recursive: true, mode: 0o700 });
        const db = new this.DatabaseSync(path.join(this.root, 'metadata.sqlite'));
        try {
            const version = db.prepare('PRAGMA user_version').get().user_version;
            if (version > 1) throw new MediaFailure('INCOMPATIBLE_SCHEMA');
            if (version === 0) {
                const tables = db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().count;
                if (tables) throw new MediaFailure('INCOMPATIBLE_SCHEMA');
                db.exec(`BEGIN IMMEDIATE;
                    CREATE TABLE assets (
                        id TEXT PRIMARY KEY,
                        digest TEXT NOT NULL UNIQUE,
                        mime TEXT NOT NULL,
                        original_size INTEGER NOT NULL,
                        width INTEGER NOT NULL,
                        height INTEGER NOT NULL,
                        frame_count INTEGER NOT NULL,
                        created_at TEXT NOT NULL,
                        derived_size INTEGER NOT NULL DEFAULT 0,
                        derived_state TEXT NOT NULL DEFAULT 'pending'
                    );
                    PRAGMA user_version = 1;
                    COMMIT;`);
            }
            this.db = db;
            await this.cleanupStaging();
        } catch (error) { db.close(); throw error; }
    }

    async cleanupStaging() {
        const directory = path.join(this.root, 'staging');
        for (const name of await readdir(directory)) {
            if (!/^[0-9a-f-]{36}\.tmp$/i.test(name)) continue;
            const target = path.join(directory, name);
            try { if (Date.now() - (await stat(target)).mtimeMs > 24 * 60 * 60 * 1000)
                await rm(target, { force: true }); } catch { /* next recovery attempt */ }
        }
    }

    async locked(action) {
        const predecessor = this.tail;
        let release;
        this.tail = new Promise(resolve => { release = resolve; });
        await predecessor;
        try { return await action(); } finally { release(); }
    }

    row(id) {
        if (!ASSET_ID.test(id || '')) throw new MediaFailure('MEDIA_NOT_FOUND');
        const row = this.db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
        if (!row) throw new MediaFailure('MEDIA_NOT_FOUND');
        return row;
    }

    info(row) {
        return { mediaRef: { provider: 'server', assetId: row.id },
            mime: row.mime, originalBytes: row.original_size, width: row.width, height: row.height,
            animated: row.frame_count > 1, frameCount: row.frame_count,
            createdAt: row.created_at, derivedState: row.derived_state };
    }

    usage() {
        const totals = this.db.prepare('SELECT COUNT(*) AS assets, COALESCE(SUM(original_size), 0) AS originals, COALESCE(SUM(derived_size), 0) AS derived FROM assets').get();
        return { assetCount: totals.assets, originalBytes: totals.originals, derivedBytes: totals.derived,
            totalBytes: totals.originals + totals.derived, quotaBytes: this.policy.quotaBytes,
            quotaState: totals.originals + totals.derived >= this.policy.quotaBytes ? 'full' : 'available' };
    }

    originalPath(row) { return path.join(this.root, 'originals', `${row.id}.${EXT[row.mime.split('/')[1]]}`); }
    derivedPath(row) { return path.join(this.root, 'derived', `${row.id}.webp`); }

    async import(bytes, validated) {
        return this.locked(async () => {
            const duplicate = this.db.prepare('SELECT * FROM assets WHERE digest = ?').get(validated.digest);
            if (duplicate) {
                await this.readOriginal(duplicate); // Do not return an already-corrupt identity.
                return this.info(duplicate);
            }
            if (this.usage().totalBytes + bytes.length > this.policy.quotaBytes)
                throw new MediaFailure('QUOTA_EXCEEDED');
            const id = randomUUID();
            const row = { id, mime: validated.mime };
            const original = this.originalPath(row);
            const stage = path.join(this.root, 'staging', `${id}.tmp`);
            const derived = this.derivedPath(row);
            let originalCommitted = false;
            try {
                await durableWrite(stage, bytes);
                await rename(stage, original);
                const directory = await open(path.dirname(original), 'r');
                try { await directory.sync(); } finally { await directory.close(); }
                let derivedSize = 0, derivedState = 'unavailable';
                if (validated.thumbnail && this.usage().totalBytes + bytes.length + validated.thumbnail.length <= this.policy.quotaBytes) {
                    derivedState = 'failed';
                    try {
                        await durableWrite(derived, validated.thumbnail);
                        derivedSize = validated.thumbnail.length;
                        derivedState = 'ready';
                    } catch { await rm(derived, { force: true }).catch(() => {}); }
                }
                this.db.prepare(`INSERT INTO assets
                    (id, digest, mime, original_size, width, height, frame_count, created_at, derived_size, derived_state)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`) 
                    .run(id, validated.digest, validated.mime, bytes.length, validated.width,
                        validated.height, validated.frames, new Date().toISOString(), derivedSize, derivedState);
                originalCommitted = true;
            } finally {
                await rm(stage, { force: true }).catch(() => {});
                if (!originalCommitted) {
                    await rm(original, { force: true }).catch(() => {});
                    await rm(derived, { force: true }).catch(() => {});
                }
            }
            return this.info(this.row(id));
        });
    }

    async readOriginal(row) {
        let bytes;
        try { bytes = await readFile(this.originalPath(row)); }
        catch { throw new MediaFailure('MEDIA_CORRUPT'); }
        if (bytes.length !== row.original_size || createHash('sha256').update(bytes).digest('hex') !== row.digest)
            throw new MediaFailure('MEDIA_CORRUPT');
        return bytes;
    }

    async read(id, derived = false) {
        return this.locked(async () => {
            const row = this.row(id);
            if (!derived) return { bytes: await this.readOriginal(row), mime: row.mime, digest: row.digest };
            if (row.derived_state !== 'ready') throw new MediaFailure('DERIVED_UNAVAILABLE');
            try { return { bytes: await readFile(this.derivedPath(row)), mime: 'image/webp' }; }
            catch { throw new MediaFailure('DERIVED_UNAVAILABLE'); }
        });
    }

    async metadata(id) { return this.locked(async () => this.info(this.row(id))); }

    async delete(id) {
        return this.locked(async () => {
            const row = this.row(id);
            this.db.prepare('DELETE FROM assets WHERE id = ?').run(id);
            await rm(this.originalPath(row), { force: true }).catch(() => {});
            await rm(this.derivedPath(row), { force: true }).catch(() => {});
            return { deleted: true };
        });
    }

    async rebuild(id, sharp) {
        return this.locked(async () => {
            const row = this.row(id);
            const original = await this.readOriginal(row);
            const validated = await validateImage(original, row.mime, this.policy, sharp);
            if (!validated.thumbnail) throw new MediaFailure('DERIVED_UNAVAILABLE');
            if (this.usage().totalBytes - row.derived_size + validated.thumbnail.length > this.policy.quotaBytes)
                throw new MediaFailure('QUOTA_EXCEEDED');
            await durableWrite(this.derivedPath(row), validated.thumbnail);
            this.db.prepare("UPDATE assets SET derived_size = ?, derived_state = 'ready' WHERE id = ?")
                .run(validated.thumbnail.length, id);
            return this.info(this.row(id));
        });
    }

    async cleanupTechnicalGarbage() {
        return this.locked(async () => {
            let removed = 0;
            for (const directory of ['originals', 'derived']) {
                for (const name of await readdir(path.join(this.root, directory))) {
                    const match = /^([0-9a-f-]{36})\.(jpg|png|webp|gif)$/i.exec(name);
                    if (!match || !ASSET_ID.test(match[1])) continue;
                    const exists = this.db.prepare('SELECT id FROM assets WHERE id = ?').get(match[1]);
                    if (exists) continue;
                    await rm(path.join(this.root, directory, name), { force: true });
                    removed++;
                }
            }
            await this.cleanupStaging();
            return { removedPhysicalFiles: removed };
        });
    }

    close() { this.db?.close(); }
}
