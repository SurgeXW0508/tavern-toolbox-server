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
    const root = await mkdtemp(path.join(tmpdir(), 'ttb-wb-features-'));
    const store = new WorldbookStore(root, DatabaseSync);
    await store.initialize();
    t.after(async () => {
        store.close();
        await rm(root, { recursive: true, force: true });
    });
    const send = (action, data, commandId = token()) => store.execute({ commandId, action, data });
    const create = (name, rows = []) =>
        send('column-create', {
            profile: {
                title: name,
                description: '',
                icon: { type: 'builtin', value: 'book' },
                accent: '#123456',
            },
            materials: rows,
        }).column;
    const col = create(
        '资料',
        [1, 2, 3].map((uid) => ({
            name: `自定义 ${uid}`,
            description: `长正文 ${uid}`,
            source: { locator: '书A', uid, title: `Entry ${uid}` },
        })),
    );
    const rows = store.catalog({ columnId: col.id, page: 1, tags: [] }).items;
    return { store, send, create, col, rows, root };
}
const expect = (f, code) => assert.throws(f, { code });

test('v1 migration preserves identities, metadata, tags, sources; migration failure rolls back without replacing DB', async (t) => {
    const env = await fixture(t),
        { store } = env,
        original = store.detail(env.rows[0].id);
    // Construct the exact original v1 schema by removing only this upgrade.
    const rollbackToV1 = () => {
        for (const row of store.all("SELECT name FROM sqlite_master WHERE type='trigger'"))
            store.db.exec(`DROP TRIGGER ${row.name}`);
        for (const table of [
            'wb_media',
            'wb_media_versions',
            'wb_companions',
            'wb_preset_members',
            'wb_presets',
            'wb_relation_versions',
            'wb_usage',
            'wb_bindings',
        ])
            store.db.exec(`DROP TABLE ${table}`);
        store.db.exec('PRAGMA user_version=1');
    };
    rollbackToV1();
    store.close();
    const file = path.join(env.root, 'tavern-toolbox-server/worldbook-v1/worldbook.sqlite');
    class BrokenDatabase extends DatabaseSync {
        exec(sql) {
            if (sql.includes('CREATE TABLE wb_usage')) throw Error('migration interrupted');
            return super.exec(sql);
        }
    }
    const broken = new WorldbookStore(env.root, BrokenDatabase);
    await assert.rejects(broken.initialize(), /migration interrupted/);
    const db = new DatabaseSync(file);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='wb_bindings'").get(), undefined);
    db.close();
    await store.initialize();
    const current = store.detail(env.rows[0].id);
    assert.equal(store.one('PRAGMA user_version').user_version, 3);
    assert.deepEqual(current, original);
    store.close();
    await store.initialize();
    assert.deepEqual(store.detail(env.rows[0].id), original);
});

test('Companion direction, self/duplicate rejection, isolated revision, copy outgoing only and transactional deletion cleanup', async (t) => {
    const e = await fixture(t),
        [a, b, c] = e.rows;
    e.send('companions-save', { id: a.id, revision: 1, memberIds: [b.id] });
    e.send('companions-save', { id: c.id, revision: 1, memberIds: [a.id] });
    expect(
        () => e.send('companions-save', { id: b.id, revision: 1, memberIds: [b.id] }),
        'WORLDBOOK_VALIDATION',
    );
    expect(
        () => e.send('companions-save', { id: b.id, revision: 1, memberIds: [a.id, a.id] }),
        'WORLDBOOK_VALIDATION',
    );
    expect(() => e.send('companions-save', { id: a.id, revision: 1, memberIds: [] }), 'WORLDBOOK_CONFLICT');
    assert.equal(e.store.detail(a.id).material.revision, a.revision);
    const current = e.store.detail(a.id),
        copied = e.send('material-copy', {
            id: a.id,
            revision: a.revision,
            structureRevision: current.column.structureRevision,
            columnId: e.col.id,
            parentId: null,
            targetStructureRevision: current.column.structureRevision,
        });
    assert.equal(
        e.store.one('SELECT companion_id FROM wb_companions WHERE subject_id=?', copied.id).companion_id,
        b.id,
    );
    assert.equal(e.store.one('SELECT COUNT(*) n FROM wb_companions WHERE companion_id=?', copied.id).n, 0);
    const d = e.store.detail(a.id);
    e.send('material-delete', {
        id: a.id,
        revision: d.material.revision,
        structureRevision: d.column.structureRevision,
    });
    assert.equal(
        e.store.one('SELECT COUNT(*) n FROM wb_companions WHERE subject_id=? OR companion_id=?', a.id, a.id)
            .n,
        0,
    );
    assert.equal(e.store.detail(c.id).material.relationRevision, 3);
});

