import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { WorldbookStore } from '../src/worldbook/store.js';
import { createWorldbook } from '../src/worldbook/index.js';
import { query, LIMITS } from '../src/worldbook/validation.js';
const token = () => `${Date.now()}-${randomUUID()}`;
const profile = (title) => ({
    title,
    description: '栏目说明',
    icon: { type: 'builtin', value: 'book' },
    accent: '#123456',
});
const material = (i, fields = {}) => ({
    name: `中文 Material ${i}`,
    materialType: i % 2 ? '角色' : '规则',
    summary: `摘要 ${i}`,
    description: `详细内容 Deep body ${i}`,
    tags: i % 2 ? ['甲', '乙'] : ['甲'],
    favorite: i % 3 === 0,
    source: { locator: '非 Active 书', uid: i, title: `Entry ${i}` },
    ...fields,
});
async function fixture(t) {
    const root = await mkdtemp(path.join(tmpdir(), 'ttb-worldbook-'));
    const store = new WorldbookStore(root, DatabaseSync);
    await store.initialize();
    t.after(async () => {
        store.close();
        await rm(root, { recursive: true, force: true });
    });
    return {
        root,
        store,
        send: (action, data, commandId = token()) => store.execute({ commandId, action, data }),
    };
}
function create(env, title = '栏目', rows = []) {
    return env.send('column-create', {
        profile: profile(title),
        materials: rows,
    }).column;
}
function page(store, params = {}) {
    return store.catalog(query(params));
}

test('Worldbook restart persistence, empty shared builtins, schema version and independent user roots', async (t) => {
    const env = await fixture(t);
    assert.equal(env.store.summary().columns.length, 2);
    assert.ok(env.store.summary().columns.every((c) => c.builtin && c.materialCount === 0));
    const col = create(env, '用户栏目', [material(1)]),
        first = page(env.store).items[0];
    env.store.close();
    await env.store.initialize();
    assert.equal(env.store.detail(first.id).material.description, '详细内容 Deep body 1');
    assert.equal(env.store.detail(first.id).column.id, col.id);
    assert.equal(env.store.detail(first.id).material.source.sourceId, first.source.sourceId);
    const dbFile = path.join(env.root, 'tavern-toolbox-server/worldbook-v1/worldbook.sqlite');
    assert.equal(env.store.one('PRAGMA user_version').user_version, 2);
    env.store.close();
    const db = new DatabaseSync(dbFile);
    db.exec('PRAGMA user_version=3');
    db.close();
    await assert.rejects(env.store.initialize(), {
        code: 'WORLDBOOK_SCHEMA_INCOMPATIBLE',
    });
    const other = await fixture(t);
    assert.equal(page(other.store).total, 0);
});

test('metadata CAS is per Material; stale writes do not alter saved content and source rebind keeps identity', async (t) => {
    const env = await fixture(t),
        col = create(env, '栏目', [material(1), material(2)]),
        [a, b] = page(env.store, { columnId: col.id }).items;
    env.send('material-update', {
        id: a.id,
        revision: a.revision,
        fields: { name: '自己的名称', description: '设备 A 的编辑' },
    });
    env.send('material-update', {
        id: b.id,
        revision: b.revision,
        fields: { favorite: true, summary: '设备 B 的编辑' },
    });
    assert.throws(
        () =>
            env.send('material-update', {
                id: a.id,
                revision: a.revision,
                fields: { description: '过时覆盖' },
            }),
        { code: 'WORLDBOOK_CONFLICT' },
    );
    let saved = env.store.detail(a.id).material;
    assert.equal(saved.description, '设备 A 的编辑');
    assert.equal(saved.name, '自己的名称');
    env.send('binding-rebind', {
        id: a.id,
        bindingRevision: saved.bindingRevision,
        source: { locator: '新版书', uid: 9, title: 'Entry renamed' },
    });
    saved = env.store.detail(a.id).material;
    assert.equal(saved.id, a.id);
    assert.equal(saved.name, '自己的名称');
    assert.notEqual(saved.source.sourceId, a.source.sourceId);
    assert.equal(saved.description, '设备 A 的编辑');
    assert.deepEqual(saved.tags, ['甲', '乙']);
});

