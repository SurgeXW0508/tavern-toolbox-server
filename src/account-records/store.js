import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { useDatabase } from './database.js';
import { RecordFailure, fail, integer, exact, recordIdValid, registerConsumers } from './validation.js';
export { RecordFailure };

export const MAX_PAGE_SIZE = 100;
const MIGRATION_NEEDED = Symbol('MIGRATION_NEEDED');
const metadataColumns = 'record_id, schema_version, revision, deleted, created_at, updated_at';
const metadata = r => ({ recordId: r.record_id, schemaVersion: r.schema_version, revision: r.revision,
    deleted: Boolean(r.deleted), createdAt: r.created_at, updatedAt: r.updated_at });

function migrationChain(consumer, fromVersion) {
    if (!Number.isSafeInteger(fromVersion) || fromVersion >= consumer.schemaVersion
        || !Array.isArray(consumer.migrations) || !consumer.migrations.length) {
        return null;
    }
    const steps = [];
    let current = fromVersion;
    while (current < consumer.schemaVersion) {
        const step = consumer.migrations.find(
            entry => entry
                && entry.fromVersion === current
                && Number.isSafeInteger(entry.toVersion)
                && entry.toVersion > current
                && entry.toVersion <= consumer.schemaVersion
                && typeof entry.validateSource === 'function'
                && typeof entry.convert === 'function',
        );
        if (!step) return null;
        steps.push(step);
        current = step.toVersion;
    }
    return steps;
}

