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
    assert.equal((await f.governance.group(f.context, 'outfit', 'coat')).references.items[0].broken, true);
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