test('Preset entity CAS, move removes only old Column members; Global membership and relationships survive; copy has reset usage/no memberships', async (t) => {
    const e = await fixture(t),
        [a, b] = e.rows,
        other = e.create('另栏');
    const column = e.send('preset-create', { columnId: e.col.id, name: '栏目方案', memberIds: [a.id, b.id] });
    const global = e.send('preset-create', { columnId: null, name: '全局方案', memberIds: [a.id] });
    e.send('preset-update', { id: column.presetId, revision: 1, name: '栏目新名' });
    e.send('preset-update', { id: global.presetId, revision: 1, name: '全局新名' });
    expect(
        () => e.send('preset-update', { id: column.presetId, revision: 1, name: '过时' }),
        'WORLDBOOK_CONFLICT',
    );
    e.send('companions-save', { id: a.id, revision: 1, memberIds: [b.id] });
    e.send('usage-increment', { materialIds: [a.id], at: Date.now() });
    const d = e.store.detail(a.id),
        copy = e.send('material-copy', {
            id: a.id,
            revision: a.revision,
            structureRevision: d.column.structureRevision,
            columnId: other.id,
            parentId: null,
            targetStructureRevision: other.structureRevision,
        });
    assert.equal(e.store.detail(copy.id).material.enableCount, 0);
    assert.equal(e.store.one('SELECT COUNT(*) n FROM wb_preset_members WHERE material_id=?', copy.id).n, 0);
    const now = e.store.detail(a.id);
    e.send('material-move', {
        id: a.id,
        revision: a.revision,
        structureRevision: now.column.structureRevision,
        columnId: other.id,
        parentId: null,
        targetStructureRevision: e.store.column(other.id).structure_revision,
    });
    assert.equal(
        e.store.one(
            'SELECT COUNT(*) n FROM wb_preset_members WHERE preset_id=? AND material_id=?',
            column.presetId,
            a.id,
        ).n,
        0,
    );
    assert.equal(
        e.store.one(
            'SELECT COUNT(*) n FROM wb_preset_members WHERE preset_id=? AND material_id=?',
            global.presetId,
            a.id,
        ).n,
        1,
    );
    assert.equal(e.store.one('SELECT COUNT(*) n FROM wb_companions WHERE subject_id=?', a.id).n, 1);
});

test('Usage increments atomically, replay does not recount, Source duplicates count once and Metadata CAS stays independent', async (t) => {
    const e = await fixture(t),
        a = e.rows[0],
        commandId = token(),
        at = Date.now();
    e.send('usage-increment', { materialIds: [a.id], at }, commandId);
    e.send('usage-increment', { materialIds: [a.id], at }, commandId);
    e.send('usage-increment', { materialIds: [a.id], at });
    assert.equal(e.store.detail(a.id).material.enableCount, 2);
    e.send('material-update', { id: a.id, revision: a.revision, fields: { description: '设备A未冲突' } });
    assert.equal(e.store.detail(a.id).material.description, '设备A未冲突');
});

test('reconcile updates only Binding, detached is sticky, unknown rejected, stale observations skip, explicit rebind restores without changing Material name', async (t) => {
    const e = await fixture(t),
        a = e.rows[0];
    const observation = (revision, lifecycle, title = 'Entry renamed') => ({
        id: a.id,
        sourceId: a.source.sourceId,
        locator: a.source.locator,
        uid: a.source.uid,
        bindingRevision: revision,
        lifecycle,
        title,
    });
    e.send('binding-observe', { observations: [observation(1, 'active')] });
    assert.equal(e.store.detail(a.id).material.source.title, 'Entry renamed');
    assert.equal(e.store.detail(a.id).material.name, a.name);
    assert.equal(e.store.detail(a.id).material.revision, a.revision);
    e.send('binding-observe', { observations: [observation(2, 'detached')] });
    e.send('binding-observe', { observations: [observation(3, 'active')] });
    assert.equal(e.store.detail(a.id).material.lifecycle, 'detached');
    expect(
        () => e.send('binding-observe', { observations: [observation(3, 'unknown')] }),
        'WORLDBOOK_VALIDATION',
    );
    e.send('binding-rebind', {
        id: a.id,
        bindingRevision: 3,
        source: { locator: '书B', uid: 50, title: '用户明确目标' },
    });
    const stale = e.send('binding-observe', { observations: [observation(3, 'detached')] });
    assert.equal(stale.skipped, 1);
    const saved = e.store.detail(a.id).material;
    assert.equal(saved.lifecycle, 'active');
    assert.equal(saved.source.uid, 50);
    assert.equal(saved.name, a.name);
});

