import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorldbookStore } from '../src/worldbook/store.js';
const token = () => `${Date.now()}-${randomUUID()}`;
async function fixture(t) {
    const root = await mkdtemp(path.join(tmpdir(), 'ttb-reconcile-'));
    const s = new WorldbookStore(root, DatabaseSync); await s.initialize();
    t.after(async () => { s.close(); await rm(root, { recursive: true, force: true }); });
    const send = (action, data, commandId = token()) => s.execute({ commandId, action, data });
    const read = value => s.features.read(value);
    const columnId = s.summary(1).columns[0].id;
    const context = () => read({ kind: 'import-context', columnId });
    const batch = (entries, destination = { parentId: null }, snapshot = context()) => ({ columnId, structureRevision: snapshot.column.structureRevision, folderToken: snapshot.folderToken, locator: 'XP', destination, entries });
    return { s, send, read, columnId, context, batch };
}
const entries = n => Array.from({ length: n }, (_, uid) => ({ uid, title: `Entry ${uid}` }));
test('builtin batch import 63; duplicate-safe concurrent preview, replay and additions retain exact identities under Schema 3', async t => {
    const e = await fixture(t), preview = e.context(), data = e.batch(entries(63), { parentId: null }, preview);
    e.send('column-import', e.batch(entries(3)));
    const commandId = token(), result = e.send('column-import', data, commandId);
    assert.equal(result.added, 60); assert.equal(result.existing, 3);
    assert.equal(e.send('column-import', data, commandId).replayed, true);
    assert.equal(e.send('column-import', e.batch(entries(63))).added, 0);
    assert.equal(e.send('column-import', e.batch(entries(68))).added, 5);
    assert.equal(e.s.one('SELECT COUNT(*) n FROM materials').n, 68);
    assert.equal(e.s.one('SELECT COUNT(DISTINCT id) n FROM materials').n, 68);
    assert.equal(e.s.one('PRAGMA user_version').user_version, 4);
    assert.throws(() => e.send('column-import', e.batch(entries(101))), { code: 'WORLDBOOK_VALIDATION' });
});
test('folder changes reject stale destinations; no partial imports or accidental reposition', async t => {
    const e = await fixture(t), preview = e.context();
    e.send('column-import', e.batch(entries(1), { newFolderName: 'XP' }));
    assert.throws(() => e.send('column-import', e.batch(entries(63), { parentId: null }, preview)), { code: 'WORLDBOOK_TREE_CHANGED' });
    assert.equal(e.s.one('SELECT COUNT(*) n FROM materials').n, 1);
});
test('column-scoped Sources and guarded global migration show both columns, protect unrelated sources and stable identity', async t => {
    const e = await fixture(t), other = e.s.summary(1).columns[1].id;
    e.send('column-import', e.batch(entries(60)));
    const c = e.read({ kind: 'import-context', columnId: other });
    e.send('column-import', { ...e.batch(entries(3)), columnId: other, structureRevision: c.column.structureRevision, folderToken: c.folderToken });
    e.send('column-import', { ...e.batch([{ uid: 90, title: 'Skill' }]), locator: 'Skill' });
    const sources = e.read({ kind: 'column-sources', columnId: other });
    assert.deepEqual(sources.items.map(r => r.locator), ['XP']);
    const sourceId = sources.items[0].id, before = e.read({ kind: 'source-impact', columnId: other, sourceId });
    assert.equal(before.columns.length, 2); assert.equal(before.total, 63);
    assert.equal(e.s.one('SELECT locator FROM sources WHERE id=?', sourceId).locator, 'XP', 'preview/cancel is read-only');
    const skill = e.s.one("SELECT * FROM sources WHERE locator='Skill'");
    assert.throws(() => e.read({ kind: 'source-impact', columnId: other, sourceId: skill.id }), { code: 'WORLDBOOK_NOT_FOUND' });
    e.send('column-import', e.batch([{ uid: 200, title: 'Concurrent' }]));
    assert.throws(() => e.send('source-migrate', { columnId: other, id: sourceId, revision: before.source.revision, locator: 'XP v2', impactToken: before.impactToken }), { code: 'WORLDBOOK_CONFLICT' });
    const latest = e.read({ kind: 'source-impact', columnId: other, sourceId });
    e.send('source-migrate', { columnId: other, id: sourceId, revision: latest.source.revision, locator: 'XP v2', impactToken: latest.impactToken });
    assert.equal(e.s.one('SELECT locator FROM sources WHERE id=?', sourceId).locator, 'XP v2');
    assert.equal(e.s.one('SELECT COUNT(*) n FROM wb_bindings WHERE repair_pending=1').n, 64);
    assert.throws(() => e.send('column-import', { ...e.batch(entries(1)), expectedSource: { id: sourceId, revision: 1 } }), { code: 'WORLDBOOK_CONFLICT' });
    assert.deepEqual(e.s.one('SELECT * FROM sources WHERE id=?', skill.id), skill);
});

