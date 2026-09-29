import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, unlink, rename, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLocalization } from '../src/localization/index.js';
import { BusinessStore } from '../src/business/store.js';
import { card } from './localization-fixture.js';

async function user(t) {
    const userRoot = await mkdtemp(path.join(tmpdir(), 'ttb-localization-'));
    await mkdir(path.join(userRoot, 'characters'));
    t.after(() => rm(userRoot, { recursive: true, force: true }));
    return { userRoot };
}
const url = 'https://img.example/a.gif?token=do-not-store';
const asset = '12345678-1234-4123-8123-123456789abc';
const updatedAsset = '12345678-1234-4123-8123-123456789abd';

test('edit survives atomic replacement, duplicate stays separate, rename detaches, reimport and manual rebind', async t => {
    const alice = await user(t), bob = await user(t);
    const file = id => path.join(alice.userRoot, 'characters', id);
    await card(file('A.png'), '2025-01-01', 'A');
    await card(file('B.png'), '2025-02-01', 'B');
    await card(path.join(bob.userRoot, 'characters', 'A.png'), '2025-01-01', 'A');
    let imports = 0, deleted = 0;
    const media = { async remoteImport() {
        imports++;
        return { mediaRef: { provider: 'server', assetId: asset } };
    }, async delete() { deleted++; } };
    const service = createLocalization(media);
    await service.definition.initialize();
    t.after(() => service.definition.shutdown());
    const first = await service.read(alice, 'A.png');
    assert.equal(first.revision, 0);
    const localized = await service.localize(alice, { hostId: 'A.png', displayName: 'A', url, revision: 0 });
    assert.equal(localized.current.bindings.length, 1);
    assert.equal(imports, 1);
    const stored = await service.read(alice, 'A.png');
    assert.equal(JSON.stringify(stored).includes(url), false);
    assert.deepEqual((await service.resolve(alice, 'A.png', url)).mediaRef,
        { provider: 'server', assetId: asset });
    await card(file('A.tmp.png'), '2025-01-01', 'A edited');
    await rename(file('A.tmp.png'), file('A.png'));
    assert.deepEqual((await service.resolve(alice, 'A.png', url)).mediaRef,
        { provider: 'server', assetId: asset });
    assert.equal((await service.read(alice, 'A.png')).current.id, localized.current.id);
    await writeFile(file('A_1.png'), await readFile(file('A.png')));
    assert.equal((await service.resolve(alice, 'A_1.png', url)).mediaRef, null);
    assert.equal((await service.resolve(alice, 'B.png', url)).mediaRef, null);
    assert.equal((await service.resolve(bob, 'A.png', url)).mediaRef, null);
    await assert.rejects(service.unlocalize(alice, { hostId: 'A.png', url, revision: 0 }),
        { code: 'LOCALIZATION_CONFLICT' });
    await rename(file('A.png'), file('Renamed.png'));
    assert.equal((await service.resolve(alice, 'Renamed.png', url)).mediaRef, null);
    const renamed = await service.read(alice, 'Renamed.png');
    assert.equal(renamed.current, null);
    assert.equal(renamed.detached.length, 1);
    await unlink(file('Renamed.png'));
    await card(file('Renamed.png'), '2026-02-02', 'A imported');
    const reimported = await service.read(alice, 'Renamed.png');
    assert.equal(reimported.current, null);
    assert.equal(reimported.detached.length, 1);
    assert.equal(reimported.detached[0].bindingCount, 1);
    assert.equal((await service.resolve(alice, 'Renamed.png', url)).mediaRef, null);
    assert.equal(renamed.detached[0].id, reimported.detached[0].id);
    const rebound = await service.rebind(alice, { hostId: 'Renamed.png', displayName: 'A imported',
        scopeId: reimported.detached[0].id, revision: reimported.revision });
    assert.equal(rebound.current.bindings.length, 1);
    const removed = await service.unlocalize(alice, { hostId: 'Renamed.png', url, revision: rebound.revision });
    assert.equal(removed.current.bindings.length, 0);
    assert.equal(deleted, 0);
});

test('failed import and stale revision never change the binding', async t => {
    const owner = await user(t);
    await card(path.join(owner.userRoot, 'characters', 'A.png'), '2025-01-01');
    let failImport = false;
    const service = createLocalization({ async remoteImport() {
        if (failImport) throw new Error('QUOTA_EXCEEDED');
        return { mediaRef: { provider: 'server', assetId: asset } };
    } });
    await service.definition.initialize();
    t.after(() => service.definition.shutdown());
    failImport = true;
    await assert.rejects(service.localize(owner, { hostId: 'A.png', displayName: 'A', url, revision: 0 }),
        { message: 'QUOTA_EXCEEDED' });
    assert.equal((await service.read(owner, 'A.png')).revision, 0);
    failImport = false;
    await service.localize(owner, { hostId: 'A.png', displayName: 'A', url, revision: 0 });
    await assert.rejects(service.localize(owner, { hostId: 'A.png', displayName: 'A', url, revision: 0 }),
        { code: 'LOCALIZATION_CONFLICT' });
    assert.deepEqual((await service.resolve(owner, 'A.png', url)).mediaRef,
        { provider: 'server', assetId: asset });
});

