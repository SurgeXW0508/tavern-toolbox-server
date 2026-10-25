import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, symlink, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { createVideo } from '../src/video/index.js';
import { validatePolicy } from '../src/config.js';
import { openVideo, locator } from '../src/video/roots.js';
import { VideoDiscovery } from '../src/video/discovery.js';
import { VideoStore } from '../src/video/store.js';
import { byteRange, streamLocalFile } from '../src/transport/local-file-stream.js';
import { VIDEO_LIMITS } from '../src/video/policy.js';

// Valid bounded MP4 ftyp for transport tests; not a playable decode fixture.
export const sample = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(4), Buffer.from('isommp42'), Buffer.alloc(128, 7)]);
function sink() {
    const chunks = [], headers = {};
    const result = new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } });
    result.setHeader = (key, value) => { headers[key] = value; };
    return Object.assign(result, { headers, bytes: () => Buffer.concat(chunks) });
}
async function fixture(t) {
    const root = await mkdtemp(path.join(tmpdir(), 'ttb-video-'));
    const source = path.join(root, 'source'); await mkdir(source); await writeFile(path.join(source, 'clip.mp4'), sample);
    const policy = validatePolicy({ schemaVersion: 1, core: { allowedOrigins: ['https://example.invalid'] }, video: { roots: [{ key: 'clips', label: 'Clips', path: source, users: ['alice'] }] } });
    const config = { policy }, video = createVideo(config); await video.definition.initialize();
    const alice = { contextId: 'a'.repeat(32), userHandle: 'alice', userRoot: path.join(root, 'alice') };
    const bob = { contextId: 'b'.repeat(32), userHandle: 'bob', userRoot: path.join(root, 'bob') };
    await mkdir(alice.userRoot); await mkdir(bob.userRoot);
    t.after(async () => { await video.close(); await rm(root, { recursive: true, force: true }); });
    return { root, source, config, video, alice, bob, file: path.join(source, 'clip.mp4') };
}
async function register(h) {
    const page = await h.video.browse(h.alice, { rootKey: 'clips' });
    const input = { candidateId: page.entries.find(row => row.name === 'clip.mp4').id, operationId: randomUUID(), title: 'Clip' };
    return { item: await h.video.register(h.alice, input), input, page };
}

test('Video policy is optional, bounded, deny-by-default and isolated from Core errors', async t => {
    const h = await fixture(t);
    assert.equal(h.video.definition.health(h.alice).state, 'ready');
    assert.equal(h.video.definition.health(h.bob).state, 'disabled');
    await assert.rejects(h.video.list(h.bob), { code: 'VIDEO_UNAVAILABLE' });
    assert.deepEqual(h.video.roots(h.alice), { roots: [{ rootKey: 'clips', label: 'Clips' }] });
    for (const video of [{ roots: [{ key: 'bad', path: '/', users: ['alice'], label: 'All' }] }, { roots: [], maxBytes: 0 }, { path: h.source }]) {
        const config = validatePolicy({ schemaVersion: 1, video });
        assert.equal(config.videoError, 'INVALID_VIDEO_CONFIG'); assert.equal(config.core.maxStatusResponseBytes, 262144);
    }
    const idle = createVideo({ policy: validatePolicy({ schemaVersion: 1 }) }); await idle.definition.initialize();
    assert.equal(idle.definition.health(h.alice).state, 'disabled'); await idle.close();
});

test('Discovery and registration use opaque candidates, revalidate files, deduplicate and persist without copying bytes', async t => {
    const h = await fixture(t), { input, item, page } = await register(h);
    assert.equal(item.sourceRevision, 1); assert.equal(item.kind, 'video');
    assert.equal(JSON.stringify(page).includes(h.source), false);
    const replay = await h.video.register(h.alice, input); assert.equal(replay.mediaRef.assetId, item.mediaRef.assetId); assert.equal(replay.reused, true);
    await assert.rejects(h.video.register(h.alice, { ...input, title: 'Changed' }), { code: 'VIDEO_OPERATION_CONFLICT' });
    const same = await h.video.register(h.alice, { ...input, operationId: randomUUID() }); assert.equal(same.mediaRef.assetId, item.mediaRef.assetId);
    await h.video.cancel(h.alice, page.sessionId);
    const afterCancel = await h.video.register(h.alice, input); assert.equal(afterCancel.mediaRef.assetId, item.mediaRef.assetId);
    await assert.rejects(h.video.register(h.alice, { ...input, operationId: randomUUID() }), { code: 'VIDEO_CANDIDATE_EXPIRED' });
    await h.video.close();
    const restarted = createVideo(h.config); await restarted.definition.initialize(); t.after(() => restarted.close());
    assert.equal((await restarted.list(h.alice)).total, 1);
    const info = await stat(path.join(h.alice.userRoot, 'tavern-toolbox-server/video-v1/metadata.sqlite')); assert.equal(info.mode & 0o777, 0o600);
    assert.deepEqual(await readFile(h.file), sample);
});