test('legacy Source rebind permits one Column only; shared Sources require guarded migration, while receipts still replay', async t => {
    const e = await fixture(t);
    e.send('column-import', e.batch(entries(3)));
    const source = e.read({ kind: 'column-sources', columnId: e.columnId }).items[0];
    const commandId = token(), legacy = { id: source.id, revision: source.revision, locator: 'XP v1' };
    e.send('source-rebind', legacy, commandId);
    const other = e.s.summary(1).columns[1].id, context = e.read({ kind: 'import-context', columnId: other });
    e.send('column-import', { ...e.batch(entries(2)), columnId: other, locator: 'XP v1', structureRevision: context.column.structureRevision, folderToken: context.folderToken });
    const beforeSource = e.s.one('SELECT * FROM sources WHERE id=?', source.id);
    const beforeBindings = e.s.all('SELECT * FROM wb_bindings ORDER BY material_id');
    assert.throws(() => e.send('source-rebind', { id: source.id, revision: 2, locator: 'XP v2' }), { code: 'WORLDBOOK_CONFLICT' });
    assert.deepEqual(e.s.one('SELECT * FROM sources WHERE id=?', source.id), beforeSource);
    assert.deepEqual(e.s.all('SELECT * FROM wb_bindings ORDER BY material_id'), beforeBindings);
    assert.equal(e.send('source-rebind', legacy, commandId).replayed, true);
    assert.deepEqual(e.s.one('SELECT * FROM sources WHERE id=?', source.id), beforeSource);
    assert.throws(() => e.send('source-rebind', { id: source.id, revision: 2, locator: 'XP v2', allowShared: true }), { code: 'WORLDBOOK_VALIDATION' });
    const impact = e.read({ kind: 'source-impact', columnId: e.columnId, sourceId: source.id });
    e.send('source-migrate', { columnId: e.columnId, id: source.id, revision: 2, locator: 'XP v2', impactToken: impact.impactToken });
    assert.equal(e.s.one('SELECT locator FROM sources WHERE id=?', source.id).locator, 'XP v2');
    assert.equal(e.s.one('SELECT COUNT(*) n FROM wb_bindings WHERE repair_pending=1').n, 5);
});

test('a fully concurrent-existing batch creates no empty folder; a later batch can fulfill the same new-folder intent', async t => {
    const e = await fixture(t), preview = e.context();
    e.send('column-import', e.batch(entries(100)));
    const first = e.send('column-import', e.batch(entries(100), { newFolderName: 'XP' }, preview));
    assert.equal(first.added, 0); assert.equal(first.existing, 100); assert.equal(first.parentId, null);
    assert.equal(e.s.one('SELECT COUNT(*) n FROM folders').n, 0);
    const second = e.send('column-import', e.batch(entries(150).slice(100), { newFolderName: 'XP' }));
    assert.equal(second.added, 50); assert(second.parentId);
    assert.equal(e.s.one('SELECT COUNT(*) n FROM materials WHERE parent_id=?', second.parentId).n, 50);
    assert.equal(e.s.one('SELECT COUNT(*) n FROM materials WHERE parent_id IS NULL').n, 100);
});
