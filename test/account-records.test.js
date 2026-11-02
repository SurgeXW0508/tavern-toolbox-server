import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, symlink, mkdir, copyFile } from 'node:fs/promises';
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

test('record and byte quotas include tombstones; failed quota changes leave record and counters intact', async t => {
    const { store: s, alice, file } = await fixture(t, [consumer('test-records', { maxRecords: 2, maxStorageBytes: 560 })]);
    await commit(s, alice, 'a', 0, 'a'); await commit(s, alice, 'b', 0, 'b');
    await assert.rejects(commit(s, alice, 'a', 1, 'x'.repeat(50)), { code: 'RECORD_COLLECTION_FULL' });
    assert.equal((await s.read(alice, 'test-records', 'a', 1)).revision, 1);
    const db = new DatabaseSync(file), before = db.prepare('SELECT * FROM collections').get(); db.close();
    await remove(s, alice, 'a', 1);
    await assert.rejects(commit(s, alice, 'c'), { code: 'RECORD_COLLECTION_FULL' });
    const check = new DatabaseSync(file); assert.deepEqual(check.prepare('SELECT * FROM collections').get(), before); check.close();
    const largeCount = createAccountRecords(config, { consumers: [consumer('test-records', { maxRecords: 10, maxStorageBytes: 560 })] });
    await largeCount.definition.initialize(); t.after(() => largeCount.definition.shutdown());
    await assert.rejects(commit(largeCount, alice, 'c'), { code: 'RECORD_COLLECTION_FULL' }, 'byte quota independently rejects writes');
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
