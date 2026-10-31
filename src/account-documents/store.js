import path from 'node:path';
import { mkdir, chmod, lstat } from 'node:fs/promises';
import { DocumentFailure } from './validation.js';
import { outfitSettingsConsumer } from './outfit.js';

export { DocumentFailure } from './validation.js';
const fail = code => { throw new DocumentFailure(code); };

// Trusted composition only; no client-controlled registration or storage paths.
export function createAccountDocuments(config, { consumers = [outfitSettingsConsumer] } = {}) {
    const registered = new Map(consumers.map(consumer => [consumer.id, consumer]));
    let DatabaseSync, stopped = false;
    const consumerFor = (id, version) => {
        const consumer = registered.get(id);
        if (!consumer) fail('DOCUMENT_NOT_REGISTERED');
        if (version !== consumer.schemaVersion) fail('DOCUMENT_SCHEMA_INCOMPATIBLE');
        return consumer;
    };
    const validate = (consumer, payload) => {
        if (Buffer.byteLength(JSON.stringify(payload) || '') > consumer.maxBytes) fail('DOCUMENT_TOO_LARGE');
        return consumer.validate(payload);
    };
    async function use(context, work) {
        if (stopped || !DatabaseSync || !context?.userRoot) fail('DOCUMENT_STORE_UNAVAILABLE');
        const root = path.join(context.userRoot, 'tavern-toolbox-server', 'account-documents-v1');
        await mkdir(root, { recursive: true, mode: 0o700 });
        const directory = await lstat(root);
        if (!directory.isDirectory() || directory.isSymbolicLink()) fail('DOCUMENT_STORE_UNAVAILABLE');
        await chmod(root, 0o700);
        const file = path.join(root, 'documents.sqlite');
        try { const stat = await lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) fail('DOCUMENT_STORE_UNAVAILABLE'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (stopped) fail('DOCUMENT_STORE_UNAVAILABLE');
        const db = new DatabaseSync(file);
        try {
            await chmod(file, 0o600);
            if (stopped) fail('DOCUMENT_STORE_UNAVAILABLE');
            db.exec('PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
            const version = db.prepare('PRAGMA user_version').get().user_version;
            if (version !== 0 && version !== 1) fail('DOCUMENT_STORE_SCHEMA_INCOMPATIBLE');
            if (!version) {
                if (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n)
                    fail('DOCUMENT_STORE_SCHEMA_INCOMPATIBLE');
                db.exec('CREATE TABLE documents(id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL); PRAGMA user_version=1');
            }
            const result = work(db);
            db.exec('COMMIT');
            return result;
        } catch (error) { try { db.exec('ROLLBACK'); } catch {} throw error; }
        finally { db.close(); }
    }
    function snapshot(db, consumer) {
        const row = db.prepare('SELECT schema_version, revision, payload FROM documents WHERE id=?').get(consumer.id);
        if (!row) return { documentId: consumer.id, schemaVersion: consumer.schemaVersion, revision: 0, payload: null };
        if (row.schema_version !== consumer.schemaVersion) fail('DOCUMENT_SCHEMA_INCOMPATIBLE');
        if (!Number.isSafeInteger(row.revision) || row.revision < 1 || Buffer.byteLength(row.payload) > consumer.maxBytes)
            fail('DOCUMENT_DATA_INVALID');
        let payload;
        try { payload = validate(consumer, JSON.parse(row.payload)); }
        catch { fail('DOCUMENT_DATA_INVALID'); }
        return { documentId: consumer.id, schemaVersion: row.schema_version, revision: row.revision, payload };
    }
    return {
        consumers: registered,
        definition: { id: 'account-documents', version: '0.1.0', dependsOn: ['core'],
            capabilities: [{ id: 'account.documents', contract: { major: 1, minMinor: 0, maxMinor: 0 },
                operations: ['read', 'commit'].map(id => ({ id, available: true })),
                operationAvailability: () => ({ commit: { available: config.policy.core.allowedOrigins.length > 0,
                    reasonCode: 'ORIGIN_POLICY_MISSING' } }),
                constraints: { scope: 'st-user', updates: 'revision-cas', contextBound: true,
                    consumers: consumers.map(({ id, schemaVersion, maxBytes, limits }) => ({ id, schemaVersion, maxBytes, limits })) } }],
            initialize: async () => { ({ DatabaseSync } = await import('node:sqlite')); },
            health: async context => {
                try { await use(context, () => null); return { state: 'ready', reasonCode: null }; }
                catch { return { state: 'unavailable', reasonCode: 'DOCUMENT_STORE_UNAVAILABLE' }; }
            },
            shutdown: () => { stopped = true; },
        },
        read(context, id, version) {
            const consumer = consumerFor(id, version);
            return use(context, db => snapshot(db, consumer));
        },
        commit(context, id, body) {
            if (!body || Array.isArray(body) || Object.keys(body).sort().join(',') !== 'expectedRevision,payload,schemaVersion'
                || !Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) fail('INVALID_REQUEST');
            const consumer = consumerFor(id, body.schemaVersion);
            validate(consumer, body.payload);
            // Serialize before yielding: caller mutation can never bypass validation.
            const encoded = JSON.stringify(body.payload), expectedRevision = body.expectedRevision;
            return use(context, db => {
                const current = snapshot(db, consumer);
                if (current.revision !== expectedRevision) fail('REVISION_CONFLICT');
                if (current.revision >= Number.MAX_SAFE_INTEGER) fail('DOCUMENT_DATA_INVALID');
                db.prepare('INSERT INTO documents VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET schema_version=excluded.schema_version, revision=excluded.revision, payload=excluded.payload')
                    .run(id, consumer.schemaVersion, current.revision + 1, encoded);
                return snapshot(db, consumer);
            });
        },
    };
}
