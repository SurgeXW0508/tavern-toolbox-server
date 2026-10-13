import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import sharp from 'sharp';
import { loadPolicy } from '../src/config.js';
import { createMedia } from '../src/media/index.js';
import { createBusiness } from '../src/business/index.js';
import { createLocalization } from '../src/localization/index.js';
import { createGovernance } from '../src/governance/index.js';
import { createReferenceCoordinator } from '../src/governance/coordination.js';
import { card } from './localization-fixture.js';

async function fixture(t) {
    const userRoot = await mkdtemp(path.join(tmpdir(), 'ttb-governance-'));
    const otherRoot = await mkdtemp(path.join(tmpdir(), 'ttb-governance-other-'));
    await mkdir(path.join(userRoot, 'characters')); await mkdir(path.join(otherRoot, 'characters'));
    await card(path.join(userRoot, 'characters', 'A.png'), '2026-01-01', 'A');
    const context = { userRoot }, other = { userRoot: otherRoot }, coordinate = createReferenceCoordinator();
    const config = await loadPolicy();
    const network = { definition: { health: () => ({ state: 'disabled' }) } };
    const media = createMedia(config, network), business = createBusiness(config, media, coordinate), localization = createLocalization(media, coordinate);
    await media.definition.initialize(); await business.definition.initialize(); await localization.definition.initialize();
    const governance = createGovernance(media, coordinate);
    governance.register(localization.referenceProvider); governance.register(business.referenceProvider);
    t.after(async () => {
        await localization.definition.shutdown(); await business.definition.shutdown(); await media.definition.shutdown();
        await rm(userRoot, { recursive: true, force: true }); await rm(otherRoot, { recursive: true, force: true });
    });
    async function image(color = 'red', owner = context) {
        const bytes = await sharp({ create: { width: 24, height: 24, channels: 3, background: color } }).png().toBuffer();
        return media.importBytes(owner, bytes, 'image/png');
    }
    return { context, other, media, business, localization, governance, coordinate, image };
}
function outfit(ref) {
    return { assets: [{ id: 'coat', kind: 'item', name: '黑色礼服', category: '', tags: [], sceneTags: [], ownerPersonId: '',
        scope: { type: 'global', id: '', label: '全局' }, mediaRef: ref, createdAt: '2026-01-01', updatedAt: '2026-01-01',
        itemType: 'clothing', wearSlot: 'outer-layer', modelDescription: '' }], persons: [], wearStates: [] };
}
const url = 'https://blocked.example/image.png';

test('existing originals bind offline, aggregate active/detached/multiple refs, unlink/forget retain Media', async t => {
    const f = await fixture(t), asset = await f.image(), id = asset.mediaRef.assetId;
    const bound = await f.localization.bindExisting(f.context, { hostId: 'A.png', displayName: '角色 A', url,
        revision: 0, mediaRef: asset.mediaRef });
    await f.business.commit(f.context, 'outfit', 1, 0, outfit(asset.mediaRef));
    const view = await f.governance.detail(f.context, id);
    assert.equal(view.asset.referenceState, 'active'); assert.equal(view.references.total, 2);
    assert.equal((await f.governance.assets(f.context, { search: '黑色礼服' })).total, 1);
    assert.equal((await f.governance.summary(f.context)).unreferencedCount, 0);
    await assert.rejects(f.governance.delete(f.context, id), { code: 'MEDIA_REFERENCED' });
    await unlink(path.join(f.context.userRoot, 'characters', 'A.png'));
    const groups = await f.governance.groups(f.context);
    assert.equal(groups.items.find(group => group.consumer === 'character').lifecycle, 'detached');
    assert.equal((await f.governance.detail(f.context, id)).asset.referenceState, 'active');
    await f.business.commit(f.context, 'outfit', 1, 1, outfit(null));
    assert.equal((await f.governance.detail(f.context, id)).asset.referenceState, 'detached');
    await assert.rejects(f.governance.delete(f.context, id), { code: 'MEDIA_REFERENCED' });
    const detached = (await f.governance.groups(f.context)).items[0];
    await assert.rejects(f.governance.action(f.context, { providerId: 'localization', groupId: bound.current.id,
        revision: 0, action: 'forget' }), { code: 'LOCALIZATION_CONFLICT' });
    await f.governance.action(f.context, { providerId: 'localization', groupId: detached.id, revision: detached.revision, action: 'forget' });
    assert.equal((await f.governance.detail(f.context, id)).asset.referenceState, 'unreferenced');
    assert.equal((await f.media.metadata(f.context, id)).mediaRef.assetId, id);
    await f.governance.delete(f.context, id); await assert.rejects(f.media.metadata(f.context, id), { code: 'MEDIA_NOT_FOUND' });
});