export function createAccountRecords(config, { consumers = [], now = () => Date.now() } = {}) {
    const registered = registerConsumers(consumers), cursorSecret = randomBytes(32);
    let DatabaseSync, stopped = false;
    const consumerFor = (id, version) => {
        const c = registered.get(id);
        if (!c) fail('RECORD_CONSUMER_NOT_REGISTERED');
        if (version !== undefined && version !== c.schemaVersion) fail('RECORD_SCHEMA_INCOMPATIBLE');
        return c;
    };
    const use = async (context, work, write = false) => {
        if (stopped || !DatabaseSync) fail('RECORD_STORE_UNAVAILABLE');
        return useDatabase(DatabaseSync, context, work, write);
    };
    const identity = id => { if (!recordIdValid(id)) fail('RECORD_ID_INVALID'); };
    const encode = (c, payload) => {
        let encoded;
        try { encoded = JSON.stringify(payload); } catch { fail('RECORD_INVALID'); }
        if (typeof encoded !== 'string') fail('RECORD_INVALID');
        if (Buffer.byteLength(encoded, 'utf8') > c.maxBytes) fail('RECORD_TOO_LARGE');
        let parsed;
        try {
            parsed = JSON.parse(encoded);
            const validated = c.validate(parsed);
            if (validated === false || validated?.then) fail('RECORD_INVALID');
        } catch { fail('RECORD_INVALID'); }
        return { encoded, parsed };
    };
    const snapshot = (db, c, id, readTimestamp = now()) => {
        const row = db.prepare('SELECT * FROM records WHERE consumer=? AND record_id=?').get(c.id, id);
        if (!row) return { consumerId: c.id, recordId: id, schemaVersion: c.schemaVersion, revision: 0,
            deleted: false, status: 'missing', createdAt: null, updatedAt: null, payload: null };
        if (row.schema_version !== c.schemaVersion) fail('RECORD_SCHEMA_INCOMPATIBLE');
        let payload = null;
        if (!row.deleted) {
            try {
                payload = JSON.parse(row.payload);
                if (typeof c.projectRead === 'function') {
                    payload = c.projectRead(payload, { now: readTimestamp, recordId: id });
                }
                encode(c, payload);
            }
            catch { fail('RECORD_DATA_INVALID'); }
        }
        return { consumerId: c.id, ...metadata(row), status: row.deleted ? 'deleted' : 'active', payload };
    };
    const validateMigratableRow = (c, row, chain) => {
        if (!integer(row.revision, 1) || row.revision >= Number.MAX_SAFE_INTEGER) fail('RECORD_DATA_INVALID');
        if (row.deleted) {
            if (row.payload !== null) fail('RECORD_DATA_INVALID');
            return { deleted: true, encoded: null };
        }
        if (typeof row.payload !== 'string' || Buffer.byteLength(row.payload, 'utf8') > c.maxBytes) {
            fail('RECORD_DATA_INVALID');
        }
        let payload;
        try {
            payload = JSON.parse(row.payload);
            for (const step of chain) {
                const ok = step.validateSource(payload);
                if (ok === false || ok?.then) throw Error();
                payload = step.convert(payload);
            }
        } catch {
            fail('RECORD_DATA_INVALID');
        }
        let encoded;
        try { encoded = JSON.stringify(payload); } catch { fail('RECORD_DATA_INVALID'); }
        if (typeof encoded !== 'string') fail('RECORD_DATA_INVALID');
        if (Buffer.byteLength(encoded, 'utf8') > c.maxBytes) fail('RECORD_TOO_LARGE');
        try {
            const parsed = JSON.parse(encoded);
            const validated = c.validate(parsed);
            if (validated === false || validated?.then) throw Error();
        } catch {
            fail('RECORD_DATA_INVALID');
        }
        return { deleted: false, encoded };
    };
    const migrateRecordRow = (db, c, id, readTimestamp = now()) => {
        const row = db.prepare('SELECT * FROM records WHERE consumer=? AND record_id=?').get(c.id, id);
        if (!row) {
            return {
                snapshot: {
                    consumerId: c.id, recordId: id, schemaVersion: c.schemaVersion, revision: 0,
                    deleted: false, status: 'missing', createdAt: null, updatedAt: null, payload: null,
                },
                migrated: false,
            };
        }
        if (row.schema_version === c.schemaVersion) {
            return { snapshot: snapshot(db, c, id, readTimestamp), migrated: false };
        }
        const chain = migrationChain(c, row.schema_version);
        if (!chain) fail('RECORD_SCHEMA_INCOMPATIBLE');
        const prepared = validateMigratableRow(c, row, chain);
        const nextRevision = row.revision + 1;
        if (prepared.deleted) {
            db.prepare('UPDATE records SET schema_version=?, revision=? WHERE consumer=? AND record_id=?')
                .run(c.schemaVersion, nextRevision, c.id, id);
            return { snapshot: snapshot(db, c, id, readTimestamp), migrated: true };
        }
        if (!integer(row.storage_bytes, 1)) fail('RECORD_DATA_INVALID');
        const newCharge = 256 + Buffer.byteLength(id, 'utf8') + Buffer.byteLength(prepared.encoded, 'utf8');
        const usage = db.prepare('SELECT records,tombstones,bytes FROM collections WHERE consumer=?').get(c.id)
            || { records: 1, tombstones: 0, bytes: row.storage_bytes };
        const nextBytes = usage.bytes - row.storage_bytes + newCharge;
        if (!integer(usage.records) || !integer(usage.tombstones) || !integer(nextBytes)) fail('RECORD_DATA_INVALID');
        if (nextBytes > c.maxStorageBytes) fail('RECORD_COLLECTION_FULL');
        db.prepare('UPDATE records SET schema_version=?, revision=?, payload=?, storage_bytes=? WHERE consumer=? AND record_id=?')
            .run(c.schemaVersion, nextRevision, prepared.encoded, newCharge, c.id, id);
        db.prepare('INSERT INTO collections(consumer,records,tombstones,bytes) VALUES(?,?,?,?) ON CONFLICT(consumer) DO UPDATE SET records=excluded.records,tombstones=excluded.tombstones,bytes=excluded.bytes')
            .run(c.id, usage.records, usage.tombstones, nextBytes);
        return { snapshot: snapshot(db, c, id, readTimestamp), migrated: true };
    };
    const sign = body => createHmac('sha256', cursorSecret).update(body).digest('base64url');
    const cursor = value => { const body = Buffer.from(JSON.stringify(value)).toString('base64url'); return body + '.' + sign(body); };
    const parseCursor = (value, context, consumer) => {
        try {
            if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)) throw Error();
            const [body, mac] = value.split('.');
            if (!timingSafeEqual(Buffer.from(mac), Buffer.from(sign(body)))) throw Error();
            const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
            if (!exact(p, ['v', 'context', 'consumer', 'after', 'high']) || p.v !== 1
                || p.context !== context.contextId || p.consumer !== consumer || !integer(p.after)
                || !integer(p.high) || p.after > p.high) throw Error();
            return p;
        } catch { fail('RECORD_CURSOR_INVALID'); }
    };
    function mutate(context, consumerId, id, body, deletion) {
        identity(id);
        if (!exact(body, deletion ? ['schemaVersion', 'expectedRevision'] : ['schemaVersion', 'expectedRevision', 'payload'])
            || !integer(body.expectedRevision)) fail('INVALID_REQUEST');
        const c = consumerFor(consumerId, body.schemaVersion), expected = body.expectedRevision;
        let prepared = deletion ? null : encode(c, body.payload);
        return use(context, db => {
            if (deletion && !c.deletable) fail('RECORD_DELETE_FORBIDDEN');
            const row = db.prepare('SELECT schema_version,revision,deleted,created_at,updated_at,storage_bytes,payload FROM records WHERE consumer=? AND record_id=?')
                .get(c.id, id);
            if (row && row.schema_version !== c.schemaVersion) {
                const chain = migrationChain(c, row.schema_version);
                if (chain) {
                    validateMigratableRow(c, row, chain);
                    fail('REVISION_CONFLICT');
                }
            }
            if ((row?.revision || 0) !== expected) fail('REVISION_CONFLICT');
            if (row?.deleted) fail('RECORD_DELETED');
            if (row && row.schema_version !== c.schemaVersion) fail('RECORD_SCHEMA_INCOMPATIBLE');
            if (deletion && !row) fail('RECORD_NOT_FOUND');
            if (expected >= Number.MAX_SAFE_INTEGER) fail('RECORD_DATA_INVALID');
            const timestamp = Math.max(now(), row?.created_at || 0);
            const buildMeta = () => ({
                now: timestamp,
                recordId: id,
                throwFailures: true,
                readRecord: (targetId, targetConsumerId = c.id) => {
                    const r = db.prepare('SELECT deleted,payload FROM records WHERE consumer=? AND record_id=?').get(targetConsumerId, targetId);
                    if (!r || r.deleted) return null;
                    try { return JSON.parse(r.payload); } catch { return null; }
                },
            });
            if (!deletion && c.transition) {
                let previous = null;
                if (row) {
                    try { previous = JSON.parse(row.payload); }
                    catch { fail('RECORD_DATA_INVALID'); }
                }
                const meta = buildMeta();
                let allowed;
                try { allowed = c.transition(previous, prepared.parsed, meta); }
                catch (err) {
                    if (err instanceof RecordFailure) throw err;
                    fail('RECORD_TRANSITION_INVALID');
                }
                if (allowed === false || allowed?.then) fail('RECORD_TRANSITION_INVALID');
                prepared = encode(c, prepared.parsed);
            } else if (deletion && c.beforeDelete) {
                let previous = null;
                try { previous = JSON.parse(row.payload); }
                catch { fail('RECORD_DATA_INVALID'); }
                const meta = buildMeta();
                let allowed;
                try { allowed = c.beforeDelete(previous, meta); }
                catch (err) {
                    if (err instanceof RecordFailure) throw err;
                    fail('RECORD_DELETE_FORBIDDEN');
                }
                if (allowed === false || allowed?.then) fail('RECORD_DELETE_FORBIDDEN');
            }
            const usage = db.prepare('SELECT records,tombstones,bytes FROM collections WHERE consumer=?').get(c.id)
                || { records: 0, tombstones: 0, bytes: 0 };
            if (deletion) {
                const tombstoneCharge = 256 + Buffer.byteLength(id, 'utf8');
                const count = usage.records - 1;
                let tombstones = usage.tombstones + 1;
                let bytes = usage.bytes - row.storage_bytes + tombstoneCharge;
                db.prepare('UPDATE records SET deleted=1,payload=NULL,revision=revision+1,updated_at=?,storage_bytes=? WHERE consumer=? AND record_id=?')
                    .run(timestamp, tombstoneCharge, c.id, id);
                if (tombstones > c.maxTombstones) {
                    const needed = tombstones - c.maxTombstones;
                    const cutoff = timestamp - c.tombstoneRetentionMs;
                    const expired = db.prepare(
                        'SELECT seq,storage_bytes FROM records WHERE consumer=? AND deleted=1 AND record_id<>? AND updated_at<=? ORDER BY updated_at ASC,seq ASC LIMIT ?'
                    ).all(c.id, id, cutoff, needed);
                    if (expired.length < needed) fail('RECORD_COLLECTION_FULL');
                    const removeExpired = db.prepare('DELETE FROM records WHERE seq=?');
                    for (const old of expired) {
                        removeExpired.run(old.seq);
                        tombstones -= 1;
                        bytes -= old.storage_bytes;
                    }
                }
                if (!integer(count) || !integer(tombstones) || !integer(bytes) || bytes > c.maxStorageBytes) fail('RECORD_DATA_INVALID');
                db.prepare('INSERT INTO collections(consumer,records,tombstones,bytes) VALUES(?,?,?,?) ON CONFLICT(consumer) DO UPDATE SET records=excluded.records,tombstones=excluded.tombstones,bytes=excluded.bytes')
                    .run(c.id, count, tombstones, bytes);
            } else {
                const encoded = prepared.encoded;
                const charge = 256 + Buffer.byteLength(id, 'utf8') + Buffer.byteLength(encoded, 'utf8');
                const count = usage.records + (row ? 0 : 1);
                const tombstones = usage.tombstones;
                const bytes = usage.bytes - (row?.storage_bytes || 0) + charge;
                if (!integer(count) || !integer(tombstones) || !integer(bytes)) fail('RECORD_DATA_INVALID');
                if (count > c.maxRecords || bytes > c.maxStorageBytes) fail('RECORD_COLLECTION_FULL');
                db.prepare(`INSERT INTO records(consumer,record_id,schema_version,revision,deleted,created_at,updated_at,payload,storage_bytes)
                    VALUES(?,?,?,?,0,?,?,?,?) ON CONFLICT(consumer,record_id) DO UPDATE SET
                    revision=excluded.revision,updated_at=excluded.updated_at,payload=excluded.payload,storage_bytes=excluded.storage_bytes`)
                    .run(c.id, id, c.schemaVersion, expected + 1, row?.created_at || timestamp, timestamp, encoded, charge);
                db.prepare('INSERT INTO collections(consumer,records,tombstones,bytes) VALUES(?,?,?,?) ON CONFLICT(consumer) DO UPDATE SET records=excluded.records,tombstones=excluded.tombstones,bytes=excluded.bytes')
                    .run(c.id, count, tombstones, bytes);
            }
            return snapshot(db, c, id, timestamp);
        }, true);
    }
    const advertised = [...registered.values()].map(({ validate, transition, beforeDelete, projectRead, migrations, tombstoneRetentionMs, ...c }) => c);
    return {
        consumer: id => consumerFor(id),
        definition: { id: 'account-records', version: '0.1.0', dependsOn: ['core'],
            capabilities: [{ id: 'account.records', contract: { major: 1, minMinor: 0, maxMinor: 0 },
                operations: ['list', 'read', 'commit', 'delete'].map(id => ({ id, available: true })),
                operationAvailability: () => Object.fromEntries(['commit', 'delete'].map(id => [id, {
                    available: config.policy.core.allowedOrigins.length > 0, reasonCode: 'ORIGIN_POLICY_MISSING' }])),
                constraints: { scope: 'st-user', updates: 'record-revision-cas', contextBound: true,
                    maxPageSize: MAX_PAGE_SIZE, defaultPageSize: 50, consumers: advertised } }],
            initialize: async () => { ({ DatabaseSync } = await import('node:sqlite')); },
            health: async context => {
                try { if (registered.size) await use(context, () => null); else if (stopped || !DatabaseSync) fail('RECORD_STORE_UNAVAILABLE');
                    return { state: 'ready', reasonCode: null }; }
                catch { return { state: 'unavailable', reasonCode: 'RECORD_STORE_UNAVAILABLE' }; }
            },
            shutdown: () => { stopped = true; },
        },
        list(context, consumerId, { limit = 50, cursor: continuation = null } = {}) {
            const c = consumerFor(consumerId);
            if (!integer(limit, 1) || limit > MAX_PAGE_SIZE || !context?.contextId) fail('INVALID_REQUEST');
            const p = continuation === null ? null : parseCursor(continuation, context, c.id);
            return use(context, db => {
                const high = p?.high ?? db.prepare('SELECT coalesce(max(seq),0) AS high FROM records WHERE consumer=?').get(c.id).high;
                if (!integer(high)) fail('RECORD_DATA_INVALID');
                const rows = db.prepare(`SELECT seq,${metadataColumns} FROM records WHERE consumer=? AND seq>? AND seq<=? ORDER BY seq LIMIT ?`)
                    .all(c.id, p?.after || 0, high, limit + 1);
                const page = rows.slice(0, limit);
                return { consumerId: c.id, records: page.map(metadata), nextCursor: rows.length > limit
                    ? cursor({ v: 1, context: context.contextId, consumer: c.id, after: page.at(-1).seq, high }) : null };
            });
        },
        read(context, consumerId, id, version) {
            identity(id);
            const c = consumerFor(consumerId, version);
            return use(context, db => {
                const row = db.prepare('SELECT schema_version FROM records WHERE consumer=? AND record_id=?').get(c.id, id);
                if (!row || row.schema_version === c.schemaVersion) return snapshot(db, c, id);
                if (!migrationChain(c, row.schema_version)) fail('RECORD_SCHEMA_INCOMPATIBLE');
                return MIGRATION_NEEDED;
            }).then(result => result === MIGRATION_NEEDED
                ? use(context, db => migrateRecordRow(db, c, id).snapshot, true)
                : result);
        },
        commit: (context, consumerId, id, body) => mutate(context, consumerId, id, body, false),
        delete: (context, consumerId, id, body) => mutate(context, consumerId, id, body, true),
    };
}