test('column ordering is atomic with tied positions, independent of Material edits, and stale target edits conflict', async (t) => {
    const env = await fixture(t),
        columns = Array.from({ length: 4 }, (_, i) => create(env, String(i), [material(i)]));
    const before = env.store.summary().columns.filter((row) => !row.builtin),
        a = before[0],
        target = before[1];
    const receipt = env.send('column-reorder', {
        id: a.id,
        revision: a.revision,
        targetId: target.id,
        targetRevision: target.revision,
    });
    assert.equal(receipt.summaryChanged, true);
    const after = env.store.summary().columns.filter((row) => !row.builtin);
    assert.deepEqual(
        after.map((row) => row.id),
        [target.id, a.id, ...before.slice(2).map((row) => row.id)],
    );
    const m = page(env.store, { columnId: a.id }).items[0];
    env.send('material-update', {
        id: m.id,
        revision: m.revision,
        fields: { summary: '独立编辑' },
    });
    assert.throws(
        () =>
            env.send('column-reorder', {
                id: a.id,
                revision: a.revision,
                targetId: target.id,
                targetRevision: target.revision,
            }),
        { code: 'WORLDBOOK_CONFLICT' },
    );
    assert.equal(columns.length, 4);
});

test('Move preserves ID, Copy creates an independent ID, structural CAS, deletes never touch native sources', async (t) => {
    const env = await fixture(t),
        a = create(env, 'A', [material(1)]),
        b = create(env, 'B'),
        m = page(env.store, { columnId: a.id }).items[0];
    const moved = env.send('material-move', {
        id: m.id,
        revision: m.revision,
        structureRevision: a.structureRevision,
        columnId: b.id,
        parentId: null,
        targetStructureRevision: b.structureRevision,
    });
    assert.equal(moved.id, m.id);
    assert.equal(env.store.detail(m.id).material.columnId, b.id);
    assert.throws(
        () =>
            env.send('folder-create', {
                columnId: b.id,
                parentId: null,
                name: '过时',
                structureRevision: b.structureRevision,
            }),
        { code: 'WORLDBOOK_CONFLICT' },
    );
    const current = env.store.detail(m.id),
        copyCommand = token(),
        body = {
            id: m.id,
            revision: current.material.revision,
            structureRevision: current.column.structureRevision,
            columnId: a.id,
            parentId: null,
            targetStructureRevision: env.store.column(a.id).structure_revision,
        };
    const copy = env.send('material-copy', body, copyCommand);
    assert.notEqual(copy.id, m.id);
    env.store.close();
    await env.store.initialize();
    assert.deepEqual(env.send('material-copy', body, copyCommand), {
        ...copy,
        replayed: true,
    });
    assert.equal(env.store.detail(copy.id).material.source.sourceId, m.source.sourceId);
    assert.equal(env.store.one('SELECT COUNT(*) n FROM sources').n, 1);
    const copied = env.store.detail(copy.id);
    env.send('material-delete', {
        id: copy.id,
        revision: copied.material.revision,
        structureRevision: copied.column.structureRevision,
    });
    assert.throws(() => env.store.detail(copy.id), {
        code: 'WORLDBOOK_NOT_FOUND',
    });
    assert.ok(env.store.detail(m.id));
    assert.equal(env.store.one('SELECT COUNT(*) n FROM sources').n, 1);
});

test('legal maximal Unicode card/detail/tree/summary and command acknowledgments stay within response bounds; builtin restrictions fail closed', async (t) => {
    const env = await fixture(t),
        rows = Array.from({ length: 100 }, (_, i) =>
            material(i, {
                name: '名'.repeat(80),
                materialType: '类'.repeat(60),
                summary: '摘'.repeat(160),
                description: '文'.repeat(20000),
                tags: Array.from({ length: 16 }, (_, n) => String(n) + '标'.repeat(30)),
                source: {
                    locator: String(i) + '书'.repeat(235),
                    uid: i,
                    title: '题'.repeat(200),
                },
            }),
        );
    const result = env.send('column-create', {
        profile: { ...profile('名'.repeat(80)), description: '栏'.repeat(160) },
        materials: rows,
    });
    for (const response of [
        result,
        page(env.store),
        env.store.tree(result.column.id),
        env.store.detail(page(env.store).items[0].id),
        env.store.summary(),
        env.store.sources(),
    ])
        assert.ok(Buffer.byteLength(JSON.stringify(response)) + 1024 < LIMITS.maxResponseBytes);
    const builtin = env.store.column('xp-worldbook');
    assert.throws(
        () =>
            env.send('column-update', {
                id: builtin.id,
                revision: builtin.revision,
                profile: profile('替换内置'),
            }),
        { code: 'WORLDBOOK_BUILTIN' },
    );
    assert.throws(
        () =>
            env.send('column-delete', {
                id: builtin.id,
                revision: builtin.revision,
                structureRevision: builtin.structure_revision,
            }),
        { code: 'WORLDBOOK_BUILTIN' },
    );
    const moved = env.send('material-move', {
            id: page(env.store).items[0].id,
            revision: 1,
            structureRevision: 1,
            columnId: builtin.id,
            parentId: null,
            targetStructureRevision: 1,
        }),
        retry = token();
    const current = env.store.detail(moved.id),
        data = {
            id: moved.id,
            revision: current.material.revision,
            structureRevision: current.column.structureRevision,
        };
    const deleted = env.send('material-delete', data, retry);
    env.store.close();
    await env.store.initialize();
    assert.deepEqual(env.send('material-delete', data, retry), {
        ...deleted,
        replayed: true,
    });
});