test('old inode scopes migrate detached without blocking transient access or explicit rebind', async t => {
    const owner = await user(t);
    await card(path.join(owner.userRoot, 'characters', 'A.png'), '2025-01-01');
    const { DatabaseSync } = await import('node:sqlite');
    const store = new BusinessStore(owner.userRoot, DatabaseSync);
    await store.initialize();
    store.commit('character-localization', 1, 0, { scopes: [{
        id: asset, hostId: 'A.png', proof: 'a'.repeat(64), displayName: 'Old A',
        createdAt: '2025-01-01', detachedAt: null,
        bindings: [{ locatorKey: (await import('node:crypto')).createHash('sha256').update(url).digest('hex'),
            mediaRef: { provider: 'server', assetId: asset } }],
    }] });
    store.close();
    const service = createLocalization({});
    await service.definition.initialize();
    t.after(() => service.definition.shutdown());
    const first = await service.resolve(owner, 'A.png', url);
    assert.equal(first.mediaRef, null);
    assert.equal(first.identityAvailable, true);
    const catalog = await service.read(owner, 'A.png');
    assert.equal(catalog.current, null);
    assert.equal(catalog.detached.length, 1);
    const rebound = await service.rebind(owner, { hostId: 'A.png', scopeId: asset,
        displayName: 'A', revision: catalog.revision });
    assert.equal(rebound.current.bindings.length, 1);
    assert.deepEqual((await service.resolve(owner, 'A.png', url)).mediaRef,
        { provider: 'server', assetId: asset });
});

test('same filename imported with a new create_date never inherits the old binding', async t => {
    const owner = await user(t);
    const filename = path.join(owner.userRoot, 'characters', 'A.png');
    await card(filename, '2025-01-01');
    const service = createLocalization({ async remoteImport() {
        return { mediaRef: { provider: 'server', assetId: asset } };
    } });
    await service.definition.initialize();
    t.after(() => service.definition.shutdown());
    await service.localize(owner, { hostId: 'A.png', displayName: 'A', url, revision: 0 });
    await unlink(filename);
    await card(filename, '2026-03-03');
    const resolved = await service.resolve(owner, 'A.png', url);
    assert.equal(resolved.mediaRef, null);
    assert.equal(resolved.identityAvailable, true);
    const catalog = await service.read(owner, 'A.png');
    assert.equal(catalog.current, null);
    assert.equal(catalog.detached.length, 1);
    await card(path.join(owner.userRoot, 'characters', 'B.png'), '2026-04-04');
    const other = await service.resolve(owner, 'B.png', url);
    assert.equal(other.mediaRef, null);
    assert.equal(other.identityAvailable, true);
});

test('missing host create_date disables binding but leaves remote resolution available', async t => {
    const owner = await user(t);
    await writeFile(path.join(owner.userRoot, 'characters', 'Legacy.png'), 'PNG without card metadata');
    const service = createLocalization({});
    await service.definition.initialize();
    t.after(() => service.definition.shutdown());
    assert.deepEqual(await service.resolve(owner, 'Legacy.png', url),
        { scopeId: null, mediaRef: null, identityAvailable: false });
    await assert.rejects(service.read(owner, 'Legacy.png'), { code: 'HOST_IDENTITY_UNAVAILABLE' });
});

test('two clients share one user Catalog; failed update preserves the old MediaRef', async t => {
    const owner = await user(t);
    await card(path.join(owner.userRoot, 'characters', 'A.png'), '2025-01-01');
    let nextAsset = asset, deleted = 0;
    const media = { async remoteImport() {
        if (nextAsset === null) throw new Error('REMOTE_TIMEOUT');
        return { mediaRef: { provider: 'server', assetId: nextAsset } };
    }, async delete() { deleted++; } };
    const phone = createLocalization(media), desktop = createLocalization(media);
    await phone.definition.initialize(); await desktop.definition.initialize();
    t.after(async () => { await phone.definition.shutdown(); await desktop.definition.shutdown(); });
    const first = await phone.localize(owner, { hostId: 'A.png', displayName: 'A', url, revision: 0 });
    assert.deepEqual((await desktop.resolve(owner, 'A.png', url)).mediaRef,
        { provider: 'server', assetId: asset });
    nextAsset = null;
    await assert.rejects(desktop.localize(owner, { hostId: 'A.png', displayName: 'A', url,
        revision: first.revision }), { message: 'REMOTE_TIMEOUT' });
    assert.deepEqual((await phone.resolve(owner, 'A.png', url)).mediaRef,
        { provider: 'server', assetId: asset });
    nextAsset = updatedAsset;
    const updated = await desktop.localize(owner, { hostId: 'A.png', displayName: 'A', url,
        revision: first.revision });
    assert.deepEqual((await phone.resolve(owner, 'A.png', url)).mediaRef,
        { provider: 'server', assetId: updatedAsset });
    await assert.rejects(phone.localize(owner, { hostId: 'A.png', displayName: 'A', url,
        revision: first.revision }), { code: 'LOCALIZATION_CONFLICT' });
    assert.deepEqual((await desktop.resolve(owner, 'A.png', url)).mediaRef,
        { provider: 'server', assetId: updatedAsset });
    await phone.unlocalize(owner, { hostId: 'A.png', url, revision: updated.revision });
    assert.equal((await desktop.resolve(owner, 'A.png', url)).mediaRef, null);
    assert.equal(deleted, 0);
});
