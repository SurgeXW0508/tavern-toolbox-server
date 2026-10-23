import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { DatabaseSync } from 'node:sqlite';
import { createWorldbook } from '../src/worldbook/index.js';
import { WorldbookStore } from '../src/worldbook/store.js';
import { createMedia } from '../src/media/index.js';
import { createGovernance } from '../src/governance/index.js';
import { createReferenceCoordinator } from '../src/governance/coordination.js';
import { loadPolicy } from '../src/config.js';
import { createBusiness } from '../src/business/index.js';
const token = () => `${Date.now()}-${randomUUID()}`;
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'ttb-wb-media-')),
    otherRoot = await mkdtemp(path.join(tmpdir(), 'ttb-wb-media-other-'));
  const context = { userRoot: root, contextId: 'fixture' },
    other = { userRoot: otherRoot, contextId: 'other' };
  const config = await loadPolicy(),
    coordinate = createReferenceCoordinator();
  const media = createMedia(config, {
    definition: { health: () => ({ state: 'disabled' }) },
  });
  await media.definition.initialize();
  const worldbook = createWorldbook(config, { media, coordinate });
  await worldbook.definition.initialize();
  const governance = createGovernance(media, coordinate);
  governance.register(worldbook.referenceProvider);
  t.after(async () => {
    await worldbook.definition.shutdown();
    await media.definition.shutdown();
    await rm(root, { recursive: true, force: true });
    await rm(otherRoot, { recursive: true, force: true });
  });
  const store = await worldbook.store(context);
  const core = (action, data) =>
    worldbook.command(context, { commandId: token(), action, data });
  await core('column-create', {
    profile: {
      title: '资料',
      description: '',
      icon: { type: 'builtin', value: 'book' },
      accent: '#112233',
    },
    materials: [1, 2].map((uid) => ({
      name: `资料${uid}`,
      description: '原描述',
      source: { locator: '书', uid, title: `Entry${uid}` },
    })),
  });
  const rows = store.catalog({ page: 1, tags: [] }).items;
  const command = (action, data, commandId = token()) =>
    worldbook.mediaCommand(context, { commandId, action, data });
  let color = 0;
  const image = async (owner = context) => {
    const bytes = await sharp({
      create: {
        width: 8,
        height: 6,
        channels: 3,
        background: { r: ++color, g: 50, b: 150 },
      },
    })
      .png()
      .toBuffer();
    return media.importBytes(owner, bytes, 'image/png');
  };
  return {
    root,
    context,
    other,
    media,
    worldbook,
    governance,
    coordinate,
    store,
    rows,
    core,
    command,
    image,
  };
}

test('Schema 2 to 3 is atomic and preserves every 10C aggregate, failure leaves v2 untouched; unknown schema fails closed', async (t) => {
  const f = await fixture(t),
    [a, b] = f.rows;
  await f.core('companions-save', { id: a.id, revision: 1, memberIds: [b.id] });
  const preset = await f.core('preset-create', {
    name: '原方案',
    columnId: null,
    memberIds: [a.id],
  });
  await f.core('usage-increment', { materialIds: [a.id], at: Date.now() });
  const original = f.store.detail(a.id),
    originalPreset = f.store.features.read({
      kind: 'presets',
      id: preset.presetId,
    });
  f.store.db.exec(
    'DROP TRIGGER wb_media_material_insert;DROP TABLE wb_media;DROP TABLE wb_media_versions;PRAGMA user_version=2;',
  );
  f.store.close();
  class Interrupted extends DatabaseSync {
    exec(sql) {
      if (sql.includes('CREATE TABLE wb_media(')) {
        super.exec('BEGIN IMMEDIATE;CREATE TABLE interrupted(n);');
        throw Error('interrupted migration');
      }
      return super.exec(sql);
    }
  }
  await assert.rejects(
    new WorldbookStore(f.root, Interrupted).initialize(),
    /interrupted migration/,
  );
  const file = path.join(
      f.root,
      'tavern-toolbox-server/worldbook-v1/worldbook.sqlite',
    ),
    db = new DatabaseSync(file);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE name='interrupted'").get(),
    undefined,
  );
  db.close();
  await f.store.initialize();
  assert.equal(f.store.one('PRAGMA user_version').user_version, 3);
  assert.deepEqual(f.store.detail(a.id), original);
  assert.deepEqual(
    f.store.features.read({ kind: 'presets', id: preset.presetId }),
    originalPreset,
  );
  assert.deepEqual(f.store.media.read(a.id), {
    id: a.id,
    revision: 1,
    cover: null,
    gallery: [],
  });
});