test('Whole-book rebind preserves Source ID, rejects target ownership collision, and permits explicit continuity repair', async (t) => {
    const e = await fixture(t),
        a = e.rows[0];
    e.send('binding-observe', {
        observations: [
            {
                id: a.id,
                sourceId: a.source.sourceId,
                locator: a.source.locator,
                uid: a.source.uid,
                bindingRevision: 1,
                lifecycle: 'detached',
            },
        ],
    });
    e.send('source-rebind', { id: a.source.sourceId, revision: 1, locator: '书A v2' });
    assert.equal(e.store.detail(a.id).material.source.sourceId, a.source.sourceId);
    e.send('binding-observe', {
        observations: [
            {
                id: a.id,
                sourceId: a.source.sourceId,
                locator: '书A v2',
                uid: a.source.uid,
                bindingRevision: 3,
                lifecycle: 'active',
                title: '连续性确认',
            },
        ],
    });
    assert.equal(e.store.detail(a.id).material.lifecycle, 'active');
    e.create('冲突', [{ name: '目标', source: { locator: '书B', uid: 1, title: 'Entry' } }]);
    expect(
        () => e.send('source-rebind', { id: a.source.sourceId, revision: 2, locator: '书B' }),
        'WORLDBOOK_SOURCE_COLLISION',
    );
    assert.equal(e.store.detail(a.id).material.source.locator, '书A v2');
});

test('bounded binding and relationship reads exclude long detail fields; Picker preserves independent Material identities', async (t) => {
    const e = await fixture(t),
        [a, b, c] = e.rows;
    e.send('companions-save', { id: a.id, revision: 1, memberIds: [b.id, c.id] });
    const bindings = e.store.features.read({ kind: 'bindings', scope: { columnId: e.col.id } });
    assert.equal(bindings.items.length, 3);
    assert.equal(bindings.nextCursor, null);
    assert.ok(bindings.items.every((row) => !('description' in row) && !('tags' in row)));
    const picker = e.store.features.read({
        kind: 'picker',
        subjectId: a.id,
        selected: true,
        scope: { q: '自定义' },
    });
    assert.equal(picker.total, 2);
    assert.equal(picker.selectedCount, 2);
    assert.ok(picker.items.every((row) => row.selected));
    assert.ok(picker.items.every((row) => row.id !== a.id && !('description' in row)));
    const facet = e.store.features.read({ kind: 'facets', id: 'types' });
    assert.equal(facet.items.length, 0);
});

test('Column exact-state projects same-source ON precedence, Global plans stay additive and preserve detached membership', async (t) => {
    const e = await fixture(t),
        [a, b] = e.rows;
    e.send('binding-rebind', {
        id: b.id,
        bindingRevision: b.bindingRevision,
        source: { locator: a.source.locator, uid: a.source.uid, title: a.source.title },
    });
    const exact = e.send('preset-create', { columnId: e.col.id, name: '精确', memberIds: [a.id] });
    const plan = e.store.features.read({
        kind: 'plan',
        presetId: exact.presetId,
        revision: 1,
        runtimeToken: 'already-verified-at-HTTP-boundary',
    });
    assert.equal(plan.total, 2);
    assert.equal(plan.items.filter((r) => r.uid === a.source.uid).length, 1);
    assert.equal(plan.items.find((r) => r.uid === a.source.uid).on, true);
    assert.equal(plan.items.find((r) => r.uid !== a.source.uid).on, false);
    const global = e.send('preset-create', { columnId: null, name: '补充', memberIds: [a.id] });
    assert.ok(
        e.store.features
            .read({ kind: 'plan', presetId: global.presetId, revision: 1 })
            .items.every((r) => r.on),
    );
    e.send('binding-observe', {
        observations: [
            {
                id: a.id,
                sourceId: a.source.sourceId,
                locator: a.source.locator,
                uid: a.source.uid,
                bindingRevision: 1,
                lifecycle: 'detached',
            },
        ],
    });
    const detached = e.store.features.read({ kind: 'plan', presetId: global.presetId, revision: 1 });
    assert.equal(detached.skipped, 1);
    assert.equal(detached.total, 0);
    assert.equal(
        e.store.one('SELECT COUNT(*) n FROM wb_preset_members WHERE preset_id=?', global.presetId).n,
        1,
    );
});

