import path from 'node:path';
import { mkdir } from 'node:fs/promises';

export const BUSINESS_STORAGE_VERSION = 1;
export const MAX_BUSINESS_BYTES = 2 * 1024 * 1024;
const NAMESPACE = /^[a-z][a-z0-9.-]{0,63}$/;

export class BusinessFailure extends Error {
    constructor(code) { super(code); this.code = code; }
}

// The collection store deliberately knows nothing about Outfit or portable packages.
// Each consumer owns validation of its opaque document and schema version.
export class BusinessStore {
    constructor(userRoot, DatabaseSync) {
        this.root = path.join(userRoot, 'tavern-toolbox-server', 'business-v1');
        this.DatabaseSync = DatabaseSync;
    }

    async initialize() {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const db = new this.DatabaseSync(path.join(this.root, 'collections.sqlite'));
        try {
            db.exec('PRAGMA busy_timeout = 3000; PRAGMA synchronous = FULL;');
            const version = db.prepare('PRAGMA user_version').get().user_version;
            if (version > BUSINESS_STORAGE_VERSION) throw new BusinessFailure('BUSINESS_STORAGE_INCOMPATIBLE');
            if (version === 0) {
                const tables = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n;
                if (tables) throw new BusinessFailure('BUSINESS_STORAGE_INCOMPATIBLE');
                db.exec(`BEGIN IMMEDIATE;
                    CREATE TABLE collections (
                        namespace TEXT PRIMARY KEY,
                        schema_version INTEGER NOT NULL,
                        revision INTEGER NOT NULL,
                        document TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    );
                    PRAGMA user_version = 1;
                    COMMIT;`);
            }
            this.db = db;
        } catch (error) { db.close(); throw error; }
    }

    read(namespace, emptyDocument, schemaVersion) {
        if (!NAMESPACE.test(namespace)) throw new BusinessFailure('INVALID_REQUEST');
        const row = this.db.prepare('SELECT * FROM collections WHERE namespace = ?').get(namespace);
        if (!row) return { namespace, schemaVersion, revision: 0, document: emptyDocument, updatedAt: null };
        if (row.schema_version !== schemaVersion) throw new BusinessFailure('BUSINESS_SCHEMA_INCOMPATIBLE');
        if (Buffer.byteLength(row.document) > MAX_BUSINESS_BYTES) throw new BusinessFailure('BUSINESS_DATA_INVALID');
        let document;
        try { document = JSON.parse(row.document); }
        catch { throw new BusinessFailure('BUSINESS_DATA_INVALID'); }
        return { namespace, schemaVersion, revision: row.revision, document, updatedAt: row.updated_at };
    }

    commit(namespace, schemaVersion, expectedRevision, document, validate) {
        if (!NAMESPACE.test(namespace) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
            throw new BusinessFailure('INVALID_REQUEST');
        const json = JSON.stringify(document);
        if (typeof json !== 'string' || Buffer.byteLength(json) > MAX_BUSINESS_BYTES)
            throw new BusinessFailure('BUSINESS_TOO_LARGE');
        let begun = false;
        try {
            this.db.exec('BEGIN IMMEDIATE'); begun = true;
            const row = this.db.prepare('SELECT * FROM collections WHERE namespace = ?').get(namespace);
            if (row && row.schema_version !== schemaVersion) throw new BusinessFailure('BUSINESS_SCHEMA_INCOMPATIBLE');
            const actualRevision = row?.revision ?? 0;
            if (actualRevision !== expectedRevision) throw new BusinessFailure('BUSINESS_CONFLICT');
            let previous = null;
            if (row) {
                try { previous = JSON.parse(row.document); }
                catch { throw new BusinessFailure('BUSINESS_DATA_INVALID'); }
            }
            validate?.(document, previous);
            const updatedAt = new Date().toISOString();
            const revision = actualRevision + 1;
            this.db.prepare(`INSERT INTO collections (namespace, schema_version, revision, document, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(namespace) DO UPDATE SET revision=excluded.revision,
                document=excluded.document, updated_at=excluded.updated_at`)
                .run(namespace, schemaVersion, revision, json, updatedAt);
            this.db.exec('COMMIT'); begun = false;
            return { namespace, schemaVersion, revision, document, updatedAt };
        } catch (error) {
            if (begun) this.db.exec('ROLLBACK');
            throw error;
        }
    }

    close() { this.db?.close(); }
}