test('durable command receipt makes response-lost create retry safe, detects modified retry and fails old tokens', async (t) => {
    const env = await fixture(t),
        commandId = token(),
        data = { profile: profile('幂等'), materials: [material(1)] };
    const first = env.send('column-create', data, commandId);
    env.store.close();
    await env.store.initialize();
    assert.deepEqual(env.send('column-create', data, commandId), {
        ...first,
        replayed: true,
    });
    assert.equal(page(env.store).total, 1);
    assert.throws(() => env.send('column-create', { ...data, profile: profile('不同') }, commandId), {
        code: 'WORLDBOOK_IDEMPOTENCY_MISMATCH',
    });
    assert.throws(() => env.send('column-create', data, `${Date.now() - LIMITS.commandTtlMs - 1000}-${randomUUID()}`), {
        code: 'WORLDBOOK_COMMAND_EXPIRED',
    });
    assert.ok(env.store.all('SELECT response FROM commands').every((r) => !r.response.includes('Deep body')));
});

test('SQL query includes Chinese, Latin/numbers, tag AND and exact type/favorite; aggregates before pagination', async (t) => {
    const env = await fixture(t);
    for (let c = 0; c < 4; c++)
        create(
            env,
            `栏目${c}`,
            Array.from({ length: 80 }, (_, i) => material(i)),
        );
    assert.equal(page(env.store).total, 80);
    const all = [];
    for (let n = 1; n <= 4; n++) {
        const result = page(env.store, { page: String(n) });
        assert.equal(result.items.length, 20);
        all.push(...result.items.map((r) => r.source.uid));
        assert.ok(result.items.every((row) => row.memberCount === 4 && !('description' in row)));
        assert.ok(Buffer.byteLength(JSON.stringify(result)) < LIMITS.maxResponseBytes);
    }
    assert.equal(new Set(all).size, 80);
    assert.deepEqual(page(env.store).items, page(env.store).items);
    assert.equal(page(env.store, { q: '中文' }).total, 80);
    assert.equal(page(env.store, { q: 'deep BODY 79' }).total, 1);
    assert.equal(page(env.store, { q: 'Material 27' }).items[0].source.uid, 27);
    const tags = JSON.stringify(['甲', '乙']);
    assert.equal(page(env.store, { tags }).total, 40);
    assert.equal(page(env.store, { tags, type: '规则' }).total, 0);
    assert.equal(page(env.store, { tags, type: '角色', favorite: 'true' }).total, 13);
    const latin = create(env, 'Latin', [
        material(900, {
            name: 'ÉCHO ABC123',
            materialType: ' WÉAPON ',
            tags: [' DrÁGon ', '甲'],
        }),
    ]);
    assert.equal(
        page(env.store, {
            columnId: latin.id,
            type: 'wéapon',
            tags: JSON.stringify(['drágon', '甲']),
            q: '  écho abc123  ',
        }).total,
        1,
    );
    assert.throws(() => query({ tags: '["甲","甲"]' }), {
        code: 'WORLDBOOK_VALIDATION',
    });
    assert.throws(() => query({ q: 'x'.repeat(161) }), {
        code: 'WORLDBOOK_VALIDATION',
    });
    assert.throws(() => query({ sort: 'unsupported' }), {
        code: 'WORLDBOOK_VALIDATION',
    });
});

