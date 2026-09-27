import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, cp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BusinessStore } from '../src/business/store.js';
import { createBusiness } from '../src/business/index.js';
import { emptyOutfit, validateOutfit } from '../src/business/outfit.js';

async function root(t) {
    const dir = await mkdtemp(path.join(tmpdir(), 'ttb-business-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    return dir;
}
const sample = () => ({ assets: [
    { id: 'item-one', kind: 'item', name: 'Coat', category: '', tags: [], sceneTags: [],
        ownerPersonId: '', scope: { type: 'global', id: '', label: 'Global' }, mediaRef: null,
        createdAt: '2026-01-01', updatedAt: '2026-01-01', itemType: 'clothing',
        wearSlot: 'outer-layer', modelDescription: 'Black coat' },
], persons: [], wearStates: [] });

test('generic collection CAS persists complete document, rejects stale writes and isolates user roots', async t => {
    const alice = await root(t), bob = await root(t);
    const one = new BusinessStore(alice, DatabaseSync), two = new BusinessStore(alice, DatabaseSync);
    const other = new BusinessStore(bob, DatabaseSync);
    await Promise.all([one.initialize(), two.initialize(), other.initialize()]);
    assert.equal(one.read('outfit', emptyOutfit(), 1).revision, 0);
    const first = one.commit('outfit', 1, 0, sample(), validateOutfit);
    assert.equal(first.revision, 1);
    assert.deepEqual(two.read('outfit', emptyOutfit(), 1).document, sample());
    assert.deepEqual(other.read('outfit', emptyOutfit(), 1).document, emptyOutfit());
    assert.throws(() => two.commit('outfit', 1, 0, emptyOutfit(), validateOutfit), { code: 'BUSINESS_CONFLICT' });
    assert.equal(one.read('outfit', emptyOutfit(), 1).revision, 1);
    assert.throws(() => one.read('outfit', emptyOutfit(), 2), { code: 'BUSINESS_SCHEMA_INCOMPATIBLE' });
    one.close(); two.close(); other.close();
});

test('Outfit consumer validates graph, scope and logical media identity without local legacy state', () => {
    const document = sample();
    validateOutfit(document);
    assert.throws(() => validateOutfit({ ...document, pendingWearStates: [] }), { code: 'BUSINESS_DATA_INVALID' });
    assert.throws(() => validateOutfit({ ...document, assets: [{ ...document.assets[0], imageId: 'local-blob' }] }),
        { code: 'BUSINESS_DATA_INVALID' });
    assert.throws(() => validateOutfit({ ...document, assets: [{ ...document.assets[0], mediaRef: {
        provider: 'local', assetId: 'image-123' } }] }), { code: 'BUSINESS_DATA_INVALID' });
    assert.throws(() => validateOutfit({ ...document, assets: [{ ...document.assets[0], mediaRef: {
        provider: 'server', assetId: 'https://example.com/image.png' } }] }), { code: 'BUSINESS_DATA_INVALID' });
    assert.throws(() => validateOutfit({ ...document, assets: [{ ...document.assets[0], scope: {
        type: 'chat', id: '', label: 'Chat' } }] }), { code: 'BUSINESS_DATA_INVALID' });
    assert.throws(() => validateOutfit({ ...document, assets: [document.assets[0], {
        ...document.assets[0], scope: { type: 'chat', id: 'chat-2', label: 'Chat' },
    }] }), { code: 'BUSINESS_DATA_INVALID' }); // An ambiguous ID is rejected, never merged across scopes.
});

test('Business and Media ownership remain separate; missing old media can be repaired', async t => {
    const alice = await root(t), bob = await root(t);
    const seen = new Set();
    const media = { metadata: async (context, id) => {
        if (context.userRoot !== alice || !seen.has(id)) throw new Error('MEDIA_NOT_FOUND');
        return { mediaRef: { provider: 'server', assetId: id } };
    } };
    const business = createBusiness({ policy: { core: { allowedOrigins: ['https://example.com'] } } }, media);
    await business.definition.initialize();
    const ref = '12345678-1234-4123-8123-123456789abc';
    const document = sample(); document.assets[0].mediaRef = { provider: 'server', assetId: ref };
    await assert.rejects(business.commit({ userRoot: alice }, 'outfit', 1, 0, document),
        { code: 'BUSINESS_MEDIA_UNAVAILABLE' });
    seen.add(ref);
    const committed = await business.commit({ userRoot: alice }, 'outfit', 1, 0, document);
    assert.equal(committed.revision, 1);
    await assert.rejects(business.commit({ userRoot: bob }, 'outfit', 1, 0, document),
        { code: 'BUSINESS_MEDIA_UNAVAILABLE' });
    seen.clear();
    const renamed = structuredClone(document); renamed.assets[0].name = 'Repaired later';
    assert.equal((await business.commit({ userRoot: alice }, 'outfit', 1, 1, renamed)).revision, 2);
    const removed = emptyOutfit();
    await business.commit({ userRoot: alice }, 'outfit', 1, 2, removed);
    // Business deletion has no media.delete call; the asset remains independently owned.
    await business.definition.shutdown();
});

test('storage schema failure preserves data and cold copy restores revision', async t => {
    const source = await root(t), restored = await root(t);
    const store = new BusinessStore(source, DatabaseSync);
    await store.initialize();
    store.commit('outfit', 1, 0, sample(), validateOutfit);
    store.close();
    await cp(path.join(source, 'tavern-toolbox-server'), path.join(restored, 'tavern-toolbox-server'), { recursive: true });
    const copy = new BusinessStore(restored, DatabaseSync);
    await copy.initialize();
    assert.equal(copy.read('outfit', emptyOutfit(), 1).revision, 1);
    copy.close();
    const location = path.join(restored, 'tavern-toolbox-server', 'business-v1');
    await mkdir(location, { recursive: true });
    const db = new DatabaseSync(path.join(location, 'collections.sqlite'));
    db.exec('PRAGMA user_version = 99'); db.close();
    const newer = new BusinessStore(restored, DatabaseSync);
    await assert.rejects(newer.initialize(), { code: 'BUSINESS_STORAGE_INCOMPATIBLE' });
});
