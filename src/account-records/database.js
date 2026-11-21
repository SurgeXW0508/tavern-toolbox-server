import path from 'node:path';
import { mkdirSync, lstatSync, chmodSync, openSync, closeSync, constants } from 'node:fs';
import { fail, RecordFailure } from './validation.js';

const schema = `CREATE TABLE records(
    seq INTEGER PRIMARY KEY AUTOINCREMENT, consumer TEXT NOT NULL, record_id TEXT NOT NULL,
    schema_version INTEGER NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
    deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    payload TEXT, storage_bytes INTEGER NOT NULL CHECK(storage_bytes>0), UNIQUE(consumer,record_id));
    CREATE INDEX records_page ON records(consumer,seq);
    CREATE INDEX records_tombstone_age ON records(consumer,deleted,updated_at);
    CREATE TABLE collections(
        consumer TEXT PRIMARY KEY,
        records INTEGER NOT NULL CHECK(records>=0),
        tombstones INTEGER NOT NULL DEFAULT 0 CHECK(tombstones>=0),
        bytes INTEGER NOT NULL CHECK(bytes>=0));
    PRAGMA user_version=2;`;

const migrateV1ToV2 = `ALTER TABLE collections ADD COLUMN tombstones INTEGER NOT NULL DEFAULT 0 CHECK(tombstones>=0);
    UPDATE records SET storage_bytes = 256 + length(record_id) WHERE deleted=1;
    DELETE FROM collections;
    INSERT INTO collections(consumer, records, tombstones, bytes)
        SELECT consumer,
               coalesce(sum(CASE WHEN deleted=0 THEN 1 ELSE 0 END), 0),
               coalesce(sum(CASE WHEN deleted=1 THEN 1 ELSE 0 END), 0),
               coalesce(sum(storage_bytes), 0)
        FROM records GROUP BY consumer;
    CREATE INDEX IF NOT EXISTS records_tombstone_age ON records(consumer,deleted,updated_at);
    PRAGMA user_version=2;`;

function statOrNull(file) {
    try { return lstatSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; return null; }
}
function privateFile(file) {
    const s = statOrNull(file);
    if (s && (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1)) fail('RECORD_STORE_UNAVAILABLE');
}
function location(userRoot) {
    if (typeof userRoot !== 'string' || !path.isAbsolute(userRoot)) fail('RECORD_STORE_UNAVAILABLE');
    const root = path.join(userRoot, 'tavern-toolbox-server', 'account-records-v1');
    // Check every ancestor, including the plugin parent, before creating children.
    let current = path.parse(root).root;
    for (const segment of root.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, segment);
        if (!statOrNull(current)) {
            try { mkdirSync(current, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        }
        const s = lstatSync(current);
        if (!s.isDirectory() || s.isSymbolicLink()) fail('RECORD_STORE_UNAVAILABLE');
    }
    chmodSync(root, 0o700);
    const file = path.join(root, 'records.sqlite');
    for (const suffix of ['', '-journal', '-wal', '-shm']) privateFile(file + suffix);
    if (!statOrNull(file)) {
        try { closeSync(openSync(file, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)); }
        catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    privateFile(file); chmodSync(file, 0o600);
    return file;
}

// One connection per request, no userRoot cache. All work is synchronous while
// holding the SQLite transaction; no await can leave a writer lock in flight.
export function useDatabase(DatabaseSync, context, work, write) {
    let db;
    try {
        db = new DatabaseSync(location(context?.userRoot));
        db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL');
        const version = () => db.prepare('PRAGMA user_version').get().user_version;
        const currentVersion = version();
        if (currentVersion === 0 || currentVersion === 1) {
            db.exec('BEGIN IMMEDIATE');
            const v = version();
            if (v === 0) {
                if (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n)
                    fail('RECORD_STORE_SCHEMA_INCOMPATIBLE');
                db.exec(schema);
            } else if (v === 1) {
                db.exec(migrateV1ToV2);
            } else if (v !== 2) {
                fail('RECORD_STORE_SCHEMA_INCOMPATIBLE');
            }
            db.exec('COMMIT');
        }
        db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
        if (version() !== 2) fail('RECORD_STORE_SCHEMA_INCOMPATIBLE');
        const result = work(db);
        db.exec('COMMIT');
        return result;
    } catch (error) {
        try { db?.exec('ROLLBACK'); } catch {}
        if (error instanceof RecordFailure) throw error;
        fail([5, 6].includes(error?.errcode) ? 'RECORD_STORE_BUSY' : 'RECORD_STORE_UNAVAILABLE');
    } finally { db?.close(); }
}