test('tree pages are lightweight, parent-before-child and revision-bound; a folder is expanded without N+1 reads', async (t) => {
    const env = await fixture(t),
        col = create(
            env,
            '大栏目',
            Array.from({ length: 100 }, (_, i) => material(i, { description: '私有正文'.repeat(1000) })),
        );
    const first = env.store.tree(col.id);
    assert.equal(first.items.length, 50);
    assert.ok(first.nextCursor);
    assert.ok(first.items.every((row) => !('description' in row) && !('summary' in row)));
    const [stamp, offset] = first.nextCursor.split(':').map(Number);
    const second = env.store.tree(col.id, { stamp, offset });
    assert.equal(second.items.length, 50);
    assert.equal(first.items[0].kind, 'folder');
    const seen = new Set(first.items.map((row) => row.id));
    assert.ok(second.items.every((row) => seen.has(row.parentId)));
    const row = page(env.store, { columnId: col.id }).items[0];
    env.send('material-update', {
        id: row.id,
        revision: row.revision,
        fields: { name: '新名称' },
    });
    assert.throws(() => env.store.tree(col.id, { stamp, offset }), {
        code: 'WORLDBOOK_TREE_CHANGED',
    });
    assert.ok(Buffer.byteLength(JSON.stringify(first)) < LIMITS.maxResponseBytes);
});

test('folder lift preserves Materials, recursive delete is atomic and cycles/depth overflow fail closed', async (t) => {
    const env = await fixture(t),
        col = create(env),
        folder = env.send('folder-create', {
            columnId: col.id,
            parentId: null,
            name: '组',
            structureRevision: col.structureRevision,
        });
    const created = env.send('material-create', {
        columnId: col.id,
        parentId: folder.folderId,
        structureRevision: env.store.column(col.id).structure_revision,
        material: material(1),
    });
    const row = env.store.one('SELECT * FROM folders WHERE id=?', folder.folderId);
    env.send('folder-delete', {
        id: folder.folderId,
        revision: row.revision,
        structureRevision: env.store.column(col.id).structure_revision,
        deleteContents: false,
    });
    assert.equal(env.store.detail(created.id).material.parentId, null);
    let parent = null,
        root;
    for (let n = 0; n < 16; n++) {
        const next = env.send('folder-create', {
            columnId: col.id,
            parentId: parent,
            name: `深度${n}`,
            structureRevision: env.store.column(col.id).structure_revision,
        });
        root ??= next.folderId;
        parent = next.folderId;
    }
    assert.throws(
        () =>
            env.send('folder-create', {
                columnId: col.id,
                parentId: parent,
                name: '过深',
                structureRevision: env.store.column(col.id).structure_revision,
            }),
        { code: 'WORLDBOOK_VALIDATION' },
    );
    assert.throws(
        () =>
            env.send('folder-move', {
                id: root,
                revision: 1,
                structureRevision: env.store.column(col.id).structure_revision,
                parentId: parent,
            }),
        { code: 'WORLDBOOK_VALIDATION' },
    );
    env.send('folder-delete', {
        id: root,
        revision: 1,
        structureRevision: env.store.column(col.id).structure_revision,
        deleteContents: true,
    });
    assert.equal(env.store.one('SELECT COUNT(*) n FROM folders').n, 0);
    assert.ok(env.store.detail(created.id));
});

test('atomic failed import rolls back Column, Source and Material; explicit source/native-field validation', async (t) => {
    const env = await fixture(t);
    const before = env.store.summary().total;
    assert.throws(() => create(env, '不完整', [material(1), { name: '没有来源' }]), { code: 'WORLDBOOK_VALIDATION' });
    assert.equal(env.store.summary().total, before);
    assert.equal(env.store.one('SELECT COUNT(*) n FROM sources').n, 0);
    assert.throws(() => create(env, '原生字段', [{ ...material(1), enabled: true }]), { code: 'WORLDBOOK_VALIDATION' });
    const original = env.store.insertMaterial.bind(env.store);
    let count = 0;
    env.store.insertMaterial = (...args) => {
        if (++count === 2) throw new Error('simulated disk failure');
        return original(...args);
    };
    assert.throws(() => create(env, '中途失败', [material(1), material(2)]), /simulated/);
    assert.equal(env.store.summary().total, before);
    assert.equal(env.store.one('SELECT COUNT(*) n FROM materials').n, 0);
    assert.equal(env.store.one('SELECT COUNT(*) n FROM sources').n, 0);
});

