import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { createCore } from '../src/core.js';
import { validatePolicy } from '../src/config.js';
import { createAudioRoutingPreferences } from '../src/preferences/audio-routing.js';

const configuration = { policy: validatePolicy({ schemaVersion: 1, core: { allowedOrigins: ['https://example.test'] } }) };
async function fixture(t) {
    const root = await mkdtemp(path.join(tmpdir(), 'ttb-preferences-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}

test('atomic user preferences survive restart, merge cross-client edits and isolate ST users without Network policy', async t => {
    const root = await fixture(t), alice = { userRoot: path.join(root, 'alice') }, bob = { userRoot: path.join(root, 'bob') };
    const desktop = createAudioRoutingPreferences(configuration), phone = createAudioRoutingPreferences(configuration);
    await desktop.definition.initialize(); await phone.definition.initialize();
    t.after(() => desktop.definition.shutdown()); t.after(() => phone.definition.shutdown());
    assert.deepEqual(await phone.read(alice), { schemaVersion: 1, revision: 0, hosts: [] });
    await Promise.all([desktop.mutate(alice, 'add', ['audio-a.example.test']), phone.mutate(alice, 'add', ['audio-b.example.test'])]);
    assert.deepEqual((await phone.read(alice)).hosts, ['audio-a.example.test', 'audio-b.example.test']);
    await Promise.all([phone.mutate(alice, 'remove', ['audio-a.example.test']), desktop.mutate(alice, 'add', ['audio-c.example.test'])]);
    assert.deepEqual((await desktop.read(alice)).hosts, ['audio-b.example.test', 'audio-c.example.test']);
    await desktop.mutate(bob, 'add', ['bob.example.test']);
    assert.deepEqual((await phone.read(bob)).hosts, ['bob.example.test']);
    assert.deepEqual((await phone.read(alice)).hosts, ['audio-b.example.test', 'audio-c.example.test']);
    await desktop.definition.shutdown();
    const restarted = createAudioRoutingPreferences(configuration); await restarted.definition.initialize();
    t.after(() => restarted.definition.shutdown());
    assert.deepEqual(await restarted.read(alice), await phone.read(alice));
    assert.equal(configuration.policy.network.enabled, false, 'preferences do not enable remote access');
});

test('only bounded canonical hostnames persist; full URLs, credentials and overflow fail atomically', async t => {
    const root = await fixture(t), context = { userRoot: root };
    const preferences = createAudioRoutingPreferences(configuration); await preferences.definition.initialize();
    t.after(() => preferences.definition.shutdown());
    for (const invalid of ['https://example.test/path?signature=secret#fragment', ['https://', 'u:p', '@example.test/x'].join(''),
        'Example.test', 'example.test.', 'example.test:443', '*.example.test', '127.0.0.1', '0x7f.0x1', 'example.123',
        'localhost', ['x', 'local'].join('.'), 'x.home.arpa', 'example.test/path'])
        await assert.rejects(preferences.mutate(context, 'add', ['valid.example.test', invalid]), { code: 'INVALID_HOST' });
    assert.deepEqual((await preferences.read(context)).hosts, []);
    const hosts = Array.from({ length: 128 }, (_, i) => `h${i}.example.test`);
    await preferences.mutate(context, 'add', hosts);
    const before = await preferences.read(context);
    await assert.rejects(preferences.mutate(context, 'add', ['extra.example.test']), { code: 'ROUTING_HOSTS_FULL' });
    assert.deepEqual(await preferences.read(context), before);
    await preferences.mutate(context, 'remove', ['h0.example.test']);
    await preferences.mutate(context, 'add', ['xn--bcher-kva.example.test']);
    assert.equal((await preferences.read(context)).hosts.length, 128);
});

test('installed-host routes sync three clients per authenticated user, require CSRF, reject arbitrary settings and expose storage failure', async t => {
    const root = await fixture(t), logs = [];
    const core = await createCore({ logger: { info: value => logs.push(value), error: value => logs.push(value) },
        policyOptions: { configPath: path.join(root, 'policy.json'), read: async () => JSON.stringify({ schemaVersion: 1,
            core: { allowedOrigins: ['https://example.test'] } }) } });
    t.after(() => core.shutdown());
    await writeFile(path.join(root, 'broken'), 'cannot be a user directory');
    const app = express(); app.use(express.json({ limit: '64kb' }));
    app.use((req, _res, next) => {
        if (req.headers['x-test-user']) req.user = { profile: { handle: req.headers['x-test-user'], enabled: true, admin: false },
            directories: { root: path.join(root, req.headers['x-test-user']) } };
        req.session = { csrfToken: 'fixture-csrf' }; next();
    });
    const router = express.Router(); core.attach(router); app.use(router);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const identities = new Map();
    for (const user of ['alice', 'bob', 'broken']) {
        const response = await fetch(base + '/v1/status', { headers: { 'X-TTB-Protocol': '1.0', 'X-Test-User': user } });
        identities.set(user, (await response.json()).data.contextId);
    }
    async function call(operation = '', hosts, user = 'alice', extra = {}) {
        const response = await fetch(base + '/v1/preferences/audio-routing' + (operation ? '/' + operation : ''), {
            method: hosts ? 'POST' : 'GET', headers: { 'X-TTB-Protocol': '1.0', 'X-Test-User': user,
                Origin: 'https://example.test', 'Content-Type': 'application/json', 'X-CSRF-Token': 'fixture-csrf',
                'X-TTB-Context': identities.get(user) || 'unknown', ...extra },
            ...(hosts ? { body: JSON.stringify({ hosts }) } : {}) });
        return { status: response.status, headers: response.headers, body: await response.json() };
    }
    const contract = JSON.parse(await readFile(new URL('../protocol/preferences.audioRouting-1.0.fixture.json', import.meta.url), 'utf8'));
    const initial = await call(); assert.equal(initial.status, 200); assert.equal(initial.headers.get('cache-control'), 'no-store');
    const added = await call('add', contract.addRequest.hosts);
    assert.equal(added.status, 200, 'ordinary ST users can edit their own routing');
    assert.deepEqual(added.body.data, contract.added);
    for (const _device of ['phone', 'tablet']) assert.deepEqual((await call()).body.data.hosts, ['audio.example.test']);
    assert.deepEqual((await call('', null, 'bob')).body.data.hosts, []);
    assert.deepEqual((await call('remove', contract.removeRequest.hosts)).body.data, contract.removed);
    assert.deepEqual((await call()).body.data.hosts, []);
    assert.equal((await call('add', ['audio.example.test'], 'alice', { 'X-CSRF-Token': 'invalid' })).status, 403);
    assert.equal((await call('add', ['audio.example.test'], 'alice', { Origin: 'https://other.example.test' })).status, 403);
    assert.equal((await call('add', ['https://example.test/private?signature=secret'])).status, 422);
    assert.equal((await call('add', ['stale.example.test'], 'bob', { 'X-TTB-Context': identities.get('alice') })).body.error.code, 'CONTEXT_CHANGED');
    assert.deepEqual((await call('', null, 'bob')).body.data.hosts, []);
    assert.equal((await call('', null, '', {})).status, 403);
    assert.equal((await call('', null, 'alice', { 'X-TTB-Protocol': '9.0' })).status, 409);
    const arbitrary = await fetch(base + '/v1/preferences/audio-routing/add', { method: 'POST', headers: {
        'X-TTB-Protocol': '1.0', 'X-Test-User': 'alice', Origin: 'https://example.test', 'Content-Type': 'application/json',
        'X-CSRF-Token': 'fixture-csrf', 'X-TTB-Context': identities.get('alice') }, body: JSON.stringify({ hosts: ['audio.example.test'], key: 'anything' }) });
    assert.equal(arbitrary.status, 400);
    assert.equal((await call('', null, 'broken')).body.error.code, 'PREFERENCE_STORE_UNAVAILABLE');
    const snapshot = await core.status({ userRoot: path.join(root, 'alice'), contextId: 'fixture' });
    assert.equal(snapshot.modules.find(item => item.id === 'core').state, 'ready');
    assert.equal(snapshot.modules.find(item => item.id === 'network').state, 'disabled');
    assert.doesNotMatch(JSON.stringify(logs), /signature|secret|audio\.example|userRoot|alice|bob/);
});