test('Directory paths, links, swapped files and partial/offline results fail without deleting registrations', async t => {
    const h = await fixture(t), { item, page } = await register(h);
    for (const value of ['../source-other/clip.mp4', '/clip.mp4', 'a/../clip.mp4', 'a\\b', 'a//b', 'a\0b']) assert.throws(() => locator(value));
    await assert.rejects(h.video.browse(h.alice, { rootKey: 'clips', path: '../' }), { code: 'INVALID_REQUEST' });
    await mkdir(path.join(h.source, 'folder')); await symlink(h.source, path.join(h.source, 'linked'));
    await assert.rejects(openVideo(h.config.policy.video, h.alice, 'clips', 'linked/clip.mp4'), { code: 'VIDEO_SOURCE_UNAVAILABLE' });
    await rename(h.file, h.file + '.old'); await writeFile(h.file, sample);
    const row = page.entries.find(row => row.name === 'clip.mp4');
    await assert.rejects(h.video.register(h.alice, { candidateId: row.id, operationId: randomUUID(), title: 'Other' }), { code: 'VIDEO_SOURCE_CHANGED' });
    assert.equal((await h.video.read(h.alice, item.mediaRef.assetId)).sourceState, 'changed');
    await rm(h.file); assert.equal((await h.video.read(h.alice, item.mediaRef.assetId)).sourceState, 'unavailable');
    assert.equal((await h.video.list(h.alice)).total, 1);
    await assert.rejects(h.video.resolve(h.alice, item.mediaRef.assetId), { code: 'VIDEO_SOURCE_UNAVAILABLE' });
    await rename(h.source, h.source + '-offline');
    await assert.rejects(h.video.browse(h.alice, { rootKey: 'clips' }), { code: 'VIDEO_SOURCE_UNAVAILABLE' });
    assert.equal((await h.video.list(h.alice)).total, 1);
});

test('Discovery snapshots are bounded, expire, paginate and are context/user isolated', async t => {
    const h = await fixture(t); let now = 1000;
    const discovery = new VideoDiscovery(h.config.policy.video, () => now);
    await mkdir(path.join(h.source, 'sub')); await writeFile(path.join(h.source, 'sub', 'nested.mp4'), sample);
    for (let i = 0; i < 52; i++) await mkdir(path.join(h.source, `dir-${i}`));
    const page = await discovery.browse(h.alice, { rootKey: 'clips' }); assert.equal(page.entries.length, 50); assert.ok(page.nextCursor);
    const next = await discovery.browse(h.alice, { cursor: page.nextCursor }); assert.equal(next.entries.length, 4);
    await assert.rejects(discovery.browse(h.bob, { cursor: page.nextCursor }), { code: 'VIDEO_CANDIDATE_EXPIRED' });
    const id = next.entries.find(row => row.name === 'sub')?.id || page.entries.find(row => row.name === 'sub').id;
    const child = await discovery.browse(h.alice, { directoryId: id }); assert.equal(child.entries[0].name, 'nested.mp4');
    assert.equal(child.breadcrumbs.length, 2);
    await discovery.browse(h.alice, { rootKey: 'clips' });
    await assert.rejects(discovery.browse(h.alice, { rootKey: 'clips' }), { code: 'RESOURCE_BUSY' });
    now += VIDEO_LIMITS.discoveryTtlMs;
    await assert.rejects(discovery.browse(h.alice, { cursor: page.nextCursor }), { code: 'VIDEO_CANDIDATE_EXPIRED' });
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(discovery.browse(h.alice, { rootKey: 'clips' }, aborted.signal), { code: 'CLIENT_ABORTED' });
    assert.equal(discovery.sessions.size, 0);
});