test('classification search returns bounded hits with deep ancestor context, server-side usage sort is independent of metadata', async (t) => {
    const e = await fixture(t),
        a = e.rows[0];
    let parentId = null;
    for (let depth = 0; depth < 3; depth++) {
        const parent = e.send('folder-create', {
            columnId: e.col.id,
            parentId,
            structureRevision: e.store.column(e.col.id).structure_revision,
            name: `分组 ${depth}`,
        });
        parentId = parent.folderId;
    }
    e.send('material-move', {
        id: a.id,
        revision: a.revision,
        structureRevision: e.store.column(e.col.id).structure_revision,
        columnId: e.col.id,
        parentId,
        targetStructureRevision: e.store.column(e.col.id).structure_revision,
    });
    const result = e.store.features.read({ kind: 'tree-search', scope: { columnId: e.col.id, q: a.name } });
    assert.equal(result.total, 1);
    assert.equal(result.items.length, 4);
    assert.equal(result.items.filter((row) => row.match).length, 1);
    const parents = new Set(result.items.map((row) => row.id));
    assert.ok(result.items.every((row) => row.parentId === null || parents.has(row.parentId)));
    e.send('usage-increment', { materialIds: [a.id], at: Date.now() });
    for (const sort of ['recent', 'frequent'])
        assert.equal(e.store.catalog({ columnId: e.col.id, page: 1, tags: [], sort }).items[0].id, a.id);
});

test('observed runtime distinguishes enabled, disabled, absent UID and unknown book without persisting runtime truth', async (t) => {
    const e = await fixture(t),
        runtime = {
            observed: true,
            bindings: [
                { locator: '书A', uid: 1, enabled: false },
                { locator: '书A', uid: 2, enabled: true },
            ],
            unknownBooks: [],
        };
    const select = (status) => e.store.catalog({ page: 1, tags: [], status }, runtime);
    assert.equal(select('enabled').total, 1);
    assert.equal(select('disabled').total, 1);
    assert.equal(select('unknown').total, 1);
    runtime.unknownBooks = ['书A'];
    assert.equal(select('enabled').total, 0);
    assert.equal(select('disabled').total, 0);
    assert.equal(select('unknown').total, 3);
    assert.equal(e.store.one("SELECT COUNT(*) n FROM wb_bindings WHERE lifecycle='active'").n, 3);
    const columns = e.store.all('PRAGMA table_info(materials)').map((row) => row.name);
    assert.equal(columns.includes('enabled'), false);
});

test('Roll traverses complete filtered logical sources with bounded seed cursor, no repeats, context/TTL and replay safety', async (t) => {
    const { WorldbookCandidateSessions } = await import('../src/worldbook/candidate-sessions.js');
    const e = await fixture(t);
    const rows = Array.from({ length: 100 }, (_, i) => ({
        name: `候选 ${i + 1}`,
        materialType: '角色',
        tags: ['候选'],
        summary: '短简介',
        description: '不得进入候选正文'.repeat(400),
        source: { locator: '书A', uid: i + 1, title: `Entry ${i + 1}` },
    }));
    e.create('跨页', rows);
    e.create('重复放置', rows.slice(9, 19));
    const missing = e.store.all(
        'SELECT m.id,m.source_id,b.revision FROM materials m JOIN wb_bindings b ON b.material_id=m.id WHERE entry_uid=2',
    );
    e.send('binding-observe', {
        observations: missing.map((row) => ({
            id: row.id,
            sourceId: row.source_id,
            locator: '书A',
            uid: 2,
            bindingRevision: row.revision,
            lifecycle: 'detached',
        })),
    });
    const runtime = {
        observed: true,
        bindings: rows.map((row) => ({ locator: '书A', uid: row.source.uid, enabled: row.source.uid === 1 })),
        unknownBooks: [],
    };
    let now = Date.now();
    const sessions = new WorldbookCandidateSessions(() => now),
        context = { userRoot: e.root, contextId: 'context-one' };
    let input = { kind: 'roll', limit: 20 },
        response;
    const seen = new Set();
    do {
        response = sessions.read(context, e.store, input, runtime);
        assert.ok(response.items.length <= 20);
        assert.equal(response.scopeTotal, 98);
        for (const row of response.items) {
            assert.ok(!seen.has(row.source.uid));
            seen.add(row.source.uid);
            assert.equal('description' in row, false);
            assert.ok(![1, 2].includes(row.source.uid));
        }
        if (input.sessionId)
            assert.deepEqual(
                sessions.read(context, e.store, input, runtime),
                response,
                'repeat cursor returns same bounded response',
            );
        input = { kind: 'roll', sessionId: response.sessionId, cursor: response.nextCursor, limit: 20 };
    } while (response.nextCursor !== null);
    assert.equal(seen.size, 98);
    assert.ok(seen.has(99));
    expect(
        () => sessions.read({ ...context, contextId: 'other' }, e.store, { ...input, cursor: 0 }, runtime),
        'WORLDBOOK_SESSION_EXPIRED',
    );
    now += 16 * 60000;
    expect(
        () => sessions.read(context, e.store, { ...input, cursor: 0 }, runtime),
        'WORLDBOOK_SESSION_EXPIRED',
    );
    runtime.unknownBooks = ['书A'];
    expect(
        () => sessions.read(context, e.store, { kind: 'discovery' }, runtime),
        'WORLDBOOK_RUNTIME_UNAVAILABLE',
    );
});

