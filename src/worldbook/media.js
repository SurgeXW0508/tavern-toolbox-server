import { fail, id, integer, object } from './validation.js';

export const MEDIA_COMMANDS = new Set([
  'media-set-cover',
  'media-clear-cover',
  'media-gallery-add',
  'media-gallery-remove',
  'media-gallery-reorder',
  'media-to-cover',
  'media-to-gallery',
  'media-reference-unlink',
  'media-reference-replace',
]);
const ASSET_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function mediaRef(value) {
  object(value, ['provider', 'assetId'], ['provider', 'assetId']);
  if (
    value.provider !== 'server' ||
    typeof value.assetId !== 'string' ||
    !ASSET_ID.test(value.assetId)
  )
    fail('WORLDBOOK_VALIDATION');
  return { provider: 'server', assetId: value.assetId };
}
export function migrateWorldbookMedia(db) {
  if (db.prepare('PRAGMA user_version').get().user_version === 2) {
    db.exec(`BEGIN IMMEDIATE;
            CREATE TABLE wb_media_versions(material_id TEXT PRIMARY KEY REFERENCES materials(id) ON DELETE CASCADE, revision INTEGER NOT NULL);
            CREATE TABLE wb_media(material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
                provider TEXT NOT NULL CHECK(provider='server'), asset_id TEXT NOT NULL, kind TEXT NOT NULL,
                role TEXT NOT NULL CHECK(role IN('cover','gallery')), position INTEGER NOT NULL CHECK(position>=0),
                PRIMARY KEY(material_id,provider,asset_id));
            CREATE UNIQUE INDEX wb_media_cover ON wb_media(material_id) WHERE role='cover';
            CREATE INDEX wb_media_asset ON wb_media(provider,asset_id,material_id);
            INSERT INTO wb_media_versions SELECT id,1 FROM materials;
            CREATE TRIGGER wb_media_material_insert AFTER INSERT ON materials BEGIN
                INSERT INTO wb_media_versions VALUES(NEW.id,1);
            END;
            PRAGMA user_version=3;
            COMMIT;`);
  }
  for (const table of ['wb_media', 'wb_media_versions'])
    db.prepare(`SELECT * FROM ${table} LIMIT 0`).all();
}

