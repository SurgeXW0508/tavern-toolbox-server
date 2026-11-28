import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, symlink, mkdir, copyFile, chmod, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAccountRecords } from '../src/account-records/store.js';

const config = { policy: { core: { allowedOrigins: ['https://example.test'] } } };
const consumer = (id = 'test-records', overrides = {}) => ({ id, schemaVersion: 1, maxBytes: 80, maxRecords: 4, maxStorageBytes: 1400,
    validate(p) { if (!p || Object.keys(p).join(',') !== 'text' || typeof p.text !== 'string') throw Error('invalid'); }, ...overrides });
async function fixture(t, consumers = [consumer(), consumer('other-records')]) {
    const root = await mkdtemp(path.join(tmpdir(), 'ttb-records-')); t.after(() => rm(root, { recursive: true, force: true }));
    const store = createAccountRecords(config, { consumers }); await store.definition.initialize(); t.after(() => store.definition.shutdown());
    const alice = { userRoot: path.join(root, 'alice'), contextId: 'alice-context' }, bob = { userRoot: path.join(root, 'bob'), contextId: 'bob-context' };
    return { root, store, alice, bob, file: path.join(alice.userRoot, 'tavern-toolbox-server/account-records-v1/records.sqlite') };
}
const body = (expectedRevision = 0, text = 'example') => ({ schemaVersion: 1, expectedRevision, payload: { text } });
const commit = (s, u, id, revision = 0, text) => s.commit(u, 'test-records', id, body(revision, text));
const remove = (s, u, id, revision) => s.delete(u, 'test-records', id, { schemaVersion: 1, expectedRevision: revision });

test('Consumer registration rejects non-string IDs without coercion', () => {
    for (const id of [undefined, null, 1, true, {}, ['test-records'], new String('test-records'), Symbol('test-records'),
        { toString() { throw Error('must not coerce a Consumer ID'); } }]) {
        assert.throws(() => createAccountRecords(config, { consumers: [{ ...consumer(), id }] }), /Invalid record consumer/);
    }
    for (const id of ['test-records', 'null', 'undefined'])
        assert.equal(createAccountRecords(config, { consumers: [consumer(id)] }).consumer(id).id, id);
});

test('record operations harden their own directory and DB without changing existing shared parent or sibling permissions', async t => {
    const { store: s, alice, file } = await fixture(t);
    const shared = path.dirname(path.dirname(file)), sibling = path.join(shared, 'account-documents-v1');
    await mkdir(sibling, { recursive: true }); await chmod(sibling, 0o750);
    await writeFile(path.join(sibling, 'sentinel'), 'existing sibling data', { mode: 0o640 });
    await chmod(shared, 0o750); await commit(s, alice, 'a');
    assert.equal((await stat(shared)).mode & 0o777, 0o750);
    let revision = 1;
    for (const sharedMode of [0o750, 0o755]) {
        await chmod(shared, sharedMode); await chmod(path.dirname(file), 0o755); await chmod(file, 0o644);
        assert.equal((await s.read(alice, 'test-records', 'a', 1)).revision, revision);
        await commit(s, alice, 'a', revision++);
        assert.equal((await stat(shared)).mode & 0o777, sharedMode);
        assert.equal((await stat(sibling)).mode & 0o777, 0o750);
        assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
        assert.equal((await stat(file)).mode & 0o777, 0o600);
        assert.equal((await stat(path.join(sibling, 'sentinel'))).mode & 0o777, 0o640);
        assert.equal(await readFile(path.join(sibling, 'sentinel'), 'utf8'), 'existing sibling data');
    }
});

test('trusted registration, strict schema/identity/UTF-8 payload and isolated consumers/users', async t => {
    const { store: s, alice, bob, file } = await fixture(t);
    assert.throws(() => createAccountRecords(config, { consumers: [consumer(), consumer()] }), /Invalid record consumer/);
    const production = createAccountRecords(config); assert.deepEqual(production.definition.capabilities[0].constraints.consumers, []);
    assert.throws(() => s.read(alice, 'unknown', 'a', 1), { code: 'RECORD_CONSUMER_NOT_REGISTERED' });
    for (const id of ['../secret', 'a/b', 'a\\b', '', '.hidden', 'a'.repeat(129)]) assert.throws(() => commit(s, alice, id), { code: 'RECORD_ID_INVALID' });
    assert.throws(() => s.commit(alice, 'test-records', 'a', { ...body(), schemaVersion: 2 }), { code: 'RECORD_SCHEMA_INCOMPATIBLE' });
    assert.throws(() => s.commit(alice, 'test-records', 'a', { ...body(), extra: 1 }), { code: 'INVALID_REQUEST' });
    assert.throws(() => s.commit(alice, 'test-records', 'a', { ...body(), payload: { extra: true } }), { code: 'RECORD_INVALID' });
    assert.throws(() => commit(s, alice, 'a', 0, '中'.repeat(24)), { code: 'RECORD_TOO_LARGE' });
    assert.equal(Buffer.byteLength(JSON.stringify({ text: '中'.repeat(23) })), 80);
    const created = await commit(s, alice, 'a', 0, '中'.repeat(23)); assert.equal(created.revision, 1);
    assert.equal((await s.read(bob, 'test-records', 'a', 1)).status, 'missing');
    assert.equal((await s.read(alice, 'other-records', 'a', 1)).status, 'missing');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
    assert.deepEqual((await s.read(alice, 'test-records', 'a', 1)).payload, created.payload);
});