test('relationship draft selected tab is projected before pagination, incremental CAS preserves unseen members', async (t) => {
    const { store, send, rows } = await fixture(t),
        subject = rows[0];
    send('companions-members', { id: subject.id, revision: 1, add: [rows[1].id], remove: [] });
    const draft = store.features.read({
        kind: 'picker',
        subjectId: subject.id,
        selected: true,
        draftAdd: [rows[2].id],
        draftRemove: [rows[1].id],
    });
    assert.deepEqual(
        draft.items.map((row) => row.id),
        [rows[2].id],
    );
    assert.equal(draft.selectedCount, 1);
    send('companions-members', { id: subject.id, revision: 2, add: [rows[2].id], remove: [] });
    assert.equal(store.features.read({ kind: 'companions', subjectId: subject.id }).total, 2);
    expect(
        () => send('companions-members', { id: subject.id, revision: 2, add: [], remove: [] }),
        'WORLDBOOK_CONFLICT',
    );
});

test('capture enabled scope is atomic and idempotent even after Runtime Token expires; unknown state rejects without clearing members', async (t) => {
    const { store, send, rows, col } = await fixture(t);
    const preset = send('preset-create', { name: '当前', columnId: col.id, memberIds: [rows[2].id] });
    const body = {
        commandId: token(),
        action: 'preset-capture',
        data: { id: preset.presetId, revision: 1, runtimeToken: 'runtime-1' },
    };
    const getRuntime = () => ({
        observed: true,
        unknownBooks: [],
        bindings: [
            { locator: '书A', uid: 1, enabled: true },
            { locator: '书A', uid: 2, enabled: false },
            { locator: '书A', uid: 3, enabled: false },
        ],
    });
    const result = store.execute(body, { getRuntime });
    assert.equal(result.revision, 2);
    assert.equal(
        store.features.read({ kind: 'picker', presetId: preset.presetId, selected: true }).items[0].id,
        rows.find((row) => row.source.uid === 1).id,
    );
    assert.equal(
        store.execute(body, {
            getRuntime: () => {
                throw Error('expired');
            },
        }).replayed,
        true,
    );
    expect(
        () =>
            store.execute(
                {
                    commandId: token(),
                    action: 'preset-capture',
                    data: { id: preset.presetId, revision: 2, runtimeToken: 'runtime-2' },
                },
                { getRuntime: () => ({ observed: true, unknownBooks: ['书A'], bindings: [] }) },
            ),
        'WORLDBOOK_RUNTIME_UNAVAILABLE',
    );
    assert.equal(store.features.read({ kind: 'picker', presetId: preset.presetId, selected: true }).total, 1);
});

test('independent SQLite connections increment usage without lost updates or metadata revision coupling', async (t) => {
    const { store, root, rows } = await fixture(t),
        other = new WorldbookStore(root, DatabaseSync);
    await other.initialize();
    t.after(() => other.close());
    for (let i = 0; i < 20; i++)
        (i % 2 ? store : other).execute({
            commandId: token(),
            action: 'usage-increment',
            data: { materialIds: [rows[0].id], at: Date.now() },
        });
    assert.equal(store.detail(rows[0].id).material.enableCount, 20);
    assert.equal(other.detail(rows[0].id).material.revision, rows[0].revision);
});

