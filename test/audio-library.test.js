import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { createAudioLibrary } from '../src/audio-library/store.js';
import { createAudioSources } from '../src/audio-sources/store.js';
import { validatePolicy } from '../src/config.js';
import { coordinateAudio } from '../src/audio-assets/coordination.js';

async function harness(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'ttb-library-'));
  const config = { policy: validatePolicy({ schemaVersion: 1, core: { allowedOrigins: ['https://example.com'] } }) };
  const sources = createAudioSources(config, {}); await sources.definition.initialize();
  const library = createAudioLibrary(config, sources.assets); await library.definition.initialize();
  const alice = { userRoot: path.join(root, 'alice'), contextId: 'alice' }, bob = { userRoot: path.join(root, 'bob'), contextId: 'bob' };
  t.after(async () => { await library.definition.shutdown(); await sources.definition.shutdown(); await rm(root, { recursive: true, force: true }); });
  async function asset(context = alice, n = 0) {
    const store = await sources.assets.store(context), id = randomBytes(24).toString('base64url'), bytes = Buffer.alloc(64, n % 255);
    await writeFile(store.file(id), bytes);
    store.db.prepare("INSERT INTO assets VALUES (?, ?, 'audio/mpeg', ?, 1, 'ready', 'healthy', NULL)").run(id, createHash('sha256').update(id).digest('hex'), bytes.length);
    return id;
  }
  return { root, config, sources, library, alice, bob, asset };
}
const change = (row, patch = {}) => ({ revision: row.revision, displayTitle: row.displayTitle, category: row.category, libraryVisibility: row.libraryVisibility, ...patch });

test('legacy Assets automatically appear once, default names need no migration, music metadata is per-user and survives restart', async t => {
  const h = await harness(t), id = await h.asset();
  const first = await h.library.list(h.alice); assert.equal(first.total, 1); assert.equal(first.items[0].displayTitle, '未命名音频');
  assert.equal(first.items[0].category, null); assert.equal(first.items[0].revision, 0);
  const a = (await h.sources.create(h.alice, 'https://audio.example.com/a.mp3')).source;
  const b = (await h.sources.create(h.alice, 'https://audio.example.com/b.mp3')).source;
  await h.sources.backend(h.alice, a.sourceId, 0, 'remote');
  // Two existing Source bindings do not add music rows or become library identity.
  const sourceRoot = path.join(h.alice.userRoot, 'tavern-toolbox-server/audio-sources-v1/sources.sqlite');
  const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(sourceRoot);
  db.prepare('UPDATE sources SET local_asset_id=?').run(id); db.close();
  assert.equal((await h.library.list(h.alice)).total, 1);
  await assert.rejects(h.library.read(h.bob, id), { code: 'AUDIO_ASSET_NOT_FOUND' });
  assert.equal((await h.library.list(h.bob)).total, 0);
  const automatic = await h.library.observe(h.alice, id, 'green to blue');
  assert.equal((await h.library.observe(h.alice, id, '治愈')).displayTitle, 'green to blue');
  const renamed = await h.library.update(h.alice, id, change(automatic, { displayTitle: '夜晚治愈' }));
  assert.equal(renamed.titleSource, 'user'); assert.equal((await h.library.observe(h.alice, id, 'Green To Blue')).displayTitle, '夜晚治愈');
  await h.library.definition.shutdown();
  const reopened = createAudioLibrary(h.config, h.sources.assets); await reopened.definition.initialize(); t.after(() => reopened.definition.shutdown());
  assert.equal((await reopened.read(h.alice, id)).displayTitle, '夜晚治愈');
  assert.equal((await h.sources.read(h.alice, a.sourceId)).localAssetId, id); assert.equal((await h.sources.read(h.alice, b.sourceId)).localAssetId, id);
});

