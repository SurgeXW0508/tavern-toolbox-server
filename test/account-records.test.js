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