test('independent stores contend with per-record CAS; tombstones cannot be reused or deleted twice', async t => {
    const { store: s, alice } = await fixture(t);
    const other = createAccountRecords(config, { consumers: [consumer()] }); await other.definition.initialize(); t.after(() => other.definition.shutdown());
    const creations = await Promise.allSettled([commit(s, alice, 'a'), commit(other, alice, 'a')]);
    assert.equal(creations.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(creations.find(r => r.status === 'rejected').reason.code, 'REVISION_CONFLICT');
    await commit(s, alice, 'b'); await commit(s, alice, 'a', 1);
    assert.equal((await s.read(alice, 'test-records', 'b', 1)).revision, 1);
    const deletions = await Promise.allSettled([remove(s, alice, 'a', 2), remove(other, alice, 'a', 2)]);
    assert.equal(deletions.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(deletions.find(r => r.status === 'rejected').reason.code, 'REVISION_CONFLICT');
    const tomb = await other.read(alice, 'test-records', 'a', 1);
    assert.equal(tomb.status, 'deleted'); assert.equal(tomb.revision, 3); assert.equal(tomb.payload, null);
    for (const revision of [0, 1, 2]) await assert.rejects(commit(s, alice, 'a', revision), { code: 'REVISION_CONFLICT' });
    await assert.rejects(commit(s, alice, 'a', 3), { code: 'RECORD_DELETED' });
    await assert.rejects(remove(s, alice, 'a', 3), { code: 'RECORD_DELETED' });
    await assert.rejects(remove(s, alice, 'missing', 0), { code: 'RECORD_NOT_FOUND' });
});

test('deleting releases payload bytes and active record slot while charging fixed tombstone bytes', async t => {
    const { store: s, alice, file } = await fixture(t, [consumer('test-records', { maxRecords: 2, maxStorageBytes: 850 })]);
    await commit(s, alice, 'a', 0, 'x'.repeat(50)); // charge: 256 + 1 + 61 = 318
    await commit(s, alice, 'b', 0, 'y'.repeat(50)); // charge: 318, total: 636
    await assert.rejects(commit(s, alice, 'c', 0, 'z'), { code: 'RECORD_COLLECTION_FULL' }, 'active record count cap');
    const db1 = new DatabaseSync(file);
    assert.deepEqual({ ...db1.prepare('SELECT * FROM collections').get() }, {
        consumer: 'test-records',
        records: 2,
        tombstones: 0,
        bytes: 636,
    });
    db1.close();

    // Deleting 'a' frees its payload bytes (61) and active record slot, retaining fixed tombstone charge (256 + 1 = 257).
    await remove(s, alice, 'a', 1);
    const db2 = new DatabaseSync(file);
    assert.deepEqual({ ...db2.prepare('SELECT * FROM collections').get() }, {
        consumer: 'test-records',
        records: 1,
        tombstones: 1,
        bytes: 318 + 257, // 575
    });
    db2.close();

    // A new record that exceeds remaining byte quota (575 + 280 = 855 > 850) is rejected without altering counters.
    await assert.rejects(commit(s, alice, 'c', 0, 'z'.repeat(12)), { code: 'RECORD_COLLECTION_FULL' });
    const db3 = new DatabaseSync(file);
    assert.deepEqual({ ...db3.prepare('SELECT * FROM collections').get() }, {
        consumer: 'test-records',
        records: 1,
        tombstones: 1,
        bytes: 575,
    });
    db3.close();

    // A new record that fits in the freed quota succeeds (575 + 269 = 844 <= 850), while 'a' remains a tombstone.
    await commit(s, alice, 'c', 0, 'z');
    assert.equal((await s.read(alice, 'test-records', 'a', 1)).status, 'deleted');
    assert.equal((await s.read(alice, 'test-records', 'c', 1)).revision, 1);
});

test('keyset high-water paging includes tombstones/latest metadata and excludes concurrent inserts', async t => {
    const { store: s, alice, bob, file } = await fixture(t);
    for (const id of ['a', 'b', 'c']) await commit(s, alice, id);
    const first = await s.list(alice, 'test-records', { limit: 1 }); assert.equal(first.records[0].recordId, 'a');
    assert(!Object.hasOwn(first.records[0], 'payload'));
    await commit(s, alice, 'd'); await commit(s, alice, 'b', 1); await remove(s, alice, 'c', 1);
    assert.throws(() => s.list(bob, 'test-records', { cursor: first.nextCursor }), { code: 'RECORD_CURSOR_INVALID' });
    assert.throws(() => s.list(alice, 'other-records', { cursor: first.nextCursor }), { code: 'RECORD_CURSOR_INVALID' });
    assert.throws(() => s.list(alice, 'test-records', { cursor: first.nextCursor + 'x' }), { code: 'RECORD_CURSOR_INVALID' });
    for (const limit of [0, 101, 1.5]) assert.throws(() => s.list(alice, 'test-records', { limit }), { code: 'INVALID_REQUEST' });
    const second = await s.list(alice, 'test-records', { limit: 1, cursor: first.nextCursor });
    assert.equal(second.records[0].recordId, 'b'); assert.equal(second.records[0].revision, 2);
    const third = await s.list(alice, 'test-records', { limit: 1, cursor: second.nextCursor });
    assert.equal(third.records[0].recordId, 'c'); assert.equal(third.records[0].deleted, true); assert.equal(third.nextCursor, null);
    const db = new DatabaseSync(file); db.exec("UPDATE records SET schema_version=2,payload='not-json' WHERE record_id='b'"); db.close();
    assert.equal((await s.list(alice, 'test-records')).records.length, 4, 'list never parses payloads and permits mixed schema metadata');
    await assert.rejects(s.read(alice, 'test-records', 'b', 1), { code: 'RECORD_SCHEMA_INCOMPATIBLE' });
    assert.equal((await s.list(alice, 'test-records')).records[1].schemaVersion, 2);
});

test('SQLite busy and injected transaction failure preserve CAS, counters and request connection cleanup', async t => {
    const { store: s, alice, file } = await fixture(t); await commit(s, alice, 'a');
    const db = new DatabaseSync(file); t.after(() => db.close());
    db.exec('BEGIN IMMEDIATE');
    await assert.rejects(commit(s, alice, 'a', 1), { code: 'RECORD_STORE_BUSY' }); db.exec('ROLLBACK');
    const before = db.prepare('SELECT * FROM collections').get();
    db.exec("CREATE TRIGGER abort_record AFTER INSERT ON records BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    await assert.rejects(commit(s, alice, 'b'), { code: 'RECORD_STORE_UNAVAILABLE' });
    assert.deepEqual(db.prepare('SELECT * FROM collections').get(), before);
    assert.equal((await s.read(alice, 'test-records', 'b', 1)).status, 'missing');
    db.exec('DROP TRIGGER abort_record'); await commit(s, alice, 'b');
    const quota = db.prepare('SELECT * FROM collections').get();
    db.exec("CREATE TRIGGER abort_quota BEFORE UPDATE ON collections BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    await assert.rejects(commit(s, alice, 'a', 1, 'larger'), { code: 'RECORD_STORE_UNAVAILABLE' });
    assert.equal((await s.read(alice, 'test-records', 'a', 1)).revision, 1);
    assert.deepEqual(db.prepare('SELECT * FROM collections').get(), quota);
    db.exec('DROP TRIGGER abort_quota');
    db.exec("CREATE TRIGGER abort_delete AFTER UPDATE ON records BEGIN SELECT RAISE(ABORT,'synthetic'); END");
    await assert.rejects(remove(s, alice, 'a', 1), { code: 'RECORD_STORE_UNAVAILABLE' });
    assert.equal((await s.read(alice, 'test-records', 'a', 1)).status, 'active');
    db.exec('DROP TRIGGER abort_delete'); await remove(s, alice, 'a', 1);
});

test('restart/stopped restore and symlink protection preserve independent durable storage', async t => {
    const { store: s, alice, root, file } = await fixture(t); await commit(s, alice, 'a');
    s.definition.shutdown(); await copyFile(file, path.join(root, 'backup.sqlite'));
    const next = createAccountRecords(config, { consumers: [consumer()] }); await next.definition.initialize(); t.after(() => next.definition.shutdown());
    await commit(next, alice, 'a', 1); next.definition.shutdown(); await copyFile(path.join(root, 'backup.sqlite'), file);
    const restored = createAccountRecords(config, { consumers: [consumer()] }); await restored.definition.initialize(); t.after(() => restored.definition.shutdown());
    assert.equal((await restored.read(alice, 'test-records', 'a', 1)).revision, 1);
    const linkedUser = { userRoot: path.join(root, 'linked'), contextId: 'linked' };
    await mkdir(linkedUser.userRoot); await symlink(alice.userRoot + '/tavern-toolbox-server', path.join(linkedUser.userRoot, 'tavern-toolbox-server'));
    await assert.rejects(restored.read(linkedUser, 'test-records', 'a', 1), { code: 'RECORD_STORE_UNAVAILABLE' });
    await symlink(path.join(root, 'unrelated'), file + '-journal');
    await assert.rejects(restored.read(alice, 'test-records', 'a', 1), { code: 'RECORD_STORE_UNAVAILABLE' });
    await rm(file + '-journal');
    const saved = file + '.saved'; await copyFile(file, saved); await rm(file); await symlink(saved, file);
    await assert.rejects(restored.read(alice, 'test-records', 'a', 1), { code: 'RECORD_STORE_UNAVAILABLE' });
});

test('non-deletable consumers, maxTombstones cap, expired tombstone pruning and rollback on churn', async t => {
    const retention = 7 * 24 * 60 * 60 * 1000;
    let clock = 1_700_000_000_000;
    assert.throws(() => createAccountRecords(config, { consumers: [consumer('bad', { deletable: false, maxTombstones: 1 })] }), /Invalid record consumer/);
    assert.throws(() => createAccountRecords(config, { consumers: [consumer('bad', { tombstoneRetentionMs: 1000 })] }), /Invalid record consumer/);

    const root = await mkdtemp(path.join(tmpdir(), 'ttb-records-tomb-')); t.after(() => rm(root, { recursive: true, force: true }));
    const store = createAccountRecords(config, {
        now: () => clock,
        consumers: [
            consumer('test-records', { maxRecords: 4, maxTombstones: 2, tombstoneRetentionMs: retention, maxStorageBytes: 4000 }),
            consumer('locked-records', { deletable: false }),
        ],
    });
    await store.definition.initialize(); t.after(() => store.definition.shutdown());
    const alice = { userRoot: path.join(root, 'alice'), contextId: 'alice-context' };
    const file = path.join(alice.userRoot, 'tavern-toolbox-server/account-records-v1/records.sqlite');

    await store.commit(alice, 'locked-records', 'singleton', body(0, 'keep'));
    await assert.rejects(
        store.delete(alice, 'locked-records', 'singleton', { schemaVersion: 1, expectedRevision: 1 }),
        { code: 'RECORD_DELETE_FORBIDDEN' },
    );

    await commit(store, alice, 'r1', 0, 'one');
    await remove(store, alice, 'r1', 1);
    clock += 1000;
    await commit(store, alice, 'r2', 0, 'two');
    await remove(store, alice, 'r2', 1);
    clock += 1000;
    await commit(store, alice, 'r3', 0, 'three');

    // Tombstones are at cap (2) and neither r1 nor r2 has reached 7-day retention -> delete fails and rolls back.
    await assert.rejects(remove(store, alice, 'r3', 1), { code: 'RECORD_COLLECTION_FULL' });
    assert.equal((await store.read(alice, 'test-records', 'r3', 1)).status, 'active');
    const db1 = new DatabaseSync(file);
    assert.deepEqual({ ...db1.prepare('SELECT records,tombstones FROM collections WHERE consumer=?').get('test-records') }, {
        records: 1,
        tombstones: 2,
    });
    db1.close();

    // Advance clock past retention for r1 -> deleting r3 prunes r1 in the same transaction.
    clock = 1_700_000_000_000 + retention + 1;
    const deletedR3 = await remove(store, alice, 'r3', 1);
    assert.equal(deletedR3.status, 'deleted');
    const db2 = new DatabaseSync(file);
    assert.deepEqual({ ...db2.prepare('SELECT records,tombstones FROM collections WHERE consumer=?').get('test-records') }, {
        records: 0,
        tombstones: 2,
    });
    assert.deepEqual(
        db2.prepare('SELECT record_id FROM records WHERE consumer=? ORDER BY seq').all('test-records').map(r => r.record_id),
        ['r2', 'r3'],
    );
    db2.close();
});

test('schema v1 to v2 migration recounts collections, recharges tombstones and rolls back on failure', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'ttb-records-v1-')); t.after(() => rm(root, { recursive: true, force: true }));
    const alice = { userRoot: path.join(root, 'alice'), contextId: 'alice-context' };
    const dir = path.join(alice.userRoot, 'tavern-toolbox-server/account-records-v1');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, 'records.sqlite');

    const v1 = new DatabaseSync(file);
    v1.exec(`CREATE TABLE records(
        seq INTEGER PRIMARY KEY AUTOINCREMENT, consumer TEXT NOT NULL, record_id TEXT NOT NULL,
        schema_version INTEGER NOT NULL, revision INTEGER NOT NULL CHECK(revision>0),
        deleted INTEGER NOT NULL CHECK(deleted IN (0,1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        payload TEXT, storage_bytes INTEGER NOT NULL CHECK(storage_bytes>0), UNIQUE(consumer,record_id));
        CREATE INDEX records_page ON records(consumer,seq);
        CREATE TABLE collections(consumer TEXT PRIMARY KEY, records INTEGER NOT NULL, bytes INTEGER NOT NULL);
        PRAGMA user_version=1;`);
    // Active row 'act' (charge 256 + 3 + 16 = 275) + deleted row 'old-del' still holding old 900 bytes + drifted collections row.
    v1.prepare('INSERT INTO records(consumer,record_id,schema_version,revision,deleted,created_at,updated_at,payload,storage_bytes) VALUES(?,?,?,?,?,?,?,?,?)')
        .run('test-records', 'act', 1, 1, 0, 10, 10, '{"text":"hello"}', 275);
    v1.prepare('INSERT INTO records(consumer,record_id,schema_version,revision,deleted,created_at,updated_at,payload,storage_bytes) VALUES(?,?,?,?,?,?,?,?,?)')
        .run('test-records', 'old-del', 1, 2, 1, 10, 20, null, 900);
    v1.prepare('INSERT INTO collections VALUES(?,?,?)').run('test-records', 99, 99999);
    // Inject a trigger that aborts when updating deleted records during migration.
    v1.exec("CREATE TRIGGER fail_v2 BEFORE UPDATE ON records BEGIN SELECT RAISE(ABORT,'migration-fail'); END");
    v1.close();
    await chmod(file, 0o600);

    const store = createAccountRecords(config, { consumers: [consumer('test-records', { maxRecords: 4, maxStorageBytes: 2000 })] });
    await store.definition.initialize(); t.after(() => store.definition.shutdown());

    await assert.rejects(store.read(alice, 'test-records', 'act', 1), { code: 'RECORD_STORE_UNAVAILABLE' });
    const afterFail = new DatabaseSync(file);
    assert.equal(afterFail.prepare('PRAGMA user_version').get().user_version, 1);
    afterFail.exec('DROP TRIGGER fail_v2');
    afterFail.close();

    const active = await store.read(alice, 'test-records', 'act', 1);
    assert.equal(active.status, 'active');
    assert.deepEqual(active.payload, { text: 'hello' });
    const migrated = new DatabaseSync(file);
    assert.equal(migrated.prepare('PRAGMA user_version').get().user_version, 2);
    assert.deepEqual({ ...migrated.prepare('SELECT * FROM collections WHERE consumer=?').get('test-records') }, {
        consumer: 'test-records',
        records: 1,
        tombstones: 1,
        bytes: 275 + (256 + 'old-del'.length),
    });
    migrated.close();
});