test('one Cover / six Gallery, uniqueness, ordering and explicit role moves persist after restart; unlink never deletes Asset', async (t) => {
  const f = await fixture(t),
    id = f.rows[0].id,
    assets = [];
  for (let n = 0; n < 7; n++) assets.push(await f.image());
  let result = await f.command('media-set-cover', {
    id,
    revision: 1,
    kind: 'image',
    mediaRef: assets[0].mediaRef,
  });
  result = await f.command('media-gallery-add', {
    id,
    revision: result.media.revision,
    items: assets
      .slice(1)
      .map((a) => ({ kind: 'image', mediaRef: a.mediaRef })),
  });
  await assert.rejects(
    f.command('media-to-gallery', { id, revision: result.media.revision }),
    { code: 'WORLDBOOK_CAPACITY' },
  );
  await assert.rejects(
    f.command('media-gallery-add', {
      id,
      revision: result.media.revision,
      items: [{ kind: 'image', mediaRef: assets[0].mediaRef }],
    }),
  );
  result = await f.command('media-to-cover', {
    id,
    revision: result.media.revision,
    assetId: assets[1].mediaRef.assetId,
  });
  assert.equal(result.media.gallery.length, 5);
  assert.equal(result.media.cover.mediaRef.assetId, assets[1].mediaRef.assetId);
  result = await f.command('media-to-gallery', {
    id,
    revision: result.media.revision,
  });
  assert.equal(result.media.cover, null);
  assert.equal(result.media.gallery.length, 6);
  const reversed = result.media.gallery
    .map((a) => a.mediaRef.assetId)
    .reverse();
  result = await f.command('media-gallery-reorder', {
    id,
    revision: result.media.revision,
    assetIds: reversed,
  });
  f.store.close();
  await f.store.initialize();
  assert.deepEqual(f.store.media.read(id), result.media);
  assert.deepEqual(
    f.store.media.read(id).gallery.map((a) => a.mediaRef.assetId),
    reversed,
  );
  assert.equal((await f.media.catalog(f.context)).length, 7);
});

test('Media CAS is independent of Metadata and Binding; same aggregate conflicts and command replay is exact', async (t) => {
  const f = await fixture(t),
    a = f.rows[0],
    asset = await f.image();
  const commandId = token(),
    data = { id: a.id, revision: 1, kind: 'image', mediaRef: asset.mediaRef };
  await f.command('media-set-cover', data, commandId);
  await f.core('material-update', {
    id: a.id,
    revision: a.revision,
    fields: { description: 'PC draft' },
  });
  await f.core('binding-rebind', {
    id: a.id,
    bindingRevision: a.bindingRevision,
    source: { locator: '新书', uid: 7, title: '新条目' },
  });
  const detail = f.store.detail(a.id).material;
  assert.equal(detail.description, 'PC draft');
  assert.equal(detail.bindingRevision, a.bindingRevision + 1);
  await assert.rejects(
    f.command('media-clear-cover', { id: a.id, revision: 1 }),
    { code: 'WORLDBOOK_MEDIA_CONFLICT' },
  );
  const replay = await f.command('media-set-cover', data, commandId);
  assert.equal(replay.replayed, true);
  assert.equal(f.store.media.read(a.id).revision, 2);
  await assert.rejects(
    f.command('media-clear-cover', { id: a.id, revision: 1 }, commandId),
    { code: 'WORLDBOOK_IDEMPOTENCY_MISMATCH' },
  );
  await assert.rejects(f.core('media-clear-cover', { id: a.id, revision: 2 }), {
    code: 'WORLDBOOK_VALIDATION',
  });
});