test('runtime query batches are temporary, isolated, bounded and intersect the full SQL query before grouping', async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), 'ttb-wb-service-'));
    let clock = Date.now();
    const service = createWorldbook(
        { policy: { core: { allowedOrigins: ['https://example.invalid'] } } },
        { now: () => clock },
    );
    await service.definition.initialize();
    t.after(async () => {
        await service.definition.shutdown();
        await rm(root, { recursive: true, force: true });
    });
    const a = { userRoot: path.join(root, 'a'), contextId: 'a' },
        b = { userRoot: path.join(root, 'b'), contextId: 'b' };
    await service.command(a, {
        commandId: token(),
        action: 'column-create',
        data: {
            profile: profile('A'),
            materials: Array.from({ length: 80 }, (_, i) => material(i)),
        },
    });
    const session = await service.runtime(a, {
        offset: 0,
        bindings: Array.from({ length: 80 }, (_, i) => ({
            locator: '非 Active 书',
            uid: i,
        })),
        complete: true,
    });
    const result = await service.read(a, 'catalog', query({ runtimeToken: session.token }));
    assert.equal(result.total, 80);
    assert.equal(result.items.length, 20);
    const earlier = await service.runtime(a, {
        token: session.token,
        offset: 0,
        bindings: [{ locator: '非 Active 书', uid: 0 }],
        complete: false,
    });
    assert.equal(earlier.complete, true);
    assert.equal((await service.read(a, 'catalog', query({ runtimeToken: session.token }))).total, 80);
    const empty = await service.runtime(a, {
        offset: 0,
        bindings: [],
        complete: true,
    });
    assert.equal(
        (
            await service.runtime(a, {
                token: empty.token,
                offset: 0,
                bindings: [],
                complete: true,
            })
        ).complete,
        true,
    );
    assert.equal((await service.read(b, 'catalog', query({}))).total, 0);
    await assert.rejects(service.read(b, 'catalog', query({ runtimeToken: session.token })), {
        code: 'WORLDBOOK_RUNTIME_EXPIRED',
    });
    clock += LIMITS.runtimeTtlMs + 1;
    await assert.rejects(service.read(a, 'catalog', query({ runtimeToken: session.token })), {
        code: 'WORLDBOOK_RUNTIME_EXPIRED',
    });
    assert.equal((await service.store(a)).all("SELECT name FROM sqlite_master WHERE name LIKE '%runtime%'").length, 0);
    const caps = service.definition.capabilities[0];
    assert.equal(caps.id, 'worldbook.core');
    assert.equal(caps.operationAvailability().command.available, true);
});

test('unreferenced Sources are cleaned transactionally; shared references and uncertain-command receipts remain valid', async (t) => {
    const env = await fixture(t),
        col = create(env, 'A', [material(1), material(2)]);
    const [a, b] = page(env.store, { columnId: col.id }).items;
    const sourceId = a.source.sourceId;
    env.send('binding-rebind', {
        id: a.id,
        bindingRevision: a.bindingRevision,
        source: { locator: 'B', uid: 1, title: 'B' },
    });
    assert.ok(env.store.one('SELECT id FROM sources WHERE id=?', sourceId), 'shared original Source survives');
    const commandId = token();
    const removed = env.send(
        'material-delete',
        { id: b.id, revision: 1, structureRevision: col.structureRevision },
        commandId,
    );
    assert.deepEqual(removed.sourceIdsRemoved, [sourceId]);
    assert.equal(env.store.one('SELECT id FROM sources WHERE id=?', sourceId), undefined);
    env.store.close();
    await env.store.initialize();
    assert.equal(
        env.send('material-delete', { id: b.id, revision: 1, structureRevision: col.structureRevision }, commandId)
            .replayed,
        true,
    );
    for (let i = 0; i < 270; i++) {
        const current = env.store.detail(a.id).material;
        env.send('binding-rebind', {
            id: a.id,
            bindingRevision: current.bindingRevision,
            source: { locator: `替换 ${i}`, uid: 1, title: '选中条目' },
        });
        assert.equal(env.store.one('SELECT COUNT(*) n FROM sources').n, 1);
    }
    const current = env.store.detail(a.id);
    env.send('column-delete', {
        id: col.id,
        revision: current.column.revision,
        structureRevision: current.column.structureRevision,
    });
    assert.equal(env.store.one('SELECT COUNT(*) n FROM sources').n, 0);
});