test('consumer transition hook validates state transitions against previous payload inside transaction', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'ttb-records-trans-')); t.after(() => rm(root, { recursive: true, force: true }));
    const stateful = consumer('state-records', {
        transition(prev, next) {
            if (!prev) return next.text === 'init';
            if (prev.text === 'init') return ['running', 'aborted'].includes(next.text);
            if (prev.text === 'running') return next.text === 'done';
            return false;
        },
    });
    const store = createAccountRecords(config, { consumers: [stateful] });
    await store.definition.initialize(); t.after(() => store.definition.shutdown());
    const alice = { userRoot: path.join(root, 'alice'), contextId: 'alice-context' };

    await assert.rejects(store.commit(alice, 'state-records', 's1', body(0, 'running')), { code: 'RECORD_TRANSITION_INVALID' });
    assert.equal((await store.read(alice, 'state-records', 's1', 1)).status, 'missing');

    await store.commit(alice, 'state-records', 's1', body(0, 'init'));
    await assert.rejects(store.commit(alice, 'state-records', 's1', body(1, 'done')), { code: 'RECORD_TRANSITION_INVALID' });
    await store.commit(alice, 'state-records', 's1', body(1, 'running'));
    await store.commit(alice, 'state-records', 's1', body(2, 'done'));
    await assert.rejects(store.commit(alice, 'state-records', 's1', body(3, 'init')), { code: 'RECORD_TRANSITION_INVALID' });
    assert.equal((await store.read(alice, 'state-records', 's1', 1)).revision, 3);
});

