import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BusinessStore, MAX_BUSINESS_BYTES } from '../src/business/store.js';
import { emptyOutfit, outfitMigration, validateOutfit, validateOutfitV1 } from '../src/business/outfit.js';

const stamp = '2026-01-01';
const base = (id, kind, fields) => ({ id, kind, name: id, category: '', tags: [], sceneTags: [],
    ownerPersonId: '', scope: { type: 'global', id: '', label: '' }, mediaRef: null, createdAt: stamp, updatedAt: stamp, ...fields });
function oldDocument() {
    return { assets: [base('item', 'item', { itemType: 'clothing', wearSlot: 'feet', modelDescription: 'unchanged',
        mediaRef: { provider: 'server', assetId: '12345678-1234-4123-8123-123456789abc' } }),
    base('kit', 'kit', { itemIds: ['item'], contextMode: 'itemized', overallEffect: '', relationNote: '', summaryDescription: '', note: '' }),
    base('outfit', 'outfit', { kitIds: ['kit'], defaultKitId: 'kit', note: '' })],
    persons: [{ id: 'person', name: 'Alice', createdAt: stamp, updatedAt: stamp }],
    wearStates: ['fixed', 'scene'].map((mode, index) => ({ chatId: 'chat-' + index, personId: 'person', mode,
        outfitId: index ? '' : 'outfit', kitId: '', wardrobeIds: [], extraItemIds: [], removedItemIds: [],
        perspectiveRole: 'ordinary', updatedAt: stamp })) };
}
async function fixture(t) {
    const root = await mkdtemp(path.join(tmpdir(), 'outfit-migration-'));
    const one = new BusinessStore(root, DatabaseSync), two = new BusinessStore(root, DatabaseSync);
    await one.initialize(); await two.initialize();
    t.after(async () => { one.close(); two.close(); await rm(root, { recursive: true, force: true }); });
    return { one, two };
}
const row = store => ({ ...store.db.prepare('SELECT * FROM collections WHERE namespace=?').get('outfit') });
const read = (store, migration = outfitMigration) => store.read('outfit', emptyOutfit(), 2, migration);

test('real SQLite: schema 1 migrates once across two connections and survives cold read with exact media/IDs/times', async t => {
    const { one, two } = await fixture(t), old = oldDocument();
    one.commit('outfit', 1, 0, old, validateOutfitV1);
    const results = await Promise.all([Promise.resolve().then(() => read(one)), Promise.resolve().then(() => read(two))]);
    for (const result of results) {
        assert.equal(result.schemaVersion, 2); assert.equal(result.revision, 2); validateOutfit(result.document);
        assert.deepEqual(result.document.assets, old.assets); assert.deepEqual(result.document.persons, old.persons);
        assert.deepEqual(result.document.wearStates[0].outfitComponents, [{ outfitId: 'outfit', kitId: 'kit' }]);
        assert.deepEqual(result.document.wearStates[1].outfitComponents, []);
        assert.equal(result.document.wearStates[0].updatedAt, stamp);
    }
    const saved = row(one); read(one); read(two); assert.deepEqual(row(one), saved);
    assert.equal(one.db.prepare('PRAGMA user_version').get().user_version, 1);
    assert.throws(() => one.read('outfit', emptyOutfit(), 1), { code: 'BUSINESS_SCHEMA_INCOMPATIBLE' });
    assert.throws(() => one.commit('outfit', 1, 2, old, validateOutfitV1), { code: 'BUSINESS_SCHEMA_INCOMPATIBLE' });
    assert.throws(() => one.commit('outfit', 2, 1, results[0].document, validateOutfit), { code: 'BUSINESS_CONFLICT' });
    assert.equal(two.commit('outfit', 2, 2, results[0].document, validateOutfit).revision, 3);
});

for (const failure of ['source', 'conversion', 'target', 'capacity', 'write']) {
    test(`real SQLite: ${failure} failure rolls back the exact schema-1 row and allows a later retry`, async t => {
        const { one } = await fixture(t); one.commit('outfit', 1, 0, oldDocument(), validateOutfitV1);
        const original = row(one), migration = { ...outfitMigration };
        if (failure === 'source') migration.validateSource = () => { throw Error('source'); };
        if (failure === 'conversion') migration.convert = () => { throw Error('conversion'); };
        if (failure === 'target') migration.validateTarget = () => { throw Error('target'); };
        if (failure === 'capacity') { migration.convert = () => ({ padding: 'x'.repeat(MAX_BUSINESS_BYTES) }); migration.validateTarget = () => {}; }
        if (failure === 'write') one.db.exec("CREATE TRIGGER fail_migration BEFORE UPDATE ON collections BEGIN SELECT RAISE(ABORT, 'interrupted'); END");
        assert.throws(() => read(one, migration)); assert.deepEqual(row(one), original);
        if (failure === 'write') one.db.exec('DROP TRIGGER fail_migration');
        assert.equal(read(one).revision, 2);
    });
}

test('invalid graph, corrupt JSON and unknown future schemas never turn into empty successful documents', async t => {
    const { one } = await fixture(t);
    one.commit('outfit', 1, 0, oldDocument(), validateOutfitV1);
    for (const value of ['{', JSON.stringify({ ...oldDocument(), wearStates: [{ ...oldDocument().wearStates[0], kitId: 'missing' }] })]) {
        one.db.prepare('UPDATE collections SET document=? WHERE namespace=?').run(value, 'outfit');
        const original = row(one); assert.throws(() => read(one), { code: 'BUSINESS_DATA_INVALID' }); assert.deepEqual(row(one), original);
    }
    one.db.exec('UPDATE collections SET schema_version=99');
    const original = row(one); assert.throws(() => read(one), { code: 'BUSINESS_SCHEMA_INCOMPATIBLE' }); assert.deepEqual(row(one), original);
});

test('schema 2 validates independent Kit ownership, duplicate Outfits, item kinds and unknown fields on the server', () => {
    const valid = outfitMigration.convert(oldDocument()); validateOutfit(valid);
    for (const modify of [w => w.outfitComponents.push({ ...w.outfitComponents[0] }),
        w => w.outfitComponents[0].kitId = 'item', w => w.outfitComponents[0].kitId = '',
        w => w.extraItemIds = ['outfit'], w => w.wearStateVersion = 3, w => w.outfitId = 'outfit']) {
        const document = structuredClone(valid); modify(document.wearStates[0]);
        assert.throws(() => validateOutfit(document), { code: 'BUSINESS_DATA_INVALID' });
    }
});