test('Source capacity checks the final referenced set, allowing replacement at capacity and rolling back overflow', async (t) => {
    const env = await fixture(t);
    for (let offset = 0; offset < LIMITS.maxSources; offset += 100) {
        create(
            env,
            String(offset),
            Array.from({ length: Math.min(100, LIMITS.maxSources - offset) }, (_, i) =>
                material(offset + i, {
                    source: {
                        locator: `书 ${offset + i}`,
                        uid: 1,
                        title: 'Entry',
                    },
                }),
            ),
        );
    }
    const row = page(env.store).items[0];
    const saved = env.send('binding-rebind', {
        id: row.id,
        bindingRevision: row.bindingRevision,
        source: { locator: '替换书', uid: 1, title: 'Entry' },
    });
    assert.equal(saved.sourcesAdded.length, 1);
    assert.equal(saved.sourceIdsRemoved.length, 1);
    assert.equal(env.store.one('SELECT COUNT(*) n FROM sources').n, LIMITS.maxSources);
    const before = env.store.summary().columns.find((c) => c.id === row.columnId);
    assert.throws(
        () =>
            env.send('material-create', {
                columnId: row.columnId,
                parentId: null,
                structureRevision: before.structureRevision,
                material: material(999, {
                    source: { locator: '超出书', uid: 1, title: 'Entry' },
                }),
            }),
        { code: 'WORLDBOOK_CAPACITY' },
    );
    assert.equal(env.store.one('SELECT COUNT(*) n FROM sources').n, LIMITS.maxSources);
    assert.equal(env.store.one('SELECT id FROM sources WHERE locator=?', '超出书'), undefined);
    assert.equal(page(env.store).total, LIMITS.maxSources);
    assert.deepEqual(env.store.columnView(env.store.column(row.columnId)), before);
});

test('custom import title preserves Source folder name; tags retain entered order across update, copy and restart', async (t) => {
    const env = await fixture(t);
    const col = env.send('column-create', {
        profile: profile('命运编织'),
        importFolderName: 'B',
        materials: [
            material(1, {
                tags: ['Z', 'A', 'M'],
                source: { locator: 'B', uid: 1, title: 'B Entry' },
            }),
        ],
    }).column;
    let row = page(env.store, { columnId: col.id }).items[0];
    assert.equal(env.store.tree(col.id).items[0].name, 'B');
    assert.equal(col.title, '命运编织');
    assert.deepEqual(row.tags, ['Z', 'A', 'M']);
    env.send('material-update', {
        id: row.id,
        revision: row.revision,
        fields: { tags: ['M', 'Z', 'A'] },
    });
    row = env.store.detail(row.id).material;
    const copy = env.send('material-copy', {
        id: row.id,
        revision: row.revision,
        structureRevision: col.structureRevision,
        columnId: col.id,
        parentId: null,
        targetStructureRevision: col.structureRevision,
    });
    env.store.close();
    await env.store.initialize();
    assert.deepEqual(
        page(env.store, { columnId: col.id }).items.map((item) => item.tags),
        [
            ['M', 'Z', 'A'],
            ['M', 'Z', 'A'],
        ],
    );
    assert.deepEqual(env.store.detail(copy.id).material.tags, ['M', 'Z', 'A']);
    assert.equal(
        page(env.store, { tags: JSON.stringify(['a', 'z']) }).total,
        1,
        'filtering/grouping is independent of presentation order',
    );
});

test('earlier v1 candidate tag table upgrades additively without changing business identities or restarting user data', async (t) => {
    const env = await fixture(t),
        col = create(env, '旧候选', [material(1, { tags: ['Z', 'A', 'M'] })]);
    const row = page(env.store).items[0];
    env.store.db.exec(
        'DROP TABLE tags; CREATE TABLE tags(material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,tag TEXT NOT NULL,PRIMARY KEY(material_id,tag)); CREATE INDEX tag_value ON tags(wb_fold(tag),material_id)',
    );
    for (const tag of ['Z', 'A', 'M']) env.store.run('INSERT INTO tags VALUES(?,?)', row.id, tag);
    env.store.close();
    await env.store.initialize();
    assert.equal(env.store.one('PRAGMA user_version').user_version, 2);
    assert.equal(env.store.detail(row.id).column.id, col.id);
    assert.equal(env.store.detail(row.id).material.source.sourceId, row.source.sourceId);
    assert.deepEqual(
        env.store.detail(row.id).material.tags,
        ['A', 'M', 'Z'],
        'old candidate observed order is retained',
    );
    env.send('material-update', {
        id: row.id,
        revision: row.revision,
        fields: { tags: ['Z', 'A', 'M'] },
    });
    env.store.close();
    await env.store.initialize();
    assert.deepEqual(env.store.detail(row.id).material.tags, ['Z', 'A', 'M']);
    assert.equal(env.store.detail(row.id).material.description, '详细内容 Deep body 1');
});