test('new relations validate canonical identity, kind, current-user ownership and Original health, never trusting a UUID', async (t) => {
  const f = await fixture(t),
    id = f.rows[0].id,
    asset = await f.image(),
    other = await f.image(f.other);
  for (const mediaRef of [
    { provider: 'local', assetId: asset.mediaRef.assetId },
    { provider: 'server', assetId: 'file:///NAS' },
    { ...asset.mediaRef, url: 'http://bad' },
  ])
    await assert.rejects(
      f.command('media-set-cover', {
        id,
        revision: 1,
        kind: 'image',
        mediaRef,
      }),
      { code: 'WORLDBOOK_VALIDATION' },
    );
  await assert.rejects(
    f.command('media-set-cover', {
      id,
      revision: 1,
      kind: 'video',
      mediaRef: asset.mediaRef,
    }),
    { code: 'WORLDBOOK_VALIDATION' },
  );
  for (const mediaRef of [
    other.mediaRef,
    { provider: 'server', assetId: randomUUID() },
  ])
    await assert.rejects(
      f.command('media-set-cover', {
        id,
        revision: 1,
        kind: 'image',
        mediaRef,
      }),
      { code: 'WORLDBOOK_MEDIA_UNAVAILABLE' },
    );
  await f.media.delete(f.context, asset.mediaRef.assetId);
  await assert.rejects(
    f.command('media-set-cover', {
      id,
      revision: 1,
      kind: 'image',
      mediaRef: asset.mediaRef,
    }),
    { code: 'WORLDBOOK_MEDIA_UNAVAILABLE' },
  );
  assert.equal(f.store.media.read(id).revision, 1);
  const corrupt = await f.image();
  await writeFile(
    path.join(
      f.root,
      'tavern-toolbox-server/media-v1/originals',
      corrupt.mediaRef.assetId + '.png',
    ),
    'corrupt',
  );
  await assert.rejects(
    f.command('media-set-cover', {
      id,
      revision: 1,
      kind: 'image',
      mediaRef: corrupt.mediaRef,
    }),
    { code: 'WORLDBOOK_MEDIA_UNAVAILABLE' },
  );
  assert.equal(f.store.media.read(id).revision, 1);
});

test('an existing broken reference stays readable and unlinkable without silently repairing or deleting the Asset', async (t) => {
  const f = await fixture(t),
    asset = await f.image(),
    id = f.rows[0].id;
  await f.command('media-set-cover', {
    id,
    revision: 1,
    kind: 'image',
    mediaRef: asset.mediaRef,
  });
  await writeFile(
    path.join(
      f.root,
      'tavern-toolbox-server/media-v1/originals',
      asset.mediaRef.assetId + '.png',
    ),
    'broken',
  );
  assert.equal(
    (await f.media.health(f.context, asset.mediaRef.assetId)).original,
    'corrupt',
  );
  assert.equal(
    (await f.worldbook.readMedia(f.context, { materialIds: [id] })).items[0]
      .cover.mediaRef.assetId,
    asset.mediaRef.assetId,
  );
  await f.command('media-clear-cover', { id, revision: 2 });
  assert.equal(f.store.media.read(id).cover, null);
  assert.equal((await f.media.catalog(f.context)).length, 1);
});

test('Worldbook and Outfit protect a shared Asset until every real consumer unlinks it', async (t) => {
  const f = await fixture(t),
    asset = await f.image(),
    id = f.rows[0].id;
  const business = createBusiness(await loadPolicy(), f.media, f.coordinate);
  await business.definition.initialize();
  t.after(() => business.definition.shutdown());
  f.governance.register(business.referenceProvider);
  const item = {
    id: 'coat',
    kind: 'item',
    name: '外套',
    category: '',
    tags: [],
    sceneTags: [],
    ownerPersonId: '',
    scope: { type: 'global', id: '', label: '全局' },
    mediaRef: asset.mediaRef,
    createdAt: '2026-10-17',
    updatedAt: '2026-10-17',
    itemType: 'clothing',
    wearSlot: 'outer-layer',
    modelDescription: '',
  };
  await business.commit(f.context, 'outfit', 1, 0, {
    assets: [item],
    persons: [],
    wearStates: [],
  });
  await f.command('media-set-cover', {
    id,
    revision: 1,
    kind: 'image',
    mediaRef: asset.mediaRef,
  });
  let detail = await f.governance.detail(f.context, asset.mediaRef.assetId);
  assert.equal(detail.references.total, 2);
  assert.deepEqual(
    new Set(detail.references.items.map((row) => row.consumer)),
    new Set(['outfit', 'worldbook']),
  );
  await f.command('media-clear-cover', { id, revision: 2 });
  await assert.rejects(f.governance.delete(f.context, asset.mediaRef.assetId), {
    code: 'MEDIA_REFERENCED',
  });
  await business.commit(f.context, 'outfit', 1, 1, {
    assets: [],
    persons: [],
    wearStates: [],
  });
  detail = await f.governance.detail(f.context, asset.mediaRef.assetId);
  assert.equal(detail.asset.referenceState, 'unreferenced');
  await f.governance.delete(f.context, asset.mediaRef.assetId);
  await assert.rejects(f.media.metadata(f.context, asset.mediaRef.assetId));
});

