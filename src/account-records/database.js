import path from 'node:path';
import { mkdirSync, lstatSync, chmodSync, openSync, closeSync, constants } from 'node:fs';
import { fail, RecordFailure } from './validation.js';

const schema = `CREATE TABLE records(
    seq INTEGER PRIMARY KEY AUTOINCREMENT, consumer TEXT NOT NULL, record_id TEXT NOT NULL,
    schema_version INTEGER NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
    deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    payload TEXT, storage_bytes INTEGER NOT NULL CHECK(storage_bytes>0), UNIQUE(consumer,record_id));
    CREATE INDEX records_page ON records(consumer,seq);
    CREATE TABLE collections(consumer TEXT PRIMARY KEY, records INTEGER NOT NULL, bytes INTEGER NOT NULL);
    PRAGMA user_version=1;`;

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
        if (version() === 0) {
            db.exec('BEGIN IMMEDIATE');
            if (version() === 0) {
                if (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n)
                    fail('RECORD_STORE_SCHEMA_INCOMPATIBLE');
                db.exec(schema);
            } else if (version() !== 1) fail('RECORD_STORE_SCHEMA_INCOMPATIBLE');
            db.exec('COMMIT');
        }
        db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
        if (version() !== 1) fail('RECORD_STORE_SCHEMA_INCOMPATIBLE');
        const result = work(db);
        db.exec('COMMIT');
        return result;
    } catch (error) {
        try { db?.exec('ROLLBACK'); } catch {}
        if (error instanceof RecordFailure) throw error;
        fail([5, 6].includes(error?.errcode) ? 'RECORD_STORE_BUSY' : 'RECORD_STORE_UNAVAILABLE');
    } finally { db?.close(); }
}