test('two devices use CAS; categories/visibility cannot overwrite user titles; deleting category atomically resets songs and rejects old row revisions', async t => {
  const h = await harness(t), id = await h.asset(), row = await h.library.read(h.alice, id);
  const edits = await Promise.allSettled([h.library.update(h.alice, id, change(row, { displayTitle: '用户标题' })), h.library.update(h.alice, id, change(row, { displayTitle: '旧设备' }))]);
  assert.equal(edits.filter(e => e.status === 'fulfilled').length, 1); assert.equal(edits.find(e => e.status === 'rejected').reason.code, 'AUDIO_LIBRARY_CONFLICT');
  const created = await h.library.category(h.alice, { operation: 'create', revision: 0, name: '治愈' });
  await assert.rejects(h.library.category(h.alice, { operation: 'create', revision: 0, name: '战斗' }), { code: 'AUDIO_LIBRARY_CONFLICT' });
  const categoryId = created.categories[0].categoryId;
  const inCategory = await h.library.update(h.alice, id, change(await h.library.read(h.alice, id), { category: categoryId }));
  await h.library.category(h.alice, { operation: 'rename', revision: created.revision, categoryId, name: '治愈日常' });
  assert.equal((await h.library.list(h.alice, { category: categoryId })).total, 1);
  await h.library.category(h.alice, { operation: 'delete', revision: created.revision + 1, categoryId });
  const current = await h.library.read(h.alice, id); assert.equal(current.category, null); assert.equal(current.displayTitle, '用户标题');
  assert.equal(current.revision, inCategory.revision + 1);
  await assert.rejects(h.library.update(h.alice, id, change(inCategory)), { code: 'AUDIO_LIBRARY_CONFLICT' });
  assert.equal((await h.sources.assets.read(h.alice, id)).health, 'healthy');
});

test('visibility and Asset health control playback eligibility; orphan semantics and deleting Asset clean product metadata', async t => {
  const h = await harness(t), id = await h.asset(); await h.library.observe(h.alice, id, '雨声');
  const row = await h.library.read(h.alice, id);
  await h.library.update(h.alice, id, change(row, { libraryVisibility: 'hidden' }));
  assert.equal((await h.library.list(h.alice)).total, 0); assert.equal((await h.library.list(h.alice, { hidden: 'true' })).items[0].displayTitle, '雨声');
  assert.equal((await h.sources.assets.read(h.alice, id)).referenceCount, 0);
  await h.library.update(h.alice, id, change(await h.library.read(h.alice, id), { libraryVisibility: 'visible' }));
  assert.equal((await h.library.list(h.alice)).total, 1);
  const store = await h.sources.assets.store(h.alice); await unlink(store.file(id));
  assert.equal((await h.library.list(h.alice)).total, 0); assert.equal((await h.library.list(h.alice, { hidden: 'true' })).items[0].health, 'missing');
  await h.sources.assets.cleanup(h.alice, [id]); assert.equal((await h.library.list(h.alice, { hidden: 'true' })).total, 0);
  const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(path.join(h.alice.userRoot, 'tavern-toolbox-server/audio-library-v1/library.sqlite'));
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n, 0); db.close();
});

test('230-track category is complete across bounded pages, natural title sorting has stable tie order and cursor rejects concurrent edits', async t => {
  const h = await harness(t); const created = await h.library.category(h.alice, { operation: 'create', revision: 0, name: '播放池' }), category = created.categories[0].categoryId;
  for (let n = 230; n > 0; n--) { const id = await h.asset(h.alice, n); await h.library.update(h.alice, id, change(await h.library.read(h.alice, id), { displayTitle: '曲目 ' + n, category })); }
  const first = await h.library.list(h.alice, { category }); assert.equal(first.items.length, 50); assert.equal(first.items[0].displayTitle, '曲目 1');
  const all = [...first.items]; let cursor = first.nextCursor;
  while (cursor) { const page = await h.library.list(h.alice, { category, cursor }); all.push(...page.items); cursor = page.nextCursor; }
  assert.equal(all.length, 230); assert.equal(new Set(all.map(row => row.assetId)).size, 230); assert.equal(all.at(-1).displayTitle, '曲目 230');
  assert.equal((await h.library.list(h.alice, { category, search: '230' })).total, 1);
  assert.equal((await h.library.list(h.alice, { category })).total, 230);
  await h.library.update(h.alice, all[0].assetId, change(all[0], { displayTitle: '新标题' }));
  await assert.rejects(h.library.list(h.alice, { category, cursor: first.nextCursor }), { code: 'AUDIO_LIBRARY_CONFLICT' });
});

