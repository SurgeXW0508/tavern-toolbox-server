import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { DatabaseSync } from 'node:sqlite';
import { MediaStore } from '../src/media/store.js';
import { MediaFailure, validateImage } from '../src/media/validation.js';
import { createMedia } from '../src/media/index.js';
import { validatePolicy } from '../src/config.js';

const policy = validatePolicy({ schemaVersion: 1, core: { allowedOrigins: ['https://example.com'] } }).media;
async function fixture(format, color) {
    return sharp({ create: { width: 4, height: 3, channels: 3, background: color } })
        .toFormat(format).toBuffer();
}
async function temp(t) {
    const root = await mkdtemp(path.join(tmpdir(), 'ttb-media-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}

test('deep image validation preserves bytes, detects formats, and rejects unsafe input', async () => {
    for (const [format, mime] of [['jpeg', 'image/jpeg'], ['png', 'image/png'],
        ['webp', 'image/webp'], ['gif', 'image/gif']]) {
        const bytes = await fixture(format, '#cc0000');
        const data = await validateImage(bytes, mime, policy, sharp);
        assert.equal(data.mime, mime);
        assert.equal(data.width, 4);
        assert.ok(data.thumbnail?.length);
        await assert.rejects(validateImage(bytes, 'image/png' === mime ? 'image/jpeg' : 'image/png', policy, sharp),
            { code: 'MIME_MISMATCH' });
        await assert.rejects(validateImage(bytes.subarray(0, bytes.length - 5), mime, policy, sharp),
            MediaFailure);
    }
    await assert.rejects(validateImage(Buffer.from('<svg></svg>'), '', policy, sharp), MediaFailure);
    const large = await sharp({ create: { width: 50, height: 50, channels: 3, background: '#000' } }).png().toBuffer();
    await assert.rejects(validateImage(large, 'image/png', { ...policy, maxPixels: 100 }, sharp),
        { code: 'MEDIA_COMPLEXITY_EXCEEDED' });
    const png = await fixture('png', '#55aa22');
    const actl = Buffer.from('000000086163544c000000020000000100000000', 'hex');
    const apng = Buffer.concat([png.subarray(0, 33), actl, png.subarray(33)]);
    await assert.rejects(validateImage(apng, 'image/png', policy, sharp),
        { code: 'ANIMATION_UNSUPPORTED' });
});

test('animated GIF keeps every Original frame while animated WebP is rejected explicitly', async () => {
    const a = Buffer.alloc(2 * 2 * 3, 255), b = Buffer.alloc(2 * 2 * 3, 0);
    const gif = await sharp(Buffer.concat([a, b]), { raw: { width: 2, height: 4, channels: 3,
        pageHeight: 2 } }).gif({ delay: [100, 100] }).toBuffer();
    const info = await validateImage(gif, 'image/gif', policy, sharp);
    assert.equal(info.animated, true);
    assert.equal(info.frames, 2);
    assert.ok(info.thumbnail?.length);
    const webp = await sharp(gif, { animated: true }).webp().toBuffer();
    await assert.rejects(validateImage(webp, 'image/webp', policy, sharp),
        { code: 'ANIMATION_UNSUPPORTED' });
});

test('same-user concurrent imports dedupe, retain exact Original, and survive reopen', async t => {
    const root = await temp(t);
    const store = new MediaStore(root, policy, DatabaseSync);
    await store.initialize();
    const bytes = await fixture('png', '#1188dd');
    const valid = await validateImage(bytes, 'image/png', policy, sharp);
    const [a, b] = await Promise.all([store.import(bytes, valid), store.import(bytes, valid)]);
    assert.deepEqual(a.mediaRef, b.mediaRef);
    assert.equal(store.usage().assetCount, 1);
    assert.equal(store.usage().originalBytes, bytes.length);
    assert.deepEqual((await store.read(a.mediaRef.assetId)).bytes, bytes);
    assert.equal((await store.read(a.mediaRef.assetId, true)).mime, 'image/webp');
    store.close();
    const reopened = new MediaStore(root, policy, DatabaseSync);
    await reopened.initialize();
    assert.deepEqual((await reopened.metadata(a.mediaRef.assetId)).mediaRef, a.mediaRef);
    const data = await reopened.read(a.mediaRef.assetId);
    assert.deepEqual(data.bytes, bytes);
    reopened.close();
});

test('cold-consistent copy of metadata and Original restores the same MediaRef', async t => {
    const root = await temp(t), restoredRoot = await temp(t);
    const store = new MediaStore(root, policy, DatabaseSync);
    await store.initialize();
    const bytes = await fixture('gif', '#aabbcc');
    const validated = await validateImage(bytes, 'image/gif', policy, sharp);
    const ref = (await store.import(bytes, validated)).mediaRef;
    store.close();
    await cp(path.join(root, 'tavern-toolbox-server'), path.join(restoredRoot, 'tavern-toolbox-server'),
        { recursive: true });
    const recovered = new MediaStore(restoredRoot, policy, DatabaseSync);
    await recovered.initialize();
    assert.deepEqual((await recovered.metadata(ref.assetId)).mediaRef, ref);
    assert.deepEqual((await recovered.read(ref.assetId)).bytes, bytes);
    recovered.close();
});

test('quota is atomic; explicit delete invalidates identity and reimport allocates a new one', async t => {
    const root = await temp(t);
    const a = await fixture('png', '#0000dd'), b = await fixture('png', '#dd0000');
    const bounded = { ...policy, quotaBytes: Math.max(a.length, b.length) + 1 };
    const store = new MediaStore(root, bounded, DatabaseSync);
    await store.initialize();
    const av = await validateImage(a, 'image/png', bounded, sharp);
    const bv = await validateImage(b, 'image/png', bounded, sharp);
    const results = await Promise.allSettled([store.import(a, av), store.import(b, bv)]);
    assert.deepEqual(results.map(x => x.status).sort(), ['fulfilled', 'rejected']);
    assert.equal(results.find(x => x.status === 'rejected').reason.code, 'QUOTA_EXCEEDED');
    const identity = results.find(x => x.status === 'fulfilled').value.mediaRef.assetId;
    assert.equal(store.usage().assetCount, 1);
    await store.delete(identity);
    await assert.rejects(store.read(identity), { code: 'MEDIA_NOT_FOUND' });
    const next = await store.import(a, av);
    assert.notEqual(next.mediaRef.assetId, identity);
    store.close();
});

test('different user roots never share assets; missing Original is corruption with no remote repair', async t => {
    const root = await temp(t), another = await temp(t);
    const one = new MediaStore(root, policy, DatabaseSync), two = new MediaStore(another, policy, DatabaseSync);
    await one.initialize(); await two.initialize();
    const bytes = await fixture('webp', '#11ff00');
    const valid = await validateImage(bytes, 'image/webp', policy, sharp);
    const a = await one.import(bytes, valid), b = await two.import(bytes, valid);
    assert.notEqual(a.mediaRef.assetId, b.mediaRef.assetId);
    await assert.rejects(two.read(a.mediaRef.assetId), { code: 'MEDIA_NOT_FOUND' });
    const original = one.originalPath(one.row(a.mediaRef.assetId));
    await writeFile(original, Buffer.alloc(bytes.length));
    await assert.rejects(one.read(a.mediaRef.assetId), { code: 'MEDIA_CORRUPT' });
    await assert.rejects(one.import(bytes, valid), { code: 'MEDIA_CORRUPT' });
    one.close(); two.close();
});

test('Derived rebuild preserves MediaRef; technical cleanup retains valid unreferenced assets', async t => {
    const root = await temp(t), store = new MediaStore(root, policy, DatabaseSync);
    await store.initialize();
    const bytes = await fixture('jpeg', '#334455');
    const valid = await validateImage(bytes, 'image/jpeg', policy, sharp);
    const original = await store.import(bytes, valid);
    const row = store.row(original.mediaRef.assetId);
    await rm(store.derivedPath(row));
    await assert.rejects(store.read(row.id, true), { code: 'DERIVED_UNAVAILABLE' });
    const rebuilt = await store.rebuild(row.id, sharp);
    assert.deepEqual(rebuilt.mediaRef, original.mediaRef);
    assert.ok((await store.read(row.id, true)).bytes.length);
    const orphan = path.join(store.root, 'originals', '00000000-0000-4000-8000-000000000000.jpg');
    await writeFile(orphan, bytes);
    assert.deepEqual(await store.cleanupTechnicalGarbage(), { removedPhysicalFiles: 1 });
    await assert.rejects(import('node:fs/promises').then(fs => fs.stat(orphan)), { code: 'ENOENT' });
    assert.deepEqual((await store.read(row.id)).bytes, bytes);
    store.close();
});

test('read/delete race returns complete bytes or not found, never a truncated image', async t => {
    const root = await temp(t), store = new MediaStore(root, policy, DatabaseSync);
    await store.initialize();
    const bytes = await fixture('png', '#442200');
    const valid = await validateImage(bytes, 'image/png', policy, sharp);
    const id = (await store.import(bytes, valid)).mediaRef.assetId;
    const [read] = await Promise.allSettled([store.read(id), store.delete(id)]);
    if (read.status === 'fulfilled') assert.deepEqual(read.value.bytes, bytes);
    else assert.equal(read.reason.code, 'MEDIA_NOT_FOUND');
    store.close();
});

test('unknown newer SQLite schema fails closed without clearing it', async t => {
    const root = await temp(t);
    const location = path.join(root, 'tavern-toolbox-server', 'media-v1');
    await mkdir(location, { recursive: true });
    const db = new DatabaseSync(path.join(location, 'metadata.sqlite'));
    db.exec('PRAGMA user_version = 3'); db.close();
    const store = new MediaStore(root, policy, DatabaseSync);
    await assert.rejects(store.initialize(), { code: 'INCOMPATIBLE_SCHEMA' });
    const untouched = new DatabaseSync(path.join(location, 'metadata.sqlite'));
    assert.equal(untouched.prepare('PRAGMA user_version').get().user_version, 3);
    untouched.close();
});

test('Media is independent of Network and remote import uses its bounded fetch result', async t => {
    const root = await temp(t);
    const bytes = await fixture('png', '#000044');
    let calls = 0;
    const network = { definition: { health: () => ({ state: 'disabled' }) },
        fetchImage: async () => { calls++; return { body: bytes, mime: 'image/png' }; } };
    const media = createMedia({ policy: { media: policy, core: { allowedOrigins: ['https://example.com'] } } }, network);
    await media.definition.initialize();
    const context = { userRoot: root, contextId: 'transient' };
    assert.deepEqual(media.definition.dependsOn, ['core']);
    const local = await media.importBytes(context, bytes, 'image/png');
    assert.equal((await media.read(context, local.mediaRef.assetId)).bytes.length, bytes.length);
    await assert.rejects(media.remoteImport(context, 'https://example.com/image.png'), { code: 'NETWORK_UNAVAILABLE' });
    assert.equal(calls, 0);
    network.definition.health = () => ({ state: 'ready' });
    const remote = await media.remoteImport(context, 'https://example.com/image.png');
    assert.deepEqual(remote.mediaRef, local.mediaRef);
    assert.equal(calls, 1);
    await media.definition.shutdown();
});
