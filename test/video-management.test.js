import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createVideo } from '../src/video/index.js';
import { validatePolicy } from '../src/config.js';
import { VideoStore } from '../src/video/store.js';
async function setup(t) {
    const root = await mkdtemp(path.join(tmpdir(), 'video-p2-')), source = path.join(root, 'clips'); await mkdir(source);
    const bytes = Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from('ftypisom'), Buffer.alloc(4), Buffer.from('isommp42'), Buffer.alloc(256*1024)]);
    await writeFile(path.join(source, 'clip.mp4'), bytes); await writeFile(path.join(source, 'other.mp4'), bytes);
    const policy = validatePolicy({ schemaVersion: 1, core: { allowedOrigins: ['https://example.invalid'] }, video: { roots: [{ key: 'clips', label: 'Clips', path: source, users: ['alice'] }] } });
    const context = { userRoot: path.join(root, 'alice'), userHandle: 'alice', contextId: 'a'.repeat(32) }; await mkdir(context.userRoot);
    const video = createVideo({ policy }, { media: { metadata: async () => ({ kind: 'image' }), health: async () => ({ original: 'healthy' }) } }); await video.definition.initialize();
    t.after(async () => { await video.close(); await rm(root, { recursive: true, force: true }); });
    const page = await video.browse(context, { rootKey: 'clips' });
    const row = await video.register(context, { candidateId: page.entries.find(row => row.name === 'clip.mp4').id, operationId: randomUUID(), title: 'Clip' });
    return { root, source, bytes, video, context, row, page, policy, id: row.mediaRef.assetId };
}
test('Source replacement preserves ID/poster, resets progress, invalidates old versions and safely replays a completed operation', async t => {
    const h = await setup(t), { video, context, id } = h, poster = { provider: 'server', assetId: randomUUID() };
    await video.update(context, id, { operationId: randomUUID(), metadataRevision: 1, patch: { posterRef: poster } });
    const oldWrite = { sourceRevision: 1, expectedProgressRevision: 0, writeId: randomUUID(), positionSeconds: 50, durationHint: 100, completed: false };
    await video.progress(context, id, oldWrite);
    const operation = { operationId: randomUUID(), sourceRevision: 1, candidateId: h.page.entries.find(row => row.name === 'other.mp4').id };
    const changed = await video.source(context, id, operation);
    assert.equal(changed.mediaRef.assetId, id); assert.equal(changed.sourceRevision, 2); assert.deepEqual(changed.posterRef, poster); assert.equal(changed.metadataRevision, 2);
    const progress = await video.progress(context, id, null); assert.equal(progress.revision, 0); assert.equal(progress.positionSeconds, 0);
    await assert.rejects(video.progress(context, id, oldWrite), { code: 'VIDEO_SOURCE_CHANGED' });
    await video.cancel(context, h.page.sessionId); assert.deepEqual(await video.source(context, id, operation), changed);
    await assert.rejects(video.source(context, id, { ...operation, candidateId: randomUUID() }), { code: 'VIDEO_OPERATION_CONFLICT' });
    assert.deepEqual(await readFile(path.join(h.source, 'clip.mp4')), h.bytes);
});
test('Shared or incomplete Consumer analysis refuses unregister; a later unlink permits exact metadata removal without source deletion', async t => {
    const h = await setup(t); let refs = [{ videoId: h.id, ownerId: 'material-one', label: 'Material' }], unavailable = false;
    h.video.registerReferenceProvider({ id: 'fixture-consumer', enumerate: async () => { if (unavailable) throw Error('unavailable'); return refs; } });
    const input = { operationId: randomUUID(), metadataRevision: 1, sourceRevision: 1 };
    await assert.rejects(h.video.unregister(h.context, h.id, input), { code: 'VIDEO_REFERENCED' });
    refs = []; unavailable = true;
    await assert.rejects(h.video.unregister(h.context, h.id, input), { code: 'VIDEO_REFERENCES_INCOMPLETE' });
    unavailable = false; assert.deepEqual(await h.video.unregister(h.context, h.id, input), { removed: true });
    assert.deepEqual(await h.video.unregister(h.context, h.id, input), { removed: true }); assert.deepEqual(await readFile(path.join(h.source, 'clip.mp4')), h.bytes);
});
test('Poster references survive removal of root permission and protect data even while Video is disabled', async t => {
    const h = await setup(t), poster = { provider: 'server', assetId: randomUUID() };
    await h.video.update(h.context, h.id, { operationId: randomUUID(), metadataRevision: 1, patch: { posterRef: poster } }); await h.video.close();
    const disabled = createVideo({ policy: validatePolicy({ schemaVersion: 1 }) }); await disabled.definition.initialize(); t.after(() => disabled.close());
    assert.equal(disabled.definition.health(h.context).state, 'disabled');
    const groups = await disabled.posterReferenceProvider.enumerate(h.context); assert.deepEqual(groups[0].references[0].mediaRef, poster);
    const noData = { ...h.context, userRoot: path.join(h.root, 'empty') }; assert.deepEqual(await disabled.posterReferenceProvider.enumerate(noData), []);
});
test('Schema 1 adds poster/progress/command tables atomically without changing registered identities', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'video-migration-')); t.after(() => rm(root, { recursive: true, force: true }));
    const folder = path.join(root, 'tavern-toolbox-server/video-v1'); await mkdir(folder, { recursive: true });
    const db = new DatabaseSync(path.join(folder, 'metadata.sqlite')), id = randomUUID();
    db.exec('CREATE TABLE videos(id TEXT PRIMARY KEY,title TEXT,root_key TEXT,locator TEXT,fingerprint TEXT,mime TEXT,byte_size INTEGER,source_revision INTEGER,metadata_revision INTEGER,created_at INTEGER,UNIQUE(root_key,locator)); CREATE TABLE receipts(operation_id TEXT PRIMARY KEY,request_hash TEXT,video_id TEXT,created_at INTEGER); PRAGMA user_version=1;');
    db.prepare('INSERT INTO videos VALUES(?,?,?,?,?,?,?,?,?,?)').run(id, 'Clip', 'clips', 'clip.mp4', 'fingerprint', 'video/mp4', 100, 1, 1, 1000); db.close();
    const store = new VideoStore(root, DatabaseSync); await store.initialize(); t.after(() => store.close()); assert.equal(store.db.prepare('PRAGMA user_version').get().user_version, 2); assert.equal(store.row(id).title, 'Clip'); assert.equal(store.view(store.row(id)).posterRef, null);
});
