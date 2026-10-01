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