test('Governance uses Worldbook reference adapter and Media CAS; shared assets stay protected, Material deletion leaves media', async (t) => {
  const f = await fixture(t),
    [a, b] = f.rows,
    asset = await f.image(),
    replacement = await f.image();
  await f.command('media-set-cover', {
    id: a.id,
    revision: 1,
    kind: 'image',
    mediaRef: asset.mediaRef,
  });
  await f.command('media-gallery-add', {
    id: b.id,
    revision: 1,
    items: [{ kind: 'image', mediaRef: asset.mediaRef }],
  });
  let detail = await f.governance.detail(f.context, asset.mediaRef.assetId);
  assert.equal(detail.references.total, 2);
  assert.match(detail.references.items[0].groupLabel, /资料/);
  await assert.rejects(f.governance.delete(f.context, asset.mediaRef.assetId), {
    code: 'MEDIA_REFERENCED',
  });
  await f.governance.action(f.context, {
    providerId: 'worldbook',
    groupId: a.id,
    referenceId: 'cover',
    action: 'replace',
    revision: 2,
    mediaRef: replacement.mediaRef,
  });
  await assert.rejects(
    f.governance.action(f.context, {
      providerId: 'worldbook',
      groupId: a.id,
      referenceId: 'cover',
      action: 'unlink',
      revision: 2,
    }),
    { code: 'WORLDBOOK_MEDIA_CONFLICT' },
  );
  await f.governance.action(f.context, {
    providerId: 'worldbook',
    groupId: a.id,
    referenceId: 'cover',
    action: 'unlink',
    revision: 3,
  });
  assert.equal(
    (await f.governance.detail(f.context, replacement.mediaRef.assetId)).asset
      .referenceState,
    'unreferenced',
  );
  const before = f.store.detail(b.id);
  await f.core('material-delete', {
    id: b.id,
    revision: before.material.revision,
    structureRevision: before.column.structureRevision,
  });
  assert.equal(
    f.store.one('SELECT count(*) n FROM wb_media WHERE material_id=?', b.id).n,
    0,
  );
  assert.equal(
    (await f.governance.detail(f.context, asset.mediaRef.assetId)).asset
      .referenceState,
    'unreferenced',
  );
  assert.equal((await f.media.catalog(f.context)).length, 2);
});

test('fresh delete and relation creation serialize through the same coordinator, and failed reference analysis cannot become zero', async (t) => {
  const f = await fixture(t),
    id = f.rows[0].id,
    asset = await f.image();
  const pending = f.command('media-set-cover', {
    id,
    revision: 1,
    kind: 'image',
    mediaRef: asset.mediaRef,
  });
  await assert.rejects(f.governance.delete(f.context, asset.mediaRef.assetId), {
    code: 'MEDIA_REFERENCED',
  });
  await pending;
  f.governance.register({
    id: 'unavailable',
    consumer: 'future',
    label: 'future',
    enumerate() {
      throw Error('offline');
    },
  });
  const free = await f.image();
  await assert.rejects(f.governance.delete(f.context, free.mediaRef.assetId), {
    code: 'REFERENCE_ANALYSIS_INCOMPLETE',
  });
});

test('Catalog carries only a Cover relation; Discovery never reads media for its pool, and Roll queries only selected result Covers', async (t) => {
  const f = await fixture(t),
    asset = await f.image(),
    id = f.rows[0].id;
  await f.command('media-set-cover', {
    id,
    revision: 1,
    kind: 'image',
    mediaRef: asset.mediaRef,
  });
  const original = f.store.media.cover.bind(f.store.media);
  let covers = 0;
  f.store.media.cover = (...args) => {
    covers++;
    return original(...args);
  };
  const runtime = await f.worldbook.runtime(f.context, {
    offset: 0,
    bindings: f.rows.map((row) => ({
      locator: row.source.locator,
      uid: row.source.uid,
      enabled: false,
    })),
    mode: 'observed',
    complete: true,
  });
  const discovery = await f.worldbook.read(f.context, 'features', {
    kind: 'discovery',
    runtimeToken: runtime.token,
    limit: 20,
  });
  assert.equal(covers, 0);
  assert(
    discovery.items.every((row) => !('cover' in row) && !('gallery' in row)),
  );
  const roll = await f.worldbook.read(f.context, 'features', {
    kind: 'roll',
    runtimeToken: runtime.token,
    limit: 1,
  });
  assert.equal(covers, 1);
  assert.equal(roll.items.length, 1);
  const catalog = f.store.catalog({ page: 1, tags: [] });
  assert.equal(
    catalog.items.find((row) => row.id === id).cover.mediaRef.assetId,
    asset.mediaRef.assetId,
  );
  assert(
    catalog.items.every(
      (row) =>
        !('gallery' in row) &&
        !('width' in row) &&
        !('mime' in row) &&
        !('frameCount' in row),
    ),
  );
});