test('provider failure retains known references, unknown is never eligible for deletion; future provider plugs in', async t => {
    const f = await fixture(t), asset = await f.image();
    let unavailable = true;
    f.governance.register({ id: 'future', consumer: 'worldbook', label: '未来业务', enumerate: async () => {
        if (unavailable) throw new Error('private path must not leak');
        return [{ id: 'future-group', label: 'Future', lifecycle: 'active', revision: 1,
            references: [{ id: 'slot', label: 'Image', mediaRef: asset.mediaRef }] }];
    } });
    assert.equal((await f.governance.assets(f.context)).items[0].referenceState, 'unknown');
    const summary = await f.governance.summary(f.context);
    assert.equal(summary.complete, false); assert.equal(summary.unreferencedBytes, 0);
    assert.equal(JSON.stringify(summary).includes('private path'), false);
    await assert.rejects(f.governance.delete(f.context, asset.mediaRef.assetId), { code: 'REFERENCE_ANALYSIS_INCOMPLETE' });
    assert.equal((await f.media.read(f.context, asset.mediaRef.assetId)).mime, 'image/png');
    unavailable = false;
    assert.equal((await f.governance.detail(f.context, asset.mediaRef.assetId)).asset.referenceState, 'active');
});

test('broken reference survives missing catalog row; corruption is separate from reference state and replace uses CAS', async t => {
    const f = await fixture(t), asset = await f.image(), replacement = await f.image('blue');
    await f.business.commit(f.context, 'outfit', 1, 0, outfit(asset.mediaRef));
    await writeFile(path.join(f.context.userRoot, 'tavern-toolbox-server', 'media-v1', 'originals', asset.mediaRef.assetId + '.png'), 'corrupt');
    const detail = await f.governance.detail(f.context, asset.mediaRef.assetId);
    assert.equal(detail.asset.referenceState, 'active'); assert.equal(detail.health.original, 'corrupt');
    await f.media.delete(f.context, asset.mediaRef.assetId); // Simulate pre-Phase-6 restore damage via internal primitive.
    const group = (await f.governance.groups(f.context, { broken: 'true' })).items[0];
    assert.equal(group.brokenCount, 1); assert.equal((await f.governance.summary(f.context)).brokenCount, 1);
    const missing = await f.governance.group(f.context, 'outfit', 'coat');
    assert.equal(missing.references.items[0].broken, true); assert.equal(missing.group.brokenCount, 1);
    await assert.rejects(f.governance.action(f.context, { providerId: 'outfit', groupId: 'coat', referenceId: 'image',
        action: 'replace', revision: 0, mediaRef: replacement.mediaRef }), { code: 'BUSINESS_CONFLICT' });
    await f.governance.action(f.context, { providerId: 'outfit', groupId: 'coat', referenceId: 'image',
        action: 'replace', revision: 1, mediaRef: replacement.mediaRef });
    assert.equal((await f.governance.summary(f.context)).brokenCount, 0);
});

