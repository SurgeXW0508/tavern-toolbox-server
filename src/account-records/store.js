import { randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import { useDatabase } from './database.js';
import { fail, integer, exact, recordIdValid, registerConsumers } from './validation.js';
export { RecordFailure } from './validation.js';

export const MAX_PAGE_SIZE = 100;
const metadataColumns = 'record_id, schema_version, revision, deleted, created_at, updated_at';
const metadata = r => ({ recordId: r.record_id, schemaVersion: r.schema_version, revision: r.revision,
    deleted: Boolean(r.deleted), createdAt: r.created_at, updatedAt: r.updated_at });

export function createAccountRecords(config, { consumers = [] } = {}) {
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
        try { const validated = c.validate(JSON.parse(encoded));
            if (validated === false || validated?.then) fail('RECORD_INVALID'); }
        catch { fail('RECORD_INVALID'); }
        return encoded;
    };
    const snapshot = (db, c, id) => {
        const row = db.prepare('SELECT * FROM records WHERE consumer=? AND record_id=?').get(c.id, id);
        if (!row) return { consumerId: c.id, recordId: id, schemaVersion: c.schemaVersion, revision: 0,
            deleted: false, status: 'missing', createdAt: null, updatedAt: null, payload: null };
        if (row.schema_version !== c.schemaVersion) fail('RECORD_SCHEMA_INCOMPATIBLE');
        let payload = null;
        if (!row.deleted) {
            try { payload = JSON.parse(row.payload); encode(c, payload); }
            catch { fail('RECORD_DATA_INVALID'); }
        }
        return { consumerId: c.id, ...metadata(row), status: row.deleted ? 'deleted' : 'active', payload };
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
        const encoded = deletion ? null : encode(c, body.payload);
        return use(context, db => {
            const row = db.prepare('SELECT schema_version,revision,deleted,created_at,storage_bytes FROM records WHERE consumer=? AND record_id=?').get(c.id, id);
            if ((row?.revision || 0) !== expected) fail('REVISION_CONFLICT');
            if (row?.deleted) fail('RECORD_DELETED');
            if (row && row.schema_version !== c.schemaVersion) fail('RECORD_SCHEMA_INCOMPATIBLE');
            if (deletion && !row) fail('RECORD_NOT_FOUND');
            if (expected >= Number.MAX_SAFE_INTEGER) fail('RECORD_DATA_INVALID');
            const now = Math.max(Date.now(), row?.created_at || 0);
            if (deletion) {
                // Retain the charged bytes: deleting cannot free quota for churn.
                db.prepare('UPDATE records SET deleted=1,payload=NULL,revision=revision+1,updated_at=? WHERE consumer=? AND record_id=?').run(now, c.id, id);
            } else {
                const charge = 256 + Buffer.byteLength(id, 'utf8') + Buffer.byteLength(encoded, 'utf8');
                const usage = db.prepare('SELECT records,bytes FROM collections WHERE consumer=?').get(c.id) || { records: 0, bytes: 0 };
                const count = usage.records + (row ? 0 : 1), bytes = usage.bytes - (row?.storage_bytes || 0) + charge;
                if (!integer(count) || !integer(bytes)) fail('RECORD_DATA_INVALID');
                if (count > c.maxRecords || bytes > c.maxStorageBytes) fail('RECORD_COLLECTION_FULL');
                db.prepare(`INSERT INTO records(consumer,record_id,schema_version,revision,deleted,created_at,updated_at,payload,storage_bytes)
                    VALUES(?,?,?,?,0,?,?,?,?) ON CONFLICT(consumer,record_id) DO UPDATE SET
                    revision=excluded.revision,updated_at=excluded.updated_at,payload=excluded.payload,storage_bytes=excluded.storage_bytes`)
                    .run(c.id, id, c.schemaVersion, expected + 1, row?.created_at || now, now, encoded, charge);
                db.prepare('INSERT INTO collections VALUES(?,?,?) ON CONFLICT(consumer) DO UPDATE SET records=excluded.records,bytes=excluded.bytes').run(c.id, count, bytes);
            }
            return snapshot(db, c, id);
        }, true);
    }
    const advertised = [...registered.values()].map(({ validate, ...c }) => c);
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
        read(context, consumerId, id, version) { identity(id); const c = consumerFor(consumerId, version); return use(context, db => snapshot(db, c, id)); },
        commit: (context, consumerId, id, body) => mutate(context, consumerId, id, body, false),
        delete: (context, consumerId, id, body) => mutate(context, consumerId, id, body, true),
    };
}