test('Catalog paging and presentation do not inspect source files; missing IDs and user roots stay isolated', async t => {
    const h = await fixture(t), { item } = await register(h);
    await rename(h.source, h.source + '-offline');
    assert.equal((await h.video.list(h.alice, { search: 'clip' })).total, 1);
    assert.equal((await h.video.list(h.alice, { search: 'missing' })).total, 0);
    const missing = randomUUID(), result = await h.video.presentation(h.alice, [item.mediaRef.assetId, missing]);
    assert.equal(result.items.length, 1); assert.deepEqual(result.missingAssetIds, [missing]);
    assert.equal(JSON.stringify(result).includes('locator'), false);
    await assert.rejects(h.video.presentation(h.alice, [missing, missing]), { code: 'INVALID_REQUEST' });
    await assert.rejects(h.video.list(h.alice, { limit: 49 }), { code: 'INVALID_REQUEST' });
});

test('Native file streaming supports complete, single ranges, suffixes, 416 and HEAD and retains originals', async t => {
    const h = await fixture(t), { item } = await register(h), id = item.mediaRef.assetId;
    for (const [range, status, bytes] of [[undefined, 200, sample], ['bytes=2-20', 206, sample.subarray(2, 21)],
        ['bytes=-7', 206, sample.subarray(-7)], ['bytes=140-', 206, sample.subarray(140)], ['bytes=9999-', 416, Buffer.alloc(0)]]) {
        const output = sink(); await h.video.stream(h.alice, id, 1, range, false, output);
        assert.equal(output.statusCode, status); assert.deepEqual(output.bytes(), bytes); assert.equal(Number(output.headers['Content-Length']), bytes.length);
    }
    const head = sink(); await h.video.stream(h.alice, id, 1, undefined, true, head); assert.equal(head.bytes().length, 0); assert.equal(Number(head.headers['Content-Length']), sample.length);
    for (const range of ['bytes=3-1', 'bytes=0-1,4-5', 'bytes=-0', 'bytes=9007199254740992-', 'wrong']) {
        await assert.rejects(h.video.stream(h.alice, id, 1, range, false, sink()), { code: 'UNSUPPORTED_RANGE' });
    }
    await assert.rejects(h.video.stream(h.alice, id, 2, undefined, false, sink()), { code: 'VIDEO_SOURCE_CHANGED' });
    const resolved = await h.video.resolve(h.alice, id); assert.ok(resolved.playbackPath.includes(h.alice.contextId));
});

test('Backpressure cancel and shutdown close handles, release stream budgets and abort pending I/O', async t => {
    const h = await fixture(t); await writeFile(h.file, Buffer.concat([sample, Buffer.alloc(512 * 1024)]));
    const { item } = await register(h), tasks = [], controllers = [], started = [];
    for (let i = 0; i < 4; i++) {
        const controller = new AbortController(); controllers.push(controller);
        let seen; const entered = new Promise(resolve => { seen = resolve; }); started.push(entered);
        const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _done) { seen(); } }); output.setHeader = () => {};
        const pending = h.video.stream(h.alice, item.mediaRef.assetId, 1, undefined, false, output, controller.signal);
        pending.catch(() => {}); tasks.push(pending);
    }
    await Promise.all(started);
    await assert.rejects(h.video.stream(h.alice, item.mediaRef.assetId, 1, undefined, false, sink()), { code: 'RESOURCE_BUSY' });
    controllers.forEach(controller => controller.abort());
    assert.ok((await Promise.allSettled(tasks)).every(result => result.status === 'rejected'));
    await h.video.stream(h.alice, item.mediaRef.assetId, 1, 'bytes=0-2', false, sink());
    let entered; const startedShutdown = new Promise(resolve => { entered = resolve; });
    const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _done) { entered(); } }); output.setHeader = () => {};
    const task = h.video.stream(h.alice, item.mediaRef.assetId, 1, undefined, false, output); task.catch(() => {});
    await startedShutdown; await h.video.close(); await assert.rejects(task);
    await assert.rejects(h.video.list(h.alice), { code: 'VIDEO_UNAVAILABLE' });
});

test('Unknown schema is preserved, and invalid range/short read/idle failure always close supplied handles', async t => {
    const h = await fixture(t); const file = path.join(h.root, 'db'); await mkdir(file);
    const store = new VideoStore(file, DatabaseSync); await store.initialize(); store.db.exec('PRAGMA user_version=99'); store.close();
    await assert.rejects(new VideoStore(file, DatabaseSync).initialize(), { code: 'VIDEO_SCHEMA_INCOMPATIBLE' });
    const db = new DatabaseSync(path.join(file, 'tavern-toolbox-server/video-v1/metadata.sqlite')); assert.equal(db.prepare('PRAGMA user_version').get().user_version, 99); db.close();
    for (const mode of ['range', 'short', 'idle']) {
        let closed = 0;
        const handle = { close: async () => { closed++; }, read: async chunk => { chunk[0] = 1; return { bytesRead: mode === 'short' ? 0 : 1 }; } };
        const output = mode === 'idle' ? new Writable({ highWaterMark: 1, write() {} }) : sink(); output.setHeader ||= () => {};
        await assert.rejects(streamLocalFile({ handle, size: 1, mime: 'video/mp4', range: mode === 'range' ? 'invalid' : undefined, output, idleTimeoutMs: 15 }));
        assert.equal(closed, 1);
    }
    assert.throws(() => byteRange('bytes=1-0', 5), { code: 'UNSUPPORTED_RANGE' });
});

