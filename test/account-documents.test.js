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

test('ordinary read and health coexist with a reserved writer and see only committed state', async t => {
    const { s, alice } = await fixture(t); await commit(s, alice);
    const file = path.join(alice.userRoot, 'tavern-toolbox-server/account-documents-v1/documents.sqlite');
    const writer = new DatabaseSync(file);
    t.after(() => { try { writer.exec('ROLLBACK'); } finally { writer.close(); } });
    writer.exec('BEGIN IMMEDIATE'); writer.prepare('UPDATE documents SET revision=2 WHERE id=?').run('outfit-settings');
    assert.equal((await s.read(alice, 'outfit-settings', 1)).revision, 1);
    assert.equal((await s.definition.health(alice)).state, 'ready');
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

test('consumer migrations upgrade on demand with single revision bump, reject blind commit, and fail closed on incompatible or corrupt rows', async t => {
    const { alice, bob } = await fixture(t);
    const v1Consumer = {
        id: 'migratable-doc',
        schemaVersion: 1,
        maxBytes: 4096,
        validate: v => {
            if (!v || typeof v !== 'object' || typeof v.name !== 'string') throw new Error('bad v1');
            return v;
        },
    };
    const v2Consumer = {
        id: 'migratable-doc',
        schemaVersion: 2,
        maxBytes: 4096,
        validate: v => {
            if (!v || typeof v !== 'object' || typeof v.name !== 'string' || !['a', 'b'].includes(v.mode)) throw new Error('bad v2');
            return v;
        },
        migrations: [{
            fromVersion: 1,
            toVersion: 2,
            validateSource: v1Consumer.validate,
            convert: v => ({ ...v, mode: v.mode || 'a' }),
        }],
    };
    const v3Consumer = {
        id: 'migratable-doc',
        schemaVersion: 3,
        maxBytes: 4096,
        validate: v => {
            if (!v || typeof v !== 'object' || typeof v.name !== 'string' || !['a', 'b'].includes(v.mode) || v.tag !== 'v3') throw new Error('bad v3');
            return v;
        },
        migrations: [
            ...v2Consumer.migrations,
            {
                fromVersion: 2,
                toVersion: 3,
                validateSource: v2Consumer.validate,
                convert: v => ({ ...v, tag: 'v3' }),
            },
        ],
    };

    // Seed v1 row using v1 store
    const s1 = createAccountDocuments(config, { consumers: [v1Consumer] });
    await s1.definition.initialize(); t.after(() => s1.definition.shutdown());
    assert.equal((await s1.commit(alice, 'migratable-doc', { schemaVersion: 1, expectedRevision: 0, payload: { name: 'alpha' } })).revision, 1);

    // Blind commit against unmigrated v1 row fails with REVISION_CONFLICT (both rev 1 and rev 2) without mutating row
    let convertCount = 0;
    const countedV2 = {
        ...v2Consumer,
        migrations: [{
            ...v2Consumer.migrations[0],
            convert: v => { convertCount += 1; return { ...v, mode: v.mode || 'a' }; },
        }],
    };
    const s2a = createAccountDocuments(config, { consumers: [countedV2] });
    const s2b = createAccountDocuments(config, { consumers: [countedV2] });
    await s2a.definition.initialize(); t.after(() => s2a.definition.shutdown());
    await s2b.definition.initialize(); t.after(() => s2b.definition.shutdown());

    await assert.rejects(
        s2a.commit(alice, 'migratable-doc', { schemaVersion: 2, expectedRevision: 1, payload: { name: 'blind', mode: 'b' } }),
        { code: 'REVISION_CONFLICT' },
    );
    await assert.rejects(
        s2a.commit(alice, 'migratable-doc', { schemaVersion: 2, expectedRevision: 2, payload: { name: 'blind', mode: 'b' } }),
        { code: 'REVISION_CONFLICT' },
    );
    const file = path.join(alice.userRoot, 'tavern-toolbox-server/account-documents-v1/documents.sqlite');
    let rawRow = new DatabaseSync(file);
    assert.equal(rawRow.prepare('SELECT schema_version, revision FROM documents WHERE id=?').get('migratable-doc').schema_version, 1);
    assert.equal(rawRow.prepare('SELECT schema_version, revision FROM documents WHERE id=?').get('migratable-doc').revision, 1);
    rawRow.close();

    // Concurrent reads upgrade v1 -> v2 once and bump revision only once (1 -> 2)
    convertCount = 0;
    const [r1, r2] = await Promise.all([
        s2a.read(alice, 'migratable-doc', 2),
        s2b.read(alice, 'migratable-doc', 2),
    ]);
    assert.equal(r1.schemaVersion, 2);
    assert.equal(r2.schemaVersion, 2);
    assert.equal(r1.revision, 2);
    assert.equal(r2.revision, 2);
    assert.deepEqual(r1.payload, { name: 'alpha', mode: 'a' });
    assert.deepEqual(r2.payload, { name: 'alpha', mode: 'a' });
    assert.equal(convertCount, 1);

    // Subsequent commit at migrated revision succeeds
    const committed = await s2a.commit(alice, 'migratable-doc', { schemaVersion: 2, expectedRevision: 2, payload: { name: 'alpha', mode: 'b' } });
    assert.equal(committed.revision, 3);

    // Downgraded v1 store reading v2 DB fails closed with DOCUMENT_SCHEMA_INCOMPATIBLE and preserves DB
    await assert.rejects(s1.read(alice, 'migratable-doc', 1), { code: 'DOCUMENT_SCHEMA_INCOMPATIBLE' });

    // Multi-step chain v1 -> v2 -> v3 works in a single atomic revision bump
    await s1.commit(bob, 'migratable-doc', { schemaVersion: 1, expectedRevision: 0, payload: { name: 'beta' } });
    const s3 = createAccountDocuments(config, { consumers: [v3Consumer] });
    await s3.definition.initialize(); t.after(() => s3.definition.shutdown());
    const bobV3 = await s3.read(bob, 'migratable-doc', 3);
    assert.equal(bobV3.schemaVersion, 3);
    assert.equal(bobV3.revision, 2);
    assert.deepEqual(bobV3.payload, { name: 'beta', mode: 'a', tag: 'v3' });

    // Missing migration step fails closed with DOCUMENT_SCHEMA_INCOMPATIBLE
    const gapV3 = createAccountDocuments(config, {
        consumers: [{ ...v3Consumer, migrations: [v3Consumer.migrations[1]] }],
    });
    await gapV3.definition.initialize(); t.after(() => gapV3.definition.shutdown());
    rawRow = new DatabaseSync(file);
    rawRow.prepare('UPDATE documents SET schema_version=1, revision=5, payload=? WHERE id=?').run(JSON.stringify({ name: 'gap' }), 'migratable-doc');
    rawRow.close();
    await assert.rejects(gapV3.read(alice, 'migratable-doc', 3), { code: 'DOCUMENT_SCHEMA_INCOMPATIBLE' });

    // Corrupt v1 row fails closed with DOCUMENT_DATA_INVALID and leaves stored row untouched
    rawRow = new DatabaseSync(file);
    rawRow.prepare('UPDATE documents SET schema_version=1, revision=6, payload=? WHERE id=?').run(JSON.stringify({ name: 123 }), 'migratable-doc');
    rawRow.close();
    await assert.rejects(s2a.read(alice, 'migratable-doc', 2), { code: 'DOCUMENT_DATA_INVALID' });
    rawRow = new DatabaseSync(file);
    const untouched = rawRow.prepare('SELECT schema_version, revision FROM documents WHERE id=?').get('migratable-doc');
    assert.equal(untouched.schema_version, 1);
    assert.equal(untouched.revision, 6);
    rawRow.close();

    // Converted payload exceeding maxBytes fails with DOCUMENT_TOO_LARGE and rolls back
    const tightV2 = createAccountDocuments(config, {
        consumers: [{
            ...v2Consumer,
            maxBytes: 40,
            migrations: [{
                fromVersion: 1,
                toVersion: 2,
                validateSource: v1Consumer.validate,
                convert: v => ({ name: v.name + 'x'.repeat(50), mode: 'a' }),
            }],
        }],
    });
    await tightV2.definition.initialize(); t.after(() => tightV2.definition.shutdown());
    rawRow = new DatabaseSync(file);
    rawRow.prepare('UPDATE documents SET schema_version=1, revision=7, payload=? WHERE id=?').run(JSON.stringify({ name: 'ok' }), 'migratable-doc');
    rawRow.close();
    await assert.rejects(tightV2.read(alice, 'migratable-doc', 2), { code: 'DOCUMENT_TOO_LARGE' });
    rawRow = new DatabaseSync(file);
    assert.equal(rawRow.prepare('SELECT schema_version FROM documents WHERE id=?').get('migratable-doc').schema_version, 1);
    rawRow.close();
});