test('[S3-R2-Server-1] record consumer migrations upgrade on demand with quota delta, single revision bump, tombstone upgrade, blind-write conflict and old-client gate', async t => {
    const v1Validate = p => {
        if (!p || Object.keys(p).join(',') !== 'text' || typeof p.text !== 'string') throw Error('bad v1');
    };
    const v2Validate = p => {
        if (!p || Object.keys(p).sort().join(',') !== 'mode,text' || typeof p.text !== 'string' || !['a', 'b'].includes(p.mode)) throw Error('bad v2');
    };
    const v3Validate = p => {
        if (!p || Object.keys(p).sort().join(',') !== 'mode,tag,text' || typeof p.text !== 'string' || !['a', 'b'].includes(p.mode) || p.tag !== 'v3') throw Error('bad v3');
    };

    const v1Consumer = (overrides = {}) => consumer('mig-records', {
        schemaVersion: 1,
        maxBytes: 120,
        maxRecords: 4,
        maxStorageBytes: 1600,
        validate: v1Validate,
        ...overrides,
    });
    const v2Consumer = (overrides = {}) => consumer('mig-records', {
        schemaVersion: 2,
        maxBytes: 120,
        maxRecords: 4,
        maxStorageBytes: 1600,
        validate: v2Validate,
        migrations: [{
            fromVersion: 1,
            toVersion: 2,
            validateSource: v1Validate,
            convert: p => ({ ...p, mode: 'a' }),
        }],
        ...overrides,
    });
    const v3Consumer = (overrides = {}) => consumer('mig-records', {
        schemaVersion: 3,
        maxBytes: 160,
        maxRecords: 4,
        maxStorageBytes: 1600,
        validate: v3Validate,
        migrations: [
            { fromVersion: 1, toVersion: 2, validateSource: v1Validate, convert: p => ({ ...p, mode: 'a' }) },
            { fromVersion: 2, toVersion: 3, validateSource: v2Validate, convert: p => ({ ...p, tag: 'v3' }) },
        ],
        ...overrides,
    });

    // Registration rejects malformed migration definitions and strips migrations from advertised capabilities
    for (const badMigrations of [
        'nope',
        [{}],
        [{ fromVersion: 0, toVersion: 2, validateSource: v1Validate, convert: p => p }],
        [{ fromVersion: 2, toVersion: 2, validateSource: v1Validate, convert: p => p }],
        [{ fromVersion: 1, toVersion: 3, validateSource: v1Validate, convert: p => p }],
        [{ fromVersion: 1, toVersion: 2, validateSource: 'not-fn', convert: p => p }],
        [{ fromVersion: 1, toVersion: 2, validateSource: v1Validate, convert: null }],
        [{ fromVersion: 1, toVersion: 2, validateSource: v1Validate, convert: p => p, extra: 1 }],
        [
            { fromVersion: 1, toVersion: 2, validateSource: v1Validate, convert: p => p },
            { fromVersion: 1, toVersion: 2, validateSource: v1Validate, convert: p => p },
        ],
    ]) {
        assert.throws(() => createAccountRecords(config, { consumers: [v2Consumer({ migrations: badMigrations })] }), /Invalid record consumer/);
    }

    const root = await mkdtemp(path.join(tmpdir(), 'ttb-records-mig-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const alice = { userRoot: path.join(root, 'alice'), contextId: 'alice-context' };
    const bob = { userRoot: path.join(root, 'bob'), contextId: 'bob-context' };
    const file = path.join(alice.userRoot, 'tavern-toolbox-server/account-records-v1/records.sqlite');

    let clock = 1_700_000_000_000;
    const s1 = createAccountRecords(config, { consumers: [v1Consumer()], now: () => clock });
    await s1.definition.initialize(); t.after(() => s1.definition.shutdown());

    // Seed v1 active records ('a', 'b') and a v1 deleted tombstone ('gone')
    const createdA = await s1.commit(alice, 'mig-records', 'a', { schemaVersion: 1, expectedRevision: 0, payload: { text: 'alpha' } });
    assert.equal(createdA.revision, 1);
    clock += 5000;
    await s1.commit(alice, 'mig-records', 'b', { schemaVersion: 1, expectedRevision: 0, payload: { text: 'beta' } });
    clock += 5000;
    await s1.commit(alice, 'mig-records', 'gone', { schemaVersion: 1, expectedRevision: 0, payload: { text: 'bye' } });
    clock += 5000;
    const tombV1 = await s1.delete(alice, 'mig-records', 'gone', { schemaVersion: 1, expectedRevision: 1 });
    assert.equal(tombV1.status, 'deleted');
    assert.equal(tombV1.revision, 2);

    const dbBefore = new DatabaseSync(file);
    const usageBefore = { ...dbBefore.prepare('SELECT records,tombstones,bytes FROM collections WHERE consumer=?').get('mig-records') };
    const rowABefore = { ...dbBefore.prepare('SELECT schema_version,revision,created_at,updated_at,storage_bytes FROM records WHERE consumer=? AND record_id=?').get('mig-records', 'a') };
    dbBefore.close();

    // Create two v2 stores to test advertised stripping, old-client gate, blind write, and concurrent reads
    let convertCount = 0;
    const countedV2 = () => v2Consumer({
        migrations: [{
            fromVersion: 1,
            toVersion: 2,
            validateSource: v1Validate,
            convert: p => { convertCount += 1; return { ...p, mode: 'a' }; },
        }],
    });
    const s2a = createAccountRecords(config, { consumers: [countedV2()], now: () => clock + 99999 });
    const s2b = createAccountRecords(config, { consumers: [countedV2()], now: () => clock + 99999 });
    await s2a.definition.initialize(); t.after(() => s2a.definition.shutdown());
    await s2b.definition.initialize(); t.after(() => s2b.definition.shutdown());

    const advertised = s2a.definition.capabilities[0].constraints.consumers.find(c => c.id === 'mig-records');
    assert.equal(advertised.schemaVersion, 2);
    assert.equal('migrations' in advertised, false, 'advertised consumer descriptor must strip internal migrations');

    // Old client (schemaVersion: 1) fails closed immediately on read and commit
    assert.throws(() => s2a.read(alice, 'mig-records', 'a', 1), { code: 'RECORD_SCHEMA_INCOMPATIBLE' });
    assert.throws(() => s2a.commit(alice, 'mig-records', 'a', { schemaVersion: 1, expectedRevision: 1, payload: { text: 'old' } }), { code: 'RECORD_SCHEMA_INCOMPATIBLE' });

    // Unmigrated blind commit/delete from v2 client fails with REVISION_CONFLICT without mutating v1 row
    await assert.rejects(s2a.commit(alice, 'mig-records', 'a', { schemaVersion: 2, expectedRevision: 1, payload: { text: 'blind', mode: 'b' } }), { code: 'REVISION_CONFLICT' });
    await assert.rejects(s2a.commit(alice, 'mig-records', 'a', { schemaVersion: 2, expectedRevision: 2, payload: { text: 'blind', mode: 'b' } }), { code: 'REVISION_CONFLICT' });
    await assert.rejects(s2a.delete(alice, 'mig-records', 'a', { schemaVersion: 2, expectedRevision: 1 }), { code: 'REVISION_CONFLICT' });
    const dbAfterBlind = new DatabaseSync(file);
    assert.equal(dbAfterBlind.prepare('SELECT schema_version FROM records WHERE consumer=? AND record_id=?').get('mig-records', 'a').schema_version, 1);
    assert.equal(dbAfterBlind.prepare('SELECT revision FROM records WHERE consumer=? AND record_id=?').get('mig-records', 'a').revision, 1);
    dbAfterBlind.close();

    // Concurrent reads upgrade v1 -> v2 once with single revision bump, exact collections.bytes delta, and preserved timestamps
    convertCount = 0;
    const [r1, r2] = await Promise.all([
        s2a.read(alice, 'mig-records', 'a', 2),
        s2b.read(alice, 'mig-records', 'a', 2),
    ]);
    assert.equal(convertCount, 1);
    assert.equal(r1.schemaVersion, 2);
    assert.equal(r2.schemaVersion, 2);
    assert.equal(r1.revision, 2);
    assert.equal(r2.revision, 2);
    assert.deepEqual(r1.payload, { text: 'alpha', mode: 'a' });
    assert.deepEqual(r2.payload, { text: 'alpha', mode: 'a' });
    assert.equal(r1.createdAt, rowABefore.created_at);
    assert.equal(r1.updatedAt, rowABefore.updated_at);

    const expectedNewCharge = 256 + Buffer.byteLength('a', 'utf8') + Buffer.byteLength(JSON.stringify({ text: 'alpha', mode: 'a' }), 'utf8');
    const dbAfterMig = new DatabaseSync(file);
    const usageAfterMig = { ...dbAfterMig.prepare('SELECT records,tombstones,bytes FROM collections WHERE consumer=?').get('mig-records') };
    const rowAAfter = { ...dbAfterMig.prepare('SELECT schema_version,revision,storage_bytes FROM records WHERE consumer=? AND record_id=?').get('mig-records', 'a') };
    dbAfterMig.close();
    assert.equal(rowAAfter.schema_version, 2);
    assert.equal(rowAAfter.revision, 2);
    assert.equal(rowAAfter.storage_bytes, expectedNewCharge);
    assert.deepEqual(usageAfterMig, {
        records: usageBefore.records,
        tombstones: usageBefore.tombstones,
        bytes: usageBefore.bytes - rowABefore.storage_bytes + expectedNewCharge,
    });

    // Subsequent v2 commit at revision 2 succeeds; downgraded v1 store fails closed on v2 row
    const committedA = await s2a.commit(alice, 'mig-records', 'a', { schemaVersion: 2, expectedRevision: 2, payload: { text: 'alpha', mode: 'b' } });
    assert.equal(committedA.revision, 3);
    await assert.rejects(s1.read(alice, 'mig-records', 'a', 1), { code: 'RECORD_SCHEMA_INCOMPATIBLE' });

    // v1 deleted tombstone upgrades to v2 tombstone with revision + 1 and unchanged collections counters/bytes
    const dbBeforeTomb = new DatabaseSync(file);
    const usageBeforeTomb = { ...dbBeforeTomb.prepare('SELECT records,tombstones,bytes FROM collections WHERE consumer=?').get('mig-records') };
    dbBeforeTomb.close();
    const tombV2 = await s2a.read(alice, 'mig-records', 'gone', 2);
    assert.equal(tombV2.schemaVersion, 2);
    assert.equal(tombV2.revision, 3);
    assert.equal(tombV2.status, 'deleted');
    assert.equal(tombV2.deleted, true);
    assert.equal(tombV2.payload, null);
    const dbAfterTomb = new DatabaseSync(file);
    const usageAfterTomb = { ...dbAfterTomb.prepare('SELECT records,tombstones,bytes FROM collections WHERE consumer=?').get('mig-records') };
    const tombRowAfter = { ...dbAfterTomb.prepare('SELECT schema_version,revision,payload FROM records WHERE consumer=? AND record_id=?').get('mig-records', 'gone') };
    dbAfterTomb.close();
    assert.deepEqual(usageAfterTomb, usageBeforeTomb);
    assert.equal(tombRowAfter.schema_version, 2);
    assert.equal(tombRowAfter.revision, 3);
    assert.equal(tombRowAfter.payload, null);

    // Quota exhaustion during migration fails with RECORD_COLLECTION_FULL and rolls back SQLite cleanly
    const dbForTight = new DatabaseSync(file);
    const tightLimit = dbForTight.prepare('SELECT bytes FROM collections WHERE consumer=?').get('mig-records').bytes + 2;
    dbForTight.close();
    const tightQuotaV2 = createAccountRecords(config, { consumers: [v2Consumer({ maxStorageBytes: tightLimit })] });
    await tightQuotaV2.definition.initialize(); t.after(() => tightQuotaV2.definition.shutdown());
    await assert.rejects(tightQuotaV2.read(alice, 'mig-records', 'b', 2), { code: 'RECORD_COLLECTION_FULL' });
    const dbAfterQuotaFail = new DatabaseSync(file);
    assert.equal(dbAfterQuotaFail.prepare('SELECT schema_version,revision FROM records WHERE consumer=? AND record_id=?').get('mig-records', 'b').schema_version, 1);
    assert.equal(dbAfterQuotaFail.prepare('SELECT bytes FROM collections WHERE consumer=?').get('mig-records').bytes, usageAfterTomb.bytes);
    dbAfterQuotaFail.close();

    // Converted payload exceeding maxBytes fails with RECORD_TOO_LARGE and rolls back cleanly
    const tightBytesV2 = createAccountRecords(config, {
        consumers: [v2Consumer({
            maxBytes: 20,
            migrations: [{ fromVersion: 1, toVersion: 2, validateSource: v1Validate, convert: p => ({ text: p.text + 'x'.repeat(20), mode: 'a' }) }],
        })],
    });
    await tightBytesV2.definition.initialize(); t.after(() => tightBytesV2.definition.shutdown());
    await assert.rejects(tightBytesV2.read(alice, 'mig-records', 'b', 2), { code: 'RECORD_TOO_LARGE' });
    const dbAfterBytesFail = new DatabaseSync(file);
    assert.equal(dbAfterBytesFail.prepare('SELECT schema_version FROM records WHERE consumer=? AND record_id=?').get('mig-records', 'b').schema_version, 1);
    dbAfterBytesFail.close();

    // Corrupt v1 row fails closed with RECORD_DATA_INVALID on both read and blind commit without mutating DB
    const dbCorrupt = new DatabaseSync(file);
    dbCorrupt.prepare('UPDATE records SET payload=? WHERE consumer=? AND record_id=?').run(JSON.stringify({ text: 123 }), 'mig-records', 'b');
    dbCorrupt.close();
    await assert.rejects(s2a.read(alice, 'mig-records', 'b', 2), { code: 'RECORD_DATA_INVALID' });
    await assert.rejects(s2a.commit(alice, 'mig-records', 'b', { schemaVersion: 2, expectedRevision: 1, payload: { text: 'fix', mode: 'a' } }), { code: 'RECORD_DATA_INVALID' });
    const dbCheckCorrupt = new DatabaseSync(file);
    assert.equal(dbCheckCorrupt.prepare('SELECT schema_version,revision FROM records WHERE consumer=? AND record_id=?').get('mig-records', 'b').schema_version, 1);
    dbCheckCorrupt.close();

    // Multi-step v1 -> v2 -> v3 migration works in a single revision bump; missing step fails closed
    await s1.commit(bob, 'mig-records', 'chain', { schemaVersion: 1, expectedRevision: 0, payload: { text: 'gamma' } });
    const gapV3 = createAccountRecords(config, {
        consumers: [v3Consumer({ migrations: [v3Consumer().migrations[1]] })],
    });
    await gapV3.definition.initialize(); t.after(() => gapV3.definition.shutdown());
    await assert.rejects(gapV3.read(bob, 'mig-records', 'chain', 3), { code: 'RECORD_SCHEMA_INCOMPATIBLE' });

    const s3 = createAccountRecords(config, { consumers: [v3Consumer()] });
    await s3.definition.initialize(); t.after(() => s3.definition.shutdown());
    const migratedV3 = await s3.read(bob, 'mig-records', 'chain', 3);
    assert.equal(migratedV3.schemaVersion, 3);
    assert.equal(migratedV3.revision, 2);
    assert.deepEqual(migratedV3.payload, { text: 'gamma', mode: 'a', tag: 'v3' });
});