test('Directory discovery rejects overflow, reports unsupported neighbours and denies linked roots', async t => {
    const h = await fixture(t);
    await writeFile(path.join(h.source, 'broken.mp4'), 'not-video');
    const page = await h.video.browse(h.alice, { rootKey: 'clips' });
    assert.equal(page.entries.find(row => row.name === 'broken.mp4').kind, 'unavailable');
    await assert.rejects(h.video.register(h.alice, { candidateId: page.entries.find(row => row.name === 'broken.mp4').id, operationId: randomUUID(), title: 'Bad' }), { code: 'VIDEO_CANDIDATE_EXPIRED' });
    const linked = path.join(h.root, 'linked-root'); await symlink(h.source, linked);
    const policy = { ...h.config.policy.video, roots: [{ ...h.config.policy.video.roots[0], path: linked }] };
    await assert.rejects(openVideo(policy, h.alice, 'clips', 'clip.mp4'), { code: 'VIDEO_SOURCE_UNAVAILABLE' });
    for (let i = 0; i < 1000; i++) await writeFile(path.join(h.source, `entry-${i}.txt`), '');
    await assert.rejects(h.video.browse(h.alice, { rootKey: 'clips' }), { code: 'VIDEO_DIRECTORY_LIMIT' });
    assert.equal((await h.video.list(h.alice)).total, 0);
});

test('5000-row SQL catalog projects only the requested page, stable order and rejects another registration at capacity', async t => {
    const h = await fixture(t), store = new VideoStore(h.alice.userRoot, DatabaseSync); await store.initialize(); t.after(() => store.close());
    const statement = store.db.prepare('INSERT INTO videos VALUES(?,?,?,?,?,?,?,1,1,?)');
    store.db.exec('BEGIN');
    for (let i = 0; i < 5000; i++) statement.run(randomUUID(), `Clip ${i}`, 'clips', `clip-${i}.mp4`, 'synthetic', 'video/mp4', 128, 1000 + i);
    store.db.exec('COMMIT');
    let projections = 0; const original = store.view.bind(store); store.view = row => { projections++; return original(row); };
    const first = store.list({ limit: 24 }, ['clips']); assert.equal(first.total, 5000); assert.equal(projections, 24); assert.equal(first.items[0].title, 'Clip 4999');
    assert.equal(store.list({ search: 'Clip 4999', limit: 24 }, ['clips']).items.length, 1);
    assert.equal(store.list({ limit: 24 }, ['other']).total, 0);
    const page = await h.video.browse(h.alice, { rootKey: 'clips' });
    await assert.rejects(h.video.register(h.alice, { candidateId: page.entries[0].id, operationId: randomUUID(), title: 'Full' }), { code: 'VIDEO_CATALOG_FULL' });
});

test('Successful directory navigation replaces its snapshot, ancestors stay reachable and failed navigation preserves it', async t => {
    const h = await fixture(t); await mkdir(path.join(h.source, 'sub'));
    const discovery = new VideoDiscovery(h.config.policy.video);
    const root = await discovery.browse(h.alice, { rootKey: 'clips' });
    const sub = await discovery.browse(h.alice, { directoryId: root.entries.find(row => row.name === 'sub').id });
    assert.equal(discovery.sessions.size, 1); assert.equal(sub.directoryLabel, 'sub');
    assert.throws(() => discovery.candidate(h.alice, root.entries.find(row => row.name === 'clip.mp4').id), { code: 'VIDEO_CANDIDATE_EXPIRED' });
    const back = await discovery.browse(h.alice, { directoryId: sub.breadcrumbs[0].id });
    await rename(path.join(h.source, 'sub'), path.join(h.source, 'moved'));
    await assert.rejects(discovery.browse(h.alice, { directoryId: back.entries.find(row => row.name === 'sub').id }), { code: 'VIDEO_SOURCE_UNAVAILABLE' });
    assert.equal(discovery.sessions.has(back.sessionId), true); assert.equal(discovery.sessions.size, 1);
});