// Worldbook owns relationships only. Asset bytes/metadata/health remain Media-owned.
export class WorldbookMedia {
  constructor(store) {
    this.store = store;
  }
  revision(materialId) {
    const value = this.store.one(
      'SELECT revision FROM wb_media_versions WHERE material_id=?',
      id(materialId),
    );
    if (!value) fail('WORLDBOOK_NOT_FOUND');
    return value.revision;
  }
  rows(materialId) {
    return this.store.all(
      "SELECT * FROM wb_media WHERE material_id=? ORDER BY CASE role WHEN 'cover' THEN 0 ELSE 1 END,position,asset_id",
      materialId,
    );
  }
  view(row) {
    return {
      kind: row.kind,
      role: row.role,
      position: row.position,
      mediaRef: { provider: row.provider, assetId: row.asset_id },
    };
  }
  cover(materialId) {
    const row = this.store.one(
      "SELECT * FROM wb_media WHERE material_id=? AND role='cover'",
      materialId,
    );
    return row ? this.view(row) : null;
  }
  read(materialId) {
    const revision = this.revision(materialId),
      rows = this.rows(materialId);
    return {
      id: materialId,
      revision,
      cover: rows.find((row) => row.role === 'cover')
        ? this.view(rows[0])
        : null,
      gallery: rows
        .filter((row) => row.role === 'gallery')
        .map((row) => this.view(row)),
    };
  }
  validate(action, data) {
    if (!MEDIA_COMMANDS.has(action)) fail('WORLDBOOK_VALIDATION');
    const extra = {
      'media-set-cover': ['mediaRef', 'kind'],
      'media-clear-cover': [],
      'media-gallery-add': ['items'],
      'media-gallery-remove': ['assetId'],
      'media-gallery-reorder': ['assetIds'],
      'media-to-cover': ['assetId'],
      'media-to-gallery': [],
      'media-reference-unlink': ['referenceId'],
      'media-reference-replace': ['referenceId', 'mediaRef', 'kind'],
    }[action];
    object(data, ['id', 'revision', ...extra], ['id', 'revision', ...extra]);
    id(data.id);
    integer(data.revision, 1);
    const refs = [];
    const item = (value) => {
      object(value, ['kind', 'mediaRef'], ['kind', 'mediaRef']);
      if (value.kind !== 'image') fail('WORLDBOOK_VALIDATION');
      refs.push(mediaRef(value.mediaRef));
    };
    if (data.mediaRef) item({ kind: data.kind, mediaRef: data.mediaRef });
    if (action === 'media-gallery-add') {
      if (
        !Array.isArray(data.items) ||
        !data.items.length ||
        data.items.length > 6
      )
        fail('WORLDBOOK_VALIDATION');
      data.items.forEach(item);
    }
    if (
      'assetId' in data &&
      (typeof data.assetId !== 'string' || !ASSET_ID.test(data.assetId))
    )
      fail('WORLDBOOK_VALIDATION');
    if (
      action === 'media-gallery-reorder' &&
      (!Array.isArray(data.assetIds) ||
        data.assetIds.length > 6 ||
        data.assetIds.some((value) => !ASSET_ID.test(value)) ||
        new Set(data.assetIds).size !== data.assetIds.length)
    )
      fail('WORLDBOOK_VALIDATION');
    if (data.referenceId !== undefined && typeof data.referenceId !== 'string')
      fail('WORLDBOOK_VALIDATION');
    return refs;
  }
  mutate(action, data, { mediaValidated = false } = {}) {
    this.validate(action, data);
    if (!mediaValidated) fail('WORLDBOOK_MEDIA_UNAVAILABLE');
    const s = this.store,
      current = this.read(data.id);
    if (current.revision !== data.revision) fail('WORLDBOOK_MEDIA_CONFLICT');
    let cover = current.cover,
      gallery = [...current.gallery];
    const make = (ref) => ({
      kind: 'image',
      role: 'gallery',
      position: 0,
      mediaRef: ref,
    });
    if (action === 'media-clear-cover') cover = null;
    if (action === 'media-set-cover') {
      cover = make(mediaRef(data.mediaRef));
      gallery = gallery.filter(
        (row) => row.mediaRef.assetId !== data.mediaRef.assetId,
      );
    }
    if (action === 'media-gallery-add')
      gallery.push(...data.items.map((row) => make(mediaRef(row.mediaRef))));
    if (action === 'media-gallery-remove') {
      if (!gallery.some((row) => row.mediaRef.assetId === data.assetId))
        fail('WORLDBOOK_NOT_FOUND');
      gallery = gallery.filter((row) => row.mediaRef.assetId !== data.assetId);
    }
    if (action === 'media-gallery-reorder') {
      if (
        data.assetIds.length !== gallery.length ||
        data.assetIds.some(
          (value) => !gallery.some((row) => row.mediaRef.assetId === value),
        )
      )
        fail('WORLDBOOK_VALIDATION');
      gallery = data.assetIds.map((value) =>
        gallery.find((row) => row.mediaRef.assetId === value),
      );
    }
    if (action === 'media-to-cover') {
      const selected = gallery.find(
        (row) => row.mediaRef.assetId === data.assetId,
      );
      if (!selected) fail('WORLDBOOK_NOT_FOUND');
      cover = selected;
      gallery = gallery.filter((row) => row !== selected);
    }
    if (action === 'media-to-gallery') {
      if (!cover) fail('WORLDBOOK_NOT_FOUND');
      gallery.push(cover);
      cover = null;
    }
    if (action.startsWith('media-reference-')) {
      const selected =
        data.referenceId === 'cover'
          ? cover
          : gallery.find(
              (row) => `gallery:${row.mediaRef.assetId}` === data.referenceId,
            );
      if (!selected) fail('WORLDBOOK_NOT_FOUND');
      const replacement =
        action === 'media-reference-replace'
          ? make(mediaRef(data.mediaRef))
          : null;
      if (selected === cover) cover = replacement;
      else
        gallery = gallery.flatMap((row) =>
          row === selected ? (replacement ? [replacement] : []) : [row],
        );
    }
    if (gallery.length > 6) fail('WORLDBOOK_CAPACITY');
    const all = [
      ...(cover ? [{ ...cover, role: 'cover', position: 0 }] : []),
      ...gallery.map((row, position) => ({
        ...row,
        role: 'gallery',
        position,
      })),
    ];
    if (new Set(all.map((row) => row.mediaRef.assetId)).size !== all.length)
      fail('WORLDBOOK_DUPLICATE');
    s.run('DELETE FROM wb_media WHERE material_id=?', data.id);
    for (const row of all)
      s.run(
        'INSERT INTO wb_media VALUES(?,?,?,?,?,?)',
        data.id,
        row.mediaRef.provider,
        row.mediaRef.assetId,
        row.kind,
        row.role,
        row.position,
      );
    s.run(
      'UPDATE wb_media_versions SET revision=revision+1 WHERE material_id=?',
      data.id,
    );
    return { id: data.id, media: this.read(data.id) };
  }
  groups() {
    const rows = this.store.all(
      'SELECT r.*,m.name,c.title,v.revision FROM wb_media r JOIN materials m ON m.id=r.material_id JOIN columns c ON c.id=m.column_id JOIN wb_media_versions v USING(material_id) ORDER BY m.id,r.role,r.position',
    );
    const groups = new Map();
    for (const row of rows) {
      if (!groups.has(row.material_id))
        groups.set(row.material_id, {
          id: row.material_id,
          label: `${row.title} / ${row.name}`,
          lifecycle: 'active',
          revision: row.revision,
          actions: [],
          references: [],
        });
      groups
        .get(row.material_id)
        .references.push({
          id: row.role === 'cover' ? 'cover' : `gallery:${row.asset_id}`,
          label: row.role === 'cover' ? '封面' : `附图 ${row.position + 1}`,
          mediaRef: { provider: row.provider, assetId: row.asset_id },
          actions: ['unlink', 'replace'],
        });
    }
    return [...groups.values()];
  }
}
