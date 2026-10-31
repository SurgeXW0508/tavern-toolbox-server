import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, copyFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createAccountDocuments } from '../src/account-documents/store.js';
import { outfitSettingsConsumer, OUTFIT_LIMITS } from '../src/account-documents/outfit.js';

const config = { policy: { core: { allowedOrigins: ['https://example.test'] } } };
const settings = () => ({ settingsVersion: 5, injectionEnabled: true, injectionPosition: 'compatibility',
    activeNarrativePresetId: 'custom-1', customNarrativePresets: [{ id: 'custom-1', name: 'Example', builtin: false,
        protocols: { fixed: 'Synthetic fixed', scene: 'Synthetic scene', mixed: 'Synthetic mixed' } }] });
const commit = (s, c, revision = 0, payload = settings()) => s.commit(c, 'outfit-settings', { schemaVersion: 1, expectedRevision: revision, payload });
async function fixture(t) {
    const root = await mkdtemp(path.join(tmpdir(), 'ttb-documents-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const s = createAccountDocuments(config); await s.definition.initialize(); t.after(() => s.definition.shutdown());
    return { root, s, alice: { userRoot: path.join(root, 'alice') }, bob: { userRoot: path.join(root, 'bob') } };
}

test('registered documents isolate users and revisions; independent clients compete with atomic CAS', async t => {
    const { s, alice, bob } = await fixture(t);
    const other = createAccountDocuments(config); await other.definition.initialize(); t.after(() => other.definition.shutdown());
    assert.deepEqual(await s.read(alice, 'outfit-settings', 1), { documentId: 'outfit-settings', schemaVersion: 1, revision: 0, payload: null });
    const results = await Promise.allSettled([commit(s, alice), commit(other, alice)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(results.find(r => r.status === 'rejected').reason.code, 'REVISION_CONFLICT');
    assert.deepEqual((await other.read(alice, 'outfit-settings', 1)).payload, settings());
    assert.equal((await s.read(bob, 'outfit-settings', 1)).revision, 0);
    assert.throws(() => s.read(alice, '../unregistered', 1), { code: 'DOCUMENT_NOT_REGISTERED' });
    assert.throws(() => s.read(alice, 'outfit-settings', 2), { code: 'DOCUMENT_SCHEMA_INCOMPATIBLE' });
    assert.equal((await stat(path.join(alice.userRoot, 'tavern-toolbox-server/account-documents-v1/documents.sqlite'))).mode & 0o777, 0o600);
});

test('all invalid fields, duplicates, builtins and capacity failures reject the complete document', async t => {
    const { s, alice } = await fixture(t);
    const invalid = [p => p.settingsVersion = 4, p => p.injectionEnabled = 1, p => p.injectionPosition = 'user',
        p => p.userId = 'bob', p => p.customNarrativePresets[0].protocols.fixed = '',
        p => p.customNarrativePresets[0].protocols.fixed = 'x'.repeat(8001),
        p => delete p.customNarrativePresets[0].protocols.scene,
        p => p.customNarrativePresets.push(p.customNarrativePresets[0]),
        p => p.customNarrativePresets[0].id = 'balanced', p => p.customNarrativePresets[0].name = 'n'.repeat(81),
        p => p.customNarrativePresets = Array.from({ length: 129 }, (_, i) => ({ ...p.customNarrativePresets[0], id: 'custom-' + i }))];
    for (const change of invalid) {
        const p = settings(); change(p);
        assert.throws(() => commit(s, alice, 0, p), { code: 'DOCUMENT_INVALID' });
    }
    const p = settings();
    p.customNarrativePresets = Array.from({ length: 128 }, (_, i) => ({ id: 'c-' + i, name: 'Example', builtin: false,
        protocols: { fixed: 'x'.repeat(8000), scene: 'x'.repeat(8000), mixed: 'x'.repeat(8000) } }));
    assert.throws(() => commit(s, alice, 0, p), { code: 'DOCUMENT_TOO_LARGE' });
    assert.equal((await s.read(alice, 'outfit-settings', 1)).revision, 0);
    assert.equal(OUTFIT_LIMITS.maxDocumentBytes, 1024 * 1024);
    assert.equal((await commit(s, alice)).revision, 1);
});

test('foundation accepts a separately registered consumer without knowing its business model', async t => {
    const { alice } = await fixture(t);
    const s = createAccountDocuments(config, { consumers: [outfitSettingsConsumer,
        { id: 'synthetic-test', schemaVersion: 7, maxBytes: 100, validate: v => { assert.equal(typeof v.value, 'boolean'); return v; } }] });
    await s.definition.initialize(); t.after(() => s.definition.shutdown());
    await commit(s, alice);
    const second = await s.commit(alice, 'synthetic-test', { schemaVersion: 7, expectedRevision: 0, payload: { value: true } });
    assert.equal(second.revision, 1);
    assert.equal((await s.read(alice, 'outfit-settings', 1)).revision, 1);
});

test('restart and stopped restore retain payloads; incompatible storage is preserved and fails closed', async t => {
    const { s, root, alice } = await fixture(t);
    const file = path.join(alice.userRoot, 'tavern-toolbox-server/account-documents-v1/documents.sqlite');
    await commit(s, alice); s.definition.shutdown(); await copyFile(file, path.join(root, 'backup.sqlite'));
    const next = createAccountDocuments(config); await next.definition.initialize();
    assert.equal((await next.read(alice, 'outfit-settings', 1)).revision, 1);
    await commit(next, alice, 1, { ...settings(), injectionEnabled: false }); next.definition.shutdown();
    await copyFile(path.join(root, 'backup.sqlite'), file);
    const restored = createAccountDocuments(config); await restored.definition.initialize();
    assert.equal((await restored.read(alice, 'outfit-settings', 1)).revision, 1); restored.definition.shutdown();
    const db = new DatabaseSync(file); db.exec('PRAGMA user_version=99'); db.close();
    const incompatible = createAccountDocuments(config); await incompatible.definition.initialize(); t.after(() => incompatible.definition.shutdown());
    await assert.rejects(incompatible.read(alice, 'outfit-settings', 1), { code: 'DOCUMENT_STORE_SCHEMA_INCOMPATIBLE' });
    const check = new DatabaseSync(file); assert.equal(check.prepare('PRAGMA user_version').get().user_version, 99); check.close();
});

test('HTTP enforces session/context/origin/CSRF, restart rejects old context, and module failure isolates Business', async t => {
    const { default: express } = await import('express'); const { once } = await import('node:events');
    const { createCore } = await import('../src/core.js');
    const { root } = await fixture(t); let core, router;
    async function start() {
        core = await createCore({ logger: { info() {}, error() {} }, policyOptions: { configPath: path.join(root, 'policy.json'),
            read: async () => JSON.stringify({ schemaVersion: 1, core: { allowedOrigins: ['https://example.test'] } }) } });
        router = express.Router(); core.attach(router);
    }
    await start(); t.after(() => core.shutdown());
    const app = express(); app.use(express.json({ limit: '2mb' })); app.use((req, res, next) => {
        const user = req.headers['x-test-user'];
        if (['alice', 'bob'].includes(user)) req.user = { profile: { handle: user, enabled: true }, directories: { root: path.join(root, user) } };
        req.session = { csrfToken: 'fixture-csrf' }; next();
    }); app.use((req, res, next) => router(req, res, next));
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
    const base = 'http://127.0.0.1:' + server.address().port;
    const status = async (user = 'alice') => (await (await fetch(base + '/v1/status', { headers: { 'X-Test-User': user, 'X-TTB-Protocol': '1.0' } })).json()).data;
    let context = (await status()).contextId;
    const call = async (payload, extra = {}, id = 'outfit-settings') => {
        const response = await fetch(base + '/v1/account/documents/' + id + (payload ? '/commit' : '?schemaVersion=1'), {
            method: payload ? 'POST' : 'GET', headers: { 'X-Test-User': 'alice', 'X-TTB-Protocol': '1.0',
                'X-TTB-Context': context, Origin: 'https://example.test', 'X-CSRF-Token': 'fixture-csrf', 'Content-Type': 'application/json', ...extra },
            ...(payload ? { body: JSON.stringify(payload) } : {}) });
        return { status: response.status, headers: response.headers, body: await response.json() };
    };
    const body = { schemaVersion: 1, expectedRevision: 0, payload: settings() };
    assert.equal((await call()).body.data.payload, null);
    assert.equal((await call(body)).status, 200);
    assert.equal((await call()).headers.get('cache-control'), 'private, no-store');
    assert.equal((await call(body)).status, 409);
    for (const extra of [{ Origin: 'https://foreign.example' }, { 'X-CSRF-Token': 'wrong' }, { 'Sec-Fetch-Site': 'cross-site' }])
        assert.equal((await call(body, extra)).status, 403);
    assert.equal((await call(null, { 'X-Test-User': '' })).status, 403);
    assert.equal((await call(null, { 'X-Test-User': 'bob' })).status, 409);
    assert.equal((await call(null, {}, 'unregistered')).status, 404);
    const old = context; await core.shutdown(); await start(); context = (await status()).contextId; assert.notEqual(context, old);
    assert.equal((await call({ ...body, expectedRevision: 1 }, { 'X-TTB-Context': old })).status, 409);
    assert.equal((await call(null, { 'X-TTB-Context': old })).status, 409);
    assert.equal((await call()).body.data.revision, 1);
    const file = path.join(root, 'alice/tavern-toolbox-server/account-documents-v1/documents.sqlite');
    const db = new DatabaseSync(file); db.exec('PRAGMA user_version=99'); db.close();
    const degraded = await status();
    assert.equal(degraded.capabilities.find(c => c.id === 'account.documents').state, 'unavailable');
    assert.equal(degraded.capabilities.find(c => c.id === 'business.collections').state, 'ready');
    const failed = await call(); assert.equal(failed.status, 503);
    assert(!JSON.stringify(failed.body).includes(root)); assert(!JSON.stringify(failed.body).includes('Synthetic fixed'));
});