test('Audio deletion and metadata edit share the user coordinator: no suspended records or retention lock', async t => {
  const h = await harness(t), id = await h.asset(), row = await h.library.read(h.alice, id);
  let unlock; const hold = new Promise(resolve => { unlock = resolve; }); const held = coordinateAudio(h.alice.userRoot, () => hold);
  const removal = h.sources.assets.remove(h.alice, id), edit = h.library.update(h.alice, id, change(row, { displayTitle: '迟到编辑' }));
  unlock(); await held; await removal; await assert.rejects(edit, { code: 'AUDIO_ASSET_NOT_FOUND' });
  assert.equal((await h.library.list(h.alice, { hidden: 'true' })).total, 0);
});

test('native Library controls require authenticated user, exact context/protocol, Origin/CSRF and bounded bodies; responses/logs contain no private paths or titles', async t => {
  const { default: express } = await import('express'), { once } = await import('node:events'), { createCore } = await import('../src/core.js');
  const root = await mkdtemp(path.join(tmpdir(), 'ttb-library-http-')); t.after(() => rm(root, { recursive: true, force: true }));
  const logs = [], origin = 'https://example.com';
  const core = await createCore({ logger: { info: item => logs.push(item) }, policyOptions: { configPath: '/fixture', read: async () => JSON.stringify({ schemaVersion: 1, core: { allowedOrigins: [origin] } }) } }); t.after(() => core.shutdown());
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { const user = req.headers['x-test-user']; if (user) req.user = { profile: { handle: user, enabled: true }, directories: { root: path.join(root, user) } }; req.session = { csrfToken: 'fixture' }; next(); });
  const router = express.Router(); core.attach(router); app.use('/api/plugins/tavern-toolbox-server', router);
  const listener = app.listen(0, '127.0.0.1'); await once(listener, 'listening'); t.after(() => { listener.closeAllConnections(); return new Promise(resolve => listener.close(resolve)); });
  const base = `http://127.0.0.1:${listener.address().port}/api/plugins/tavern-toolbox-server`, contexts = {};
  for (const user of ['alice', 'bob']) contexts[user] = (await (await fetch(base + '/v1/status', { headers: { 'X-Test-User': user, 'X-TTB-Protocol': '1.0' } })).json()).data.contextId;
  async function call(route, body, user = 'alice', extra = {}) { const response = await fetch(base + route, { method: body ? 'POST' : 'GET', headers: { 'X-Test-User': user, 'X-TTB-Protocol': '1.0', 'X-TTB-Context': contexts[user], 'X-CSRF-Token': 'fixture', Origin: origin, 'Content-Type': 'application/json', ...extra }, ...(body ? { body: JSON.stringify(body) } : {}) }); return { status: response.status, value: await response.json(), headers: response.headers }; }
  const list = await call('/v1/audio/library'); assert.equal(list.status, 200); assert.equal(list.value.data.total, 0); assert.match(list.headers.get('cache-control'), /no-store/);
  assert.equal((await call('/v1/audio/library/playback-pool')).value.data.total, 0);
  assert.equal((await call('/v1/audio/library/playback-pool?search=x')).status, 400);
  assert.equal((await call('/v1/audio/library/playback-pool', undefined, 'alice', { 'X-TTB-Context': contexts.bob })).status, 409);
  assert.equal((await call('/v1/audio/library/playback-pool', undefined, 'alice', { 'X-Test-User': '' })).status, 403);
  const body = { operation: 'create', revision: 0, name: '音乐分类' };
  assert.equal((await call('/v1/audio/library/categories', body, 'alice', { Origin: 'https://other.example.com' })).status, 403);
  assert.equal((await call('/v1/audio/library/categories', body, 'alice', { 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await call('/v1/audio/library/categories', body, 'alice', { 'X-TTB-Context': contexts.bob })).status, 409);
  assert.equal((await call('/v1/audio/library/categories', body, 'alice', { 'X-TTB-Protocol': '2.0' })).status, 409);
  assert.equal((await call('/v1/audio/library/categories', { ...body, unwanted: true })).status, 400);
  const created = await call('/v1/audio/library/categories', body); assert.equal(created.status, 200);
  assert.equal((await call('/v1/audio/library/categories', body)).value.error.code, 'AUDIO_LIBRARY_CONFLICT');
  assert.equal((await call('/v1/audio/library/categories', undefined, 'bob')).value.data.categories.length, 0);
  assert.equal((await call('/v1/audio/library', undefined, 'alice', { 'X-Test-User': '' })).status, 403);
  assert.equal((await call('/v1/audio/library?hidden=maybe')).status, 400);
  const publicData = JSON.stringify(created.value); assert(!publicData.includes(root)); assert(!JSON.stringify(logs).includes('音乐分类'));
});

test('complete playback pool checks N files once instead of N times every page; results and live health remain authoritative', async t => {
  const h = await harness(t), count = 1000;
  for (let n = 0; n < count; n++) await h.asset(h.alice, n);
  const store = await h.sources.assets.store(h.alice), quick = store.quick.bind(store); let checks = 0;
  store.quick = row => { checks++; return quick(row); };
  const expected = []; let cursor;
  do { const page = await h.library.list(h.alice, cursor ? { cursor } : {}); expected.push(...page.items); cursor = page.nextCursor; } while (cursor);
  assert.equal(checks, 20000); checks = 0;
  const pool = await h.library.playbackPool(h.alice, { category: 'all' });
  assert.equal(checks, count); assert.equal(pool.total, count); assert.equal(pool.nextCursor, null); assert.deepEqual(pool.items, expected);
  assert.equal((await h.library.playbackPool(h.bob)).total, 0);
  const first = pool.items[0]; await h.library.update(h.alice, first.assetId, change(first, { libraryVisibility: 'hidden' }));
  await unlink(store.file(pool.items[1].assetId));
  const fresh = await h.library.playbackPool(h.alice); assert.equal(fresh.total, count - 2);
  assert(!fresh.items.some(row => [first.assetId, pool.items[1].assetId].includes(row.assetId)));
  assert.notEqual(fresh.snapshot, pool.snapshot);
  for (const query of [{ search: 'x' }, { hidden: 'true' }, { cursor: '50~' + pool.snapshot }])
    await assert.rejects(h.library.playbackPool(h.alice, query), { code: 'INVALID_REQUEST' });
});

test('playback pool category scope and edits use the same coordinator, without retaining deleted Assets', async t => {
  const h = await harness(t), a = await h.asset(), b = await h.asset();
  const categories = await h.library.category(h.alice, { operation: 'create', revision: 0, name: '分类' });
  const category = categories.categories[0].categoryId;
  await h.library.update(h.alice, a, change(await h.library.read(h.alice, a), { category }));
  assert.deepEqual((await h.library.playbackPool(h.alice, { category })).items.map(row => row.assetId), [a]);
  assert.deepEqual((await h.library.playbackPool(h.alice, { category: 'uncategorized' })).items.map(row => row.assetId), [b]);
  let unlock; const hold = coordinateAudio(h.alice.userRoot, () => new Promise(resolve => { unlock = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const removal = h.sources.assets.remove(h.alice, a), pool = h.library.playbackPool(h.alice, { category });
  unlock(); await hold; await removal; assert.equal((await pool).total, 0);
});