test('maximal Unicode lightweight source and plan pages remain within response budget', async (t) => {
    const { store, send, create } = await fixture(t),
        text = '界',
        col = create(
            '极限',
            Array.from({ length: 55 }, (_, uid) => ({
                name: text.repeat(80),
                source: { locator: text.repeat(240), uid, title: text.repeat(200) },
            })),
        );
    const compact = store.features.read({ kind: 'bindings', scope: { columnId: col.id } });
    assert.equal(compact.items.length, 50);
    assert(Buffer.byteLength(JSON.stringify(compact)) <= 131072);
    const preset = send('preset-create', { name: '极限', columnId: col.id });
    const plan = store.features.read({
        kind: 'plan',
        presetId: preset.presetId,
        revision: 1,
        runtimeToken: 'token',
    });
    assert(Buffer.byteLength(JSON.stringify(plan)) <= 131072);
});

test('candidate scope preserves status filters and rejects hidden data in compact scopes', async (t) => {
    const { store, rows, col } = await fixture(t),
        { WorldbookCandidateSessions } = await import('../src/worldbook/candidate-sessions.js'),
        sessions = new WorldbookCandidateSessions(),
        context = { userRoot: 'fixture', contextId: 'one' },
        runtime = {
            observed: true,
            unknownBooks: [],
            bindings: rows.map((row) => ({ locator: '书A', uid: row.source.uid, enabled: false })),
        };
    for (const status of ['detached', 'enabled', 'unknown'])
        assert.equal(
            sessions.read(context, store, { kind: 'roll', scope: { columnId: col.id, status } }, runtime)
                .items.length,
            0,
        );
    expect(
        () => store.features.read({ kind: 'bindings', scope: { columnId: col.id, aiKey: 'forbidden' } }),
        'WORLDBOOK_VALIDATION',
    );
});

test('Phone Binding rebind preserves PC metadata draft revision; Binding CAS stays independent and legacy source writes are rejected', async (t) => {
    const { store, send, rows } = await fixture(t),
        a = rows[0],
        pcDraft = store.detail(a.id).material;
    const observation = {
        id: a.id,
        sourceId: a.source.sourceId,
        locator: a.source.locator,
        uid: a.source.uid,
        bindingRevision: 1,
        lifecycle: 'detached',
    };
    send('binding-observe', { observations: [observation] });
    send('source-rebind', { id: a.source.sourceId, revision: 1, locator: '书A v2' });
    const pending = store.detail(a.id).material;
    assert.equal(pending.repairPending, true);
    const source = { locator: '书B', uid: 99, title: '明确的新来源' };
    send('binding-rebind', { id: a.id, bindingRevision: pending.bindingRevision, source });
    const phoneSaved = store.detail(a.id).material;
    assert.equal(phoneSaved.revision, pcDraft.revision);
    assert.equal(phoneSaved.bindingRevision, pending.bindingRevision + 1);
    assert.equal(phoneSaved.lifecycle, 'active');
    assert.equal(phoneSaved.repairPending, false);
    send('material-update', {
        id: a.id,
        revision: pcDraft.revision,
        fields: { description: 'PC 未受来源变化影响的草稿' },
    });
    const saved = store.detail(a.id).material;
    assert.equal(saved.description, 'PC 未受来源变化影响的草稿');
    assert.equal(saved.source.locator, '书B');
    assert.equal(saved.source.uid, 99);
    assert.equal(saved.bindingRevision, phoneSaved.bindingRevision);
    expect(
        () =>
            send('binding-rebind', {
                id: a.id,
                bindingRevision: pending.bindingRevision,
                source: { locator: '错目标', uid: 12, title: '过期' },
            }),
        'WORLDBOOK_CONFLICT',
    );
    expect(
        () =>
            send('material-update', {
                id: a.id,
                revision: saved.revision,
                fields: { source: { locator: '旧路径', uid: 8, title: '禁止' } },
            }),
        'WORLDBOOK_VALIDATION',
    );
    expect(
        () =>
            send('material-update', {
                id: a.id,
                revision: saved.revision,
                fields: { description: '不应部分保存', source: { locator: '旧路径', uid: 8, title: '禁止' } },
            }),
        'WORLDBOOK_VALIDATION',
    );
    assert.deepEqual(store.detail(a.id).material, saved);
});