test('delete rechecks raced references, serializes true overlap with Consumer writes, and returns bounded partial batches', async t => {
    const f = await fixture(t), free = await f.image(), used = await f.image('blue');
    assert.equal((await f.governance.detail(f.context, used.mediaRef.assetId)).asset.referenceState, 'unreferenced');
    const metadata = f.media.metadata;
    let release, started;
    const entered = new Promise(resolve => { started = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    f.media.metadata = async (...args) => { started(); await barrier; return metadata(...args); };
    const write = f.business.commit(f.context, 'outfit', 1, 0, outfit(used.mediaRef));
    await entered;
    const deletion = f.governance.delete(f.context, used.mediaRef.assetId);
    release(); await write;
    await assert.rejects(deletion, { code: 'MEDIA_REFERENCED' });
    f.media.metadata = metadata;
    const missing = '12345678-1234-4123-8123-123456789abc';
    const batch = await f.governance.deleteBatch(f.context, [free.mediaRef.assetId, used.mediaRef.assetId, missing]);
    assert.equal(batch.deletedCount, 1); assert.equal(batch.retainedCount, 2);
    assert.deepEqual(batch.items.filter(item => !item.deleted).map(item => item.code), ['MEDIA_REFERENCED', 'MEDIA_NOT_FOUND']);
    await assert.rejects(f.governance.assets(f.context, { limit: 100000 }), { code: 'INVALID_REQUEST' });
    await assert.rejects(f.governance.deleteBatch(f.context, Array(49).fill(missing)), { code: 'INVALID_REQUEST' });
});

test('Character group unlink and changed URL recovery do not fetch sources, copy bytes or leak across users', async t => {
    const f = await fixture(t), asset = await f.image();
    const bound = await f.localization.bindExisting(f.context, { hostId: 'A.png', displayName: 'A', url, revision: 0, mediaRef: asset.mediaRef });
    await f.localization.bindExisting(f.context, { hostId: 'A.png', displayName: 'A', url: 'https://new-host.example/new.png',
        revision: bound.revision, mediaRef: asset.mediaRef });
    assert.equal((await f.media.storage(f.context)).assetCount, 1);
    assert.equal((await f.governance.detail(f.context, asset.mediaRef.assetId)).references.total, 2);
    assert.equal((await f.governance.assets(f.other)).total, 0);
    await card(path.join(f.other.userRoot, 'characters', 'A.png'), '2026-01-01');
    await assert.rejects(f.localization.bindExisting(f.other, { hostId: 'A.png', displayName: 'A', url,
        revision: 0, mediaRef: asset.mediaRef }), { code: 'MEDIA_NOT_FOUND' });
    const group = (await f.governance.groups(f.context)).items[0];
    const refs = (await f.governance.group(f.context, 'localization', group.id)).references.items;
    await assert.rejects(f.governance.action(f.context, { providerId: 'localization', groupId: group.id,
        referenceId: refs[0].id, action: 'unlink', revision: group.revision, hostId: 'Wrong.png' }), { code: 'HOST_IDENTITY_UNAVAILABLE' });
    await f.governance.action(f.context, { providerId: 'localization', groupId: group.id,
        referenceId: refs[0].id, action: 'unlink', revision: group.revision, hostId: 'A.png' });
    assert.equal((await f.media.storage(f.context)).assetCount, 1);
    assert.equal((await f.governance.detail(f.context, asset.mediaRef.assetId)).references.total, 1);
});

test('48-item batch scans each Consumer once and retains referenced/missing items', async t => {
    const f = await fixture(t), assets = [];
    for (let n = 0; n < 47; n++) assets.push(await f.image({ r: n, g: 42, b: 99 }));
    const used = assets.at(-1);
    await f.business.commit(f.context, 'outfit', 1, 0, outfit(used.mediaRef));
    const scans = { localization: 0, outfit: 0 };
    for (const provider of [f.localization.referenceProvider, f.business.referenceProvider]) {
        const enumerate = provider.enumerate;
        provider.enumerate = async context => { scans[provider.id]++; return enumerate(context); };
    }
    const missing = '12345678-1234-4123-8123-123456789abc';
    const result = await f.governance.deleteBatch(f.context, [...assets.map(asset => asset.mediaRef.assetId), missing]);
    assert.deepEqual(scans, { localization: 1, outfit: 1 });
    assert.equal(result.deletedCount, 46); assert.equal(result.retainedCount, 2);
    assert.deepEqual(result.items.slice(-2).map(item => item.code), ['MEDIA_REFERENCED', 'MEDIA_NOT_FOUND']);
    assert.equal((await f.media.storage(f.context)).assetCount, 1);
});

test('batch holds the coordinator across all deletions; a queued Consumer cannot bind an already-deleted item', async t => {
    const f = await fixture(t), first = await f.image(), second = await f.image('blue');
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const barrier = new Promise(resolve => { release = resolve; });
    const remove = f.media.delete;
    f.media.delete = async (context, id) => { if (id === first.mediaRef.assetId) { entered(); await barrier; } return remove(context, id); };
    const batch = f.governance.deleteBatch(f.context, [first.mediaRef.assetId, second.mediaRef.assetId]);
    await started;
    let settled = false;
    const write = f.business.commit(f.context, 'outfit', 1, 0, outfit(second.mediaRef)).finally(() => { settled = true; });
    const rejected = assert.rejects(write, { code: 'BUSINESS_MEDIA_UNAVAILABLE' });
    try {
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(settled, false);
        assert.equal((await f.business.read(f.context, 'outfit', 1)).revision, 0);
    } finally { release(); }
    assert.equal((await batch).deletedCount, 2);
    await rejected;
    assert.equal((await f.business.read(f.context, 'outfit', 1)).revision, 0);
});

test('incomplete batch analysis retains all existing items and scans the failed Provider once', async t => {
    const f = await fixture(t), first = await f.image(), second = await f.image('blue');
    let scans = 0;
    f.governance.register({ id: 'future', consumer: 'future', label: 'Future', enumerate: async () => { scans++; throw new Error('unavailable'); } });
    const result = await f.governance.deleteBatch(f.context, [first.mediaRef.assetId, second.mediaRef.assetId]);
    assert.equal(scans, 1); assert.equal(result.deletedCount, 0); assert.equal(result.retainedCount, 2);
    assert.ok(result.items.every(item => item.code === 'REFERENCE_ANALYSIS_INCOMPLETE'));
    assert.equal((await f.media.storage(f.context)).assetCount, 2);
});

test('group analysis counts unique exclusive/shared/missing assets; atomic unlink retains all files', async t => {
    const f = await fixture(t), first = await f.image(), shared = await f.image('blue');
    let revision = 0;
    for (const [n, mediaRef] of [first.mediaRef, first.mediaRef, shared.mediaRef].entries()) {
        revision = (await f.localization.bindExisting(f.context, { hostId: 'A.png', displayName: '角色 A', url: `https://example.com/${n}.png`, revision, mediaRef })).revision;
    }
    await f.business.commit(f.context, 'outfit', 1, 0, outfit(shared.mediaRef));
    const group = (await f.governance.groups(f.context)).items.find(item => item.consumer === 'character');
    const plan = await f.governance.group(f.context, group.providerId, group.id);
    assert.deepEqual(plan.usage, { assetCount: 2, exclusiveCount: 1, sharedCount: 1, missingCount: 0 });
    assert.equal(plan.references.items[0].asset.mime, 'image/png');
    await assert.rejects(f.governance.groupAction(f.context, { providerId: group.providerId, groupId: group.id, revision: 0, action: 'unlinkGroup', cleanup: false, hostId: 'A.png' }), { code: 'LOCALIZATION_CONFLICT' });
    const result = await f.governance.groupAction(f.context, { providerId: group.providerId, groupId: group.id, revision: group.revision, action: 'unlinkGroup', cleanup: false, hostId: 'A.png' });
    assert.equal(result.unlinkedCount, 3); assert.equal(result.deletedCount, 0); assert.equal(result.retainedCount, 2);
    assert.equal((await f.governance.group(f.context, group.providerId, group.id)).references.total, 0);
    assert.equal((await f.media.storage(f.context)).assetCount, 2);
});

test('group cleanup preserves shared assets and handles concurrent reference introduced after unlink', async t => {
    const f = await fixture(t), free = await f.image(), raced = await f.image('blue');
    let revision = 0;
    for (const [n, mediaRef] of [free.mediaRef, raced.mediaRef].entries()) revision = (await f.localization.bindExisting(f.context, { hostId: 'A.png', displayName: 'A', url: `https://example.com/${n}.png`, revision, mediaRef })).revision;
    const group = (await f.governance.groups(f.context)).items[0];
    const mutate = f.localization.referenceProvider.mutateGroup;
    f.localization.referenceProvider.mutateGroup = async (...args) => {
        const result = await mutate(...args);
        await f.business.commit(f.context, 'outfit', 1, 0, outfit(raced.mediaRef));
        return result;
    };
    const result = await f.governance.groupAction(f.context, { providerId: group.providerId, groupId: group.id, revision: group.revision, action: 'unlinkGroup', cleanup: true, hostId: 'A.png' });
    assert.equal(result.unlinkedCount, 2); assert.equal(result.deletedCount, 1); assert.equal(result.sharedCount, 1); assert.equal(result.retainedCount, 1);
    await assert.rejects(f.media.metadata(f.context, free.mediaRef.assetId), { code: 'MEDIA_NOT_FOUND' });
    assert.equal((await f.media.metadata(f.context, raced.mediaRef.assetId)).mediaRef.assetId, raced.mediaRef.assetId);
});

test('detached forget keeps originals; forget-cleanup is fail closed with unavailable Provider and reports partial deletion', async t => {
    const f = await fixture(t), first = await f.image(), second = await f.image('blue');
    let revision = 0;
    for (const [n, mediaRef] of [first.mediaRef, second.mediaRef].entries()) revision = (await f.localization.bindExisting(f.context, { hostId: 'A.png', displayName: 'A', url: `https://example.com/${n}.png`, revision, mediaRef })).revision;
    await unlink(path.join(f.context.userRoot, 'characters', 'A.png'));
    const group = (await f.governance.groups(f.context)).items[0];
    assert.equal(group.lifecycle, 'detached');
    f.governance.register({ id: 'future', consumer: 'worldbook', label: '世界书', enumerate: async () => { throw new Error('private'); } });
    assert.equal((await f.governance.group(f.context, group.providerId, group.id)).usage.exclusiveCount, null);
    const result = await f.governance.groupAction(f.context, { providerId: group.providerId, groupId: group.id, revision: group.revision, action: 'forgetGroup', cleanup: true });
    assert.equal(result.unlinkedCount, 2); assert.equal(result.deletedCount, 0); assert.equal(result.failedCount, 2); assert.equal(result.complete, false);
    assert.equal((await f.media.storage(f.context)).assetCount, 2);
    assert.equal((await f.governance.groups(f.context)).total, 0);
});

test('whole-group cleanup reports deletion failure separately and cannot cross users or changed host identity', async t => {
    const f = await fixture(t), first = await f.image(), second = await f.image('blue');
    let revision = 0;
    for (const [n, mediaRef] of [first.mediaRef, second.mediaRef].entries()) revision = (await f.localization.bindExisting(f.context, { hostId: 'A.png', displayName: 'A', url: `https://example.com/${n}.png`, revision, mediaRef })).revision;
    const group = (await f.governance.groups(f.context)).items[0], body = { providerId: group.providerId, groupId: group.id, revision: group.revision, action: 'unlinkGroup', cleanup: true, hostId: 'A.png' };
    await assert.rejects(f.governance.groupAction(f.other, body), { code: 'LOCALIZATION_CONFLICT' });
    await assert.rejects(f.governance.groupAction(f.context, { ...body, hostId: 'wrong.png' }), { code: 'HOST_IDENTITY_UNAVAILABLE' });
    const remove = f.media.delete; f.media.delete = async (owner, id) => { if (id === first.mediaRef.assetId) throw new Error('disk error'); return remove(owner, id); };
    const result = await f.governance.groupAction(f.context, body);
    assert.equal(result.unlinkedCount, 2); assert.equal(result.deletedCount, 1); assert.equal(result.failedCount, 1); assert.equal(result.retainedCount, 1);
    assert.equal((await f.governance.detail(f.context, first.mediaRef.assetId)).asset.referenceState, 'unreferenced');
});

test('group receipts count missing candidates once, separately from shared/retained or failed assets', async t => {
    for (const [cleanup, incomplete] of [[false, false], [true, false], [true, true]]) await t.test(`cleanup=${cleanup}, incomplete=${incomplete}`, async t => {
        const f = await fixture(t), missing = await f.image(), free = await f.image('blue'), shared = await f.image('green');
        let revision = 0;
        for (const [n, mediaRef] of [missing.mediaRef, missing.mediaRef, free.mediaRef, shared.mediaRef].entries()) {
            revision = (await f.localization.bindExisting(f.context, { hostId: 'A.png', displayName: 'A', url: `https://example.com/${n}.png`, revision, mediaRef })).revision;
        }
        await f.business.commit(f.context, 'outfit', 1, 0, outfit(shared.mediaRef));
        await f.media.delete(f.context, missing.mediaRef.assetId);
        f.governance.register({ id: 'broken-shared', consumer: 'worldbook', label: '世界书', enumerate: async () => [{ id: 'book', label: 'Book', lifecycle: 'active', revision: 0,
            references: [{ id: 'image', mediaRef: missing.mediaRef }] }] });
        if (incomplete) f.governance.register({ id: 'unavailable', consumer: 'future', label: 'Future', enumerate: async () => { throw new Error('unavailable'); } });
        const group = (await f.governance.groups(f.context)).items.find(group => group.consumer === 'character');
        assert.equal((await f.governance.group(f.context, group.providerId, group.id)).usage.missingCount, 1);
        const result = await f.governance.groupAction(f.context, { providerId: group.providerId, groupId: group.id, revision: group.revision, hostId: 'A.png', action: 'unlinkGroup', cleanup });
        assert.equal(result.unlinkedCount, 4); assert.equal(result.missingCount, 1);
        assert.equal(result.deletedCount, cleanup && !incomplete ? 1 : 0);
        assert.equal(result.retainedCount, cleanup && !incomplete ? 1 : 2);
        assert.equal(result.sharedCount, cleanup && !incomplete ? 1 : 0);
        assert.equal(result.failedCount, incomplete ? 2 : 0);
        assert.equal(result.deletedCount + result.retainedCount + result.missingCount, 3);
        assert.equal((await f.media.metadata(f.context, shared.mediaRef.assetId)).mediaRef.assetId, shared.mediaRef.assetId);
    });
});

test('Group and paged inventory reads do not scan Storage; Summary still provides authoritative storage', async t => {
    const f = await fixture(t), asset = await f.image();
    await f.business.commit(f.context, 'outfit', 1, 0, outfit(asset.mediaRef));
    let scans = 0; const storage = f.media.storage;
    f.media.storage = async (...args) => { scans++; return storage(...args); };
    assert.equal((await f.governance.group(f.context, 'outfit', 'coat')).usage.exclusiveCount, 1);
    await f.governance.groups(f.context); await f.governance.assets(f.context); await f.governance.detail(f.context, asset.mediaRef.assetId);
    assert.equal(scans, 0);
    assert.equal((await f.governance.summary(f.context)).storage.assetCount, 1); assert.equal(scans, 1);
});

test('scoped Group queries reach smaller Consumers after a full Character page and always expose all Provider identities', async t => {
    const f = await fixture(t), asset = await f.image();
    await f.business.commit(f.context, 'outfit', 1, 0, outfit(asset.mediaRef));
    const governance = createGovernance(f.media, f.coordinate);
    governance.register({ id: 'characters', consumer: 'character', label: '角色本地化', enumerate: async () => Array.from({ length: 31 }, (_, n) => ({ id: String(n), label: `角色 ${n}`, lifecycle: 'active', revision: 1, references: [{ id: 'image', mediaRef: asset.mediaRef }] })) });
    governance.register(f.business.referenceProvider);
    governance.register({ id: 'future', consumer: 'worldbook', label: '世界书', enumerate: async () => [{ id: 'book', label: 'Book', lifecycle: 'active', revision: 1, references: [{ id: 'image', mediaRef: asset.mediaRef }] }] });
    const first = await governance.groups(f.context, { limit: 24 });
    assert.equal(first.items.length, 24); assert(first.items.every(group => group.consumer === 'character'));
    assert.deepEqual(first.providers.map(provider => provider.consumer), ['character', 'outfit', 'worldbook']);
    assert.equal(first.total, 33);
    assert.equal((await governance.groups(f.context, { consumer: 'outfit', limit: 24 })).items[0].label, '黑色礼服');
    assert.equal((await governance.groups(f.context, { consumer: 'worldbook', limit: 24 })).items[0].id, 'book');
});

test('Group-owned host maintenance retains Server checks against another existing host and replaced Character identity', async t => {
    const f = await fixture(t), asset = await f.image();
    await card(path.join(f.context.userRoot, 'characters', 'B.png'), '2026-01-02', 'B');
    await f.localization.bindExisting(f.context, { hostId: 'A.png', displayName: 'A', url, revision: 0, mediaRef: asset.mediaRef });
    const group = (await f.governance.groups(f.context)).items[0], reference = (await f.governance.group(f.context, group.providerId, group.id)).references.items[0];
    const body = { providerId: group.providerId, groupId: group.id, revision: group.revision, hostId: 'B.png' };
    await assert.rejects(f.governance.action(f.context, { ...body, referenceId: reference.id, action: 'unlink' }), { code: 'HOST_IDENTITY_UNAVAILABLE' });
    await assert.rejects(f.governance.action(f.context, { ...body, referenceId: reference.id, action: 'replace', mediaRef: asset.mediaRef }), { code: 'HOST_IDENTITY_UNAVAILABLE' });
    await assert.rejects(f.governance.groupAction(f.context, { ...body, action: 'unlinkGroup', cleanup: true }), { code: 'HOST_IDENTITY_UNAVAILABLE' });
    assert.equal((await f.governance.group(f.context, group.providerId, group.id)).references.total, 1);
    await card(path.join(f.context.userRoot, 'characters', 'A.png'), '2026-02-01', 'replacement');
    await assert.rejects(f.governance.groupAction(f.context, { ...body, hostId: 'A.png', action: 'unlinkGroup', cleanup: true }), { code: 'LOCALIZATION_CONFLICT' });
    assert.equal((await f.media.metadata(f.context, asset.mediaRef.assetId)).mediaRef.assetId, asset.mediaRef.assetId);
    const detached = (await f.governance.group(f.context, group.providerId, group.id)).group;
    assert.equal(detached.lifecycle, 'detached'); assert.equal(detached.referenceCount, 1);
});

test('Consumer overview analyzes inventory once, bounds previews and preserves empty/unavailable identities', async () => {
    let catalogs = 0, storage = 0; const reads = new Map();
    const governance = createGovernance({ async catalog() { catalogs++; return []; }, async storage() { storage++; throw Error('unexpected storage'); } }, (_context, work) => work());
    for (const [consumer, count] of [['character', 100], ['outfit', 4], ['worldbook', 26], ['empty', 0], ['offline', null]]) governance.register({ id: consumer, consumer, label: consumer, async enumerate() {
        reads.set(consumer, (reads.get(consumer) || 0) + 1); if (count === null) throw Error('private');
        return Array.from({ length: count }, (_, n) => ({ id: `${consumer}-${n}`, label: `Group ${n}`, lifecycle: n % 2 ? 'detached' : 'active', revision: 1, references: [{ id: 'ref', mediaRef: { provider: 'server', assetId: '12345678-1234-4123-8123-123456789012' } }] }));
    } });
    const result = await governance.groupOverview({}, { previewLimit: '6' });
    assert.equal(catalogs, 1); assert.equal(storage, 0); assert([...reads.values()].every(value => value === 1));
    assert.equal(result.complete, false); assert.deepEqual(result.sections.map(section => section.total), [100, 4, 26, 0, null]);
    assert.deepEqual(result.sections.map(section => section.items.length), [6, 4, 6, 0, 0]);
    assert(result.sections[0].items.every(group => group.brokenCount === 1));
    assert(!JSON.stringify(result).includes('mediaRef')); assert(!JSON.stringify(result).includes('private'));
    const filtered = await governance.groupOverview({}, { search: 'Group 99', broken: 'true', previewLimit: 3 });
    assert.equal(filtered.sections[0].total, 1); assert.equal(filtered.sections[0].items[0].id, 'character-99');
    assert.equal(filtered.sections[1].total, 0); assert.equal(filtered.sections[4].total, null);
    assert.equal((await governance.groups({}, { provider: 'outfit', limit: 24 })).total, 4);
    for (const query of [{ previewLimit: 7 }, { previewLimit: 0 }, { offset: 1 }, { provider: {} }, { consumer: 'x'.repeat(161) }]) await assert.rejects(governance.groupOverview({}, query), { code: 'INVALID_REQUEST' });
});

test('browse totals exclude Active empty scopes before pagination without changing analysis or Provider health', async () => {
    const mediaRef = { provider: 'server', assetId: '12345678-1234-4123-8123-123456789012' };
    const records = Array.from({ length: 49 }, (_, n) => [
        { id: `empty-${n}`, label: `Empty ${n}`, lifecycle: 'active', revision: 1, references: [] },
        { id: `used-${n}`, label: `Used ${n}`, lifecycle: 'active', revision: 1, references: [{ id: 'image', mediaRef }] }
    ]).flat();
    const governance = createGovernance({ catalog: async () => [{ mediaRef }] }, (_context, work) => work());
    governance.register({ id: 'characters', consumer: 'character', label: '角色本地化', enumerate: async () => records });
    governance.register({ id: 'offline', consumer: 'worldbook', label: '世界书', enumerate: async () => { throw Error('unavailable'); } });
    const overview = await governance.groupOverview({});
    assert.equal(overview.complete, false);
    assert.equal(overview.sections[0].total, 49);
    assert(overview.sections[0].items.every(group => group.referenceCount === 1));
    assert.equal(overview.sections[1].state, 'unavailable'); assert.equal(overview.sections[1].total, null);
    const seen = [];
    for (const offset of [0, 24, 48]) {
        const page = await governance.groups({}, { consumer: 'character', state: 'active', offset, limit: 24 });
        assert.equal(page.total, 49); assert.equal(page.items.length, offset === 48 ? 1 : 24);
        assert.equal(page.hasMore, offset < 48); seen.push(...page.items.map(group => group.id));
        assert.equal(page.providers[1].state, 'unavailable'); assert.equal(page.complete, false);
    }
    assert.deepEqual(seen, records.filter(group => group.id.startsWith('used-')).map(group => group.id));
    assert.equal((await governance.groups({}, { provider: 'characters', search: 'Empty' })).total, 0);
    assert.equal((await governance.groupOverview({}, { consumer: 'character', search: 'Empty' })).sections[0].total, 0);
    assert.equal((await governance.analysis({})).groups.length, 98);
    assert.equal((await governance.group({}, 'characters', 'empty-0')).references.total, 0);
});

test('real empty Character records are hidden only while Active and remain eligible for Detached rebind and removal', async t => {
    const f = await fixture(t), asset = await f.image();
    await f.localization.bindExisting(f.context, { hostId: 'A.png', displayName: 'A', url, revision: 0, mediaRef: asset.mediaRef });
    const initial = (await f.governance.groups(f.context)).items[0];
    await f.governance.groupAction(f.context, { providerId: initial.providerId, groupId: initial.id, revision: initial.revision, action: 'unlinkGroup', cleanup: false, hostId: 'A.png' });
    assert.equal((await f.governance.groups(f.context)).total, 0);
    assert.equal((await f.governance.groupOverview(f.context)).sections[0].total, 0);
    assert.equal((await f.governance.analysis(f.context)).groups.length, 1);
    assert.equal((await f.governance.group(f.context, initial.providerId, initial.id)).group.referenceCount, 0);
    await unlink(path.join(f.context.userRoot, 'characters', 'A.png'));
    const detached = (await f.governance.groups(f.context, { state: 'detached' })).items[0];
    assert.equal(detached.id, initial.id); assert.equal(detached.referenceCount, 0);
    assert.equal((await f.governance.groupOverview(f.context, { state: 'detached' })).sections[0].total, 1);
    assert.deepEqual((await f.governance.group(f.context, detached.providerId, detached.id)).usage, { assetCount: 0, exclusiveCount: 0, sharedCount: 0, missingCount: 0 });
    await card(path.join(f.context.userRoot, 'characters', 'B.png'), '2026-01-02', 'B');
    await f.governance.action(f.context, { providerId: detached.providerId, groupId: detached.id, revision: detached.revision, action: 'rebind', hostId: 'B.png', displayName: 'B' });
    assert.equal((await f.governance.groups(f.context)).total, 0);
    assert.equal((await f.governance.group(f.context, detached.providerId, detached.id)).group.hostId, 'B.png');
    await unlink(path.join(f.context.userRoot, 'characters', 'B.png'));
    const restored = (await f.governance.groups(f.context, { state: 'detached' })).items[0];
    const removed = await f.governance.groupAction(f.context, { providerId: restored.providerId, groupId: restored.id, revision: restored.revision, action: 'forgetGroup', cleanup: false });
    assert.equal(removed.unlinkedCount, 0); assert.equal(removed.deletedCount, 0);
    assert.equal((await f.governance.analysis(f.context)).groups.length, 0);
    assert.equal((await f.media.metadata(f.context, asset.mediaRef.assetId)).mediaRef.assetId, asset.mediaRef.assetId);
});
