import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, stat, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import express from 'express';
import { createCore } from '../src/core.js';
import { validatePolicy } from '../src/config.js';
import { createAudio } from '../src/network/audio.js';
import { createNetwork } from '../src/network/index.js';
import { createAudioSources, MAX_AUDIO_SOURCES } from '../src/audio-sources/store.js';

const url = 'https://audio.example.test/music.mp3?signature=private-fixture';
const origin = 'https://example.test';
const document = { schemaVersion: 1, core: { allowedOrigins: [origin] }, network: { enabled: true, transport: 'direct',
    destinationPolicy: 'allowlist-only', allowlist: ['audio.example.test'] }, audio: { perUserConcurrency: 1, globalConcurrency: 1 } };
const config = () => ({ policy: validatePolicy(document) });
const resolver = { resolve4: async () => ['8.8.8.8'], resolve6: async () => [] };
const signal = () => new AbortController().signal;
function response(status = 200, headers = {}, bytes = Buffer.from('0123456789')) {
    const stream = Readable.from([bytes]); stream.statusCode = status;
    stream.headers = { 'content-type': 'audio/mpeg', 'content-length': String(bytes.length), ...headers };
    return { response: stream, close: () => stream.destroy() };
}
function sink() {
    const chunks = [], headers = {}, stream = new Writable({ write(chunk, _, done) { chunks.push(chunk); done(); } });
    stream.setHeader = (key, value) => { headers[key] = value; };
    return Object.assign(stream, { headers, bytes: () => Buffer.concat(chunks) });
}
async function root(t) {
    const directory = await mkdtemp(path.join(tmpdir(), 'ttb-audio-sources-'));
    t.after(() => rm(directory, { recursive: true, force: true })); return directory;
}
async function sources(t, configuration = config(), options = {}) {
    const directory = await root(t), audio = createAudio(configuration, { resolver, open: async () => response(), ...options });
    const registry = createAudioSources(configuration, audio); await registry.definition.initialize();
    t.after(() => registry.definition.shutdown()); t.after(() => audio.definition.shutdown());
    return { directory, registry, audio, alice: { userRoot: path.join(directory, 'alice'), contextId: 'alice' },
        bob: { userRoot: path.join(directory, 'bob'), contextId: 'bob' } };
}

test('canonical identity and stable path survive restart, concurrent reuse and different clients; users are isolated', async t => {
    const h = await sources(t), phone = createAudioSources(config(), h.audio); await phone.definition.initialize();
    t.after(() => phone.definition.shutdown());
    const [desktop, mobile] = await Promise.all([h.registry.create(h.alice, url), phone.create(h.alice, url)]);
    assert.equal(desktop.source.sourceId, mobile.source.sourceId); assert.notEqual(desktop.reused, mobile.reused);
    const canonical = await phone.create(h.alice, url.replace('audio.example.test', 'AUDIO.EXAMPLE.TEST:443'));
    assert.equal(canonical.source.sourceId, desktop.source.sourceId);
    assert.equal((await phone.list(h.alice)).sources.length, 1);
    const changed = await phone.create(h.alice, url.replace('private-fixture', 'new-signature'));
    assert.notEqual(changed.source.sourceId, desktop.source.sourceId, 'query identity cannot be guessed equivalent');
    const otherUser = await phone.create(h.bob, url); assert.notEqual(otherUser.source.sourceId, desktop.source.sourceId);
    await assert.rejects(phone.read(h.bob, desktop.source.sourceId), { code: 'AUDIO_SOURCE_NOT_FOUND' });
    assert.match(desktop.source.playbackPath, /^\/api\/plugins\/tavern-toolbox-server\/v1\/audio\/sources\/[\w-]{32}\/stream$/);
    assert.doesNotMatch(JSON.stringify(desktop), /signature|private-fixture|music\.mp3|https:/);
    await h.registry.definition.shutdown();
    const restarted = createAudioSources(config(), h.audio); await restarted.definition.initialize(); t.after(() => restarted.definition.shutdown());
    assert.deepEqual(await restarted.read(h.alice, desktop.source.sourceId), desktop.source);
    const file = path.join(h.alice.userRoot, 'tavern-toolbox-server', 'audio-sources-v1', 'sources.sqlite');
    assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test('metadata creation grants no Network permission; each stream rechecks allowlist, DNS, redirect and finite policy', async t => {
    const cfg = { policy: validatePolicy({ ...document, network: { ...document.network, allowlist: [] } }) };
    let opens = 0, privateDns = false, redirect = null;
    const h = await sources(t, cfg, { resolver: { resolve4: async () => [privateDns ? '127.0.0.1' : '8.8.8.8'], resolve6: async () => [] },
        open: async () => { opens++; return redirect ? response(302, { location: redirect }) : response(); } });
    const { source } = await h.registry.create(h.alice, url); assert.equal(opens, 0);
    await assert.rejects(h.registry.stream(h.alice, source.sourceId, undefined, sink(), signal()), { code: 'TARGET_NOT_ALLOWED' });
    assert.equal(opens, 0); cfg.policy = validatePolicy(document);
    await h.registry.stream(h.alice, source.sourceId, undefined, sink(), signal()); assert.equal(opens, 1);
    privateDns = true; await assert.rejects(h.registry.stream(h.alice, source.sourceId, undefined, sink(), signal()), { code: 'DNS_UNSAFE' });
    assert.equal(opens, 1); privateDns = false; redirect = 'https://other.example.test/voice.mp3';
    await assert.rejects(h.registry.stream(h.alice, source.sourceId, undefined, sink(), signal()), { code: 'TARGET_NOT_ALLOWED' });
    cfg.policy = validatePolicy({ ...document, network: { ...document.network, allowlist: [] } });
    assert.equal((await h.registry.create(h.alice, url)).source.playbackPath, source.playbackPath, 'reuse is independent of access permission');
});

test('stable playback uses exactly the existing Range validator without a temporary ticket or lifetime', async t => {
    const seen = [], h = await sources(t, config(), { open: async (target, _, _signal, _tls, profile) => {
        seen.push({ target: target.url.href, profile });
        if (profile.range === 'bytes=2-5') return response(206, { 'content-range': 'bytes 2-5/10', 'content-length': '4' }, Buffer.from('2345'));
        if (profile.range === 'bytes=99-') return response(416, { 'content-range': 'bytes */10' });
        return response();
    } });
    const { source } = await h.registry.create(h.alice, url);
    for (const [range, status, bytes] of [['bytes=2-5', 206, '2345'], ['bytes=99-', 416, ''], ['bytes=0-', 200, '0123456789']]) {
        const output = sink(); await h.registry.stream(h.alice, source.sourceId, range, output, signal());
        assert.equal(output.statusCode, status); assert.equal(output.bytes().toString(), bytes);
    }
    await assert.rejects(h.registry.stream(h.alice, source.sourceId, 'bytes=0-1,4-5', sink(), signal()), { code: 'UNSUPPORTED_RANGE' });
    assert.ok(seen.every(item => item.target === url && item.profile.accept.includes('audio/mpeg')));
    assert.ok(seen.every(item => Object.keys(item.profile).sort().join(',') === 'accept,range'));
});

test('stable and standard Audio share resource limits; abort frees the same slot and leaves Image independent', async t => {
    let opened, stalled = true, closes = 0;
    const began = new Promise(resolve => { opened = resolve; });
    const h = await sources(t, config(), { open: async () => {
        if (!stalled) return response();
        const stream = new Readable({ read() {} }); stream.statusCode = 200;
        stream.headers = { 'content-type': 'audio/mpeg', 'content-length': '10' }; opened();
        return { response: stream, close() { closes++; stream.destroy(); } };
    } });
    const { source } = await h.registry.create(h.alice, url), ticket = await h.audio.create(url, 'alice', signal());
    const controller = new AbortController(), first = h.registry.stream(h.alice, source.sourceId, undefined, sink(), controller.signal);
    await began;
    await assert.rejects(h.audio.stream(ticket.accessId, 'alice', undefined, sink(), signal()), { code: 'RESOURCE_BUSY' });
    const image = createNetwork(config(), { resolver, open: async () => response(200, { 'content-type': 'image/gif' },
        Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64')) });
    assert.equal((await image.fetchImage('https://audio.example.test/image.gif', 'alice')).mime, 'image/gif'); image.shutdown();
    controller.abort(); await assert.rejects(first, { code: 'CLIENT_ABORTED' }); assert.equal(closes, 1);
    stalled = false; await h.audio.stream(ticket.accessId, 'alice', undefined, sink(), signal());
    await h.registry.stream(h.alice, source.sourceId, undefined, sink(), signal());
});

test('invalid sources cannot enter storage, deletion retires old paths and unavailable local binding never calls Remote', async t => {
    let opens = 0;
    const h = await sources(t, config(), { open: async () => { opens++; return response(); } });
    const credentialed = new URL(url); credentialed.username = 'fixture-user'; credentialed.password = 'fixture';
    for (const invalid of ['file:///private.mp3', 'blob:abc', 'data:audio/mpeg;base64,AA', credentialed.href,
        'https://audio.example.test/a.mp3#token', 'https://audio.example.test/a.m3u8'])
        await assert.rejects(h.registry.create(h.alice, invalid));
    assert.equal((await h.registry.list(h.alice)).sources.length, 0);
    const { source } = await h.registry.create(h.alice, url);
    const db = new DatabaseSync(path.join(h.alice.userRoot, 'tavern-toolbox-server', 'audio-sources-v1', 'sources.sqlite'));
    db.prepare("UPDATE sources SET backend = 'local', local_asset_id = ? WHERE source_id = ?").run('a'.repeat(32), source.sourceId); db.close();
    assert.equal((await h.registry.read(h.alice, source.sourceId)).backend, 'local');
    await assert.rejects(h.registry.stream(h.alice, source.sourceId, undefined, sink(), signal()), { code: 'AUDIO_ASSET_NOT_FOUND' });
    assert.equal(opens, 0); await h.registry.remove(h.alice, source.sourceId);
    await assert.rejects(h.registry.stream(h.alice, source.sourceId, undefined, sink(), signal()), { code: 'AUDIO_SOURCE_NOT_FOUND' });
    const recreated = await h.registry.create(h.alice, url); assert.notEqual(recreated.source.sourceId, source.sourceId);
});

test('bounded registry pages are complete and limit failure preserves all committed sources', async t => {
    const h = await sources(t);
    for (let index = 0; index < MAX_AUDIO_SOURCES; index++) await h.registry.create(h.alice, url + '&track=' + index);
    await assert.rejects(h.registry.create(h.alice, url), { code: 'AUDIO_SOURCES_FULL' });
    const ids = []; let cursor = null;
    do { const page = await h.registry.list(h.alice, cursor); assert(page.sources.length <= 50);
        ids.push(...page.sources.map(source => source.sourceId)); cursor = page.nextCursor; } while (cursor);
    assert.equal(new Set(ids).size, MAX_AUDIO_SOURCES);
    await h.registry.remove(h.alice, ids[0]); await h.registry.create(h.alice, url);
});

test('installed-host routes enforce user/session/CSRF/context, keep stream root-relative, and never log sensitive metadata', async t => {
    const directory = await root(t), logs = [];
    const core = await createCore({ logger: { info: value => logs.push(value), error: value => logs.push(value) },
        policyOptions: { configPath: path.join(directory, 'policy.json'), read: async () => JSON.stringify(document) },
        audioOptions: { resolver, open: async () => response() } });
    t.after(() => core.shutdown());
    await writeFile(path.join(directory, 'broken'), 'not a user root');
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { const user = req.headers['x-test-user'];
        if (user) req.user = { profile: { handle: user, enabled: true }, directories: { root: path.join(directory, user) } };
        req.session = { csrfToken: 'fixture-csrf' }; next(); });
    const router = express.Router(); core.attach(router); app.use('/api/plugins/tavern-toolbox-server', router);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => new Promise(resolve => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`, prefix = '/api/plugins/tavern-toolbox-server';
    const identities = new Map();
    for (const user of ['alice', 'bob', 'broken']) {
        const response = await fetch(base + prefix + '/v1/status', { headers: { 'X-TTB-Protocol': '1.0', 'X-Test-User': user } });
        identities.set(user, (await response.json()).data.contextId);
    }
    async function call(route, data = null, user = 'alice', extra = {}) {
        return fetch(base + prefix + route, { method: data ? 'POST' : 'GET', headers: { 'X-TTB-Protocol': '1.0',
            'X-TTB-Context': identities.get(user), Origin: origin, 'X-CSRF-Token': 'fixture-csrf', 'X-Test-User': user,
            'Content-Type': 'application/json', ...extra }, ...(data ? { body: JSON.stringify(data) } : {}) });
    }
    const contract = JSON.parse(await readFile(new URL('../protocol/audio.sources-1.0.fixture.json', import.meta.url), 'utf8'));
    const created = await call('/v1/audio/sources', contract.createRequest); assert.equal(created.status, 200);
    const { source } = (await created.json()).data;
    assert.deepEqual(Object.keys(source).sort(), Object.keys(contract.read).sort());
    const reused = (await (await call('/v1/audio/sources', contract.createRequest)).json()).data;
    assert.equal(reused.reused, contract.reused.reused); assert.deepEqual(reused.source, source);
    assert.equal(created.headers.get('cache-control'), 'no-store');
    assert.equal((await call('/v1/audio/sources/' + source.sourceId, null, 'bob')).status, 404);
    assert.equal((await call('/v1/audio/sources', { url }, 'alice', { 'X-CSRF-Token': 'invalid' })).status, 403);
    assert.equal((await call('/v1/audio/sources', { url, path: '/private' })).status, 400);
    assert.equal((await call('/v1/audio/sources', { url }, 'bob', { 'X-TTB-Context': identities.get('alice') })).status, 409);
    assert.equal((await call('/v1/audio/sources', null, 'broken')).status, 503);
    const native = await fetch(base + source.playbackPath, { headers: { 'X-Test-User': 'alice', 'Sec-Fetch-Site': 'same-origin',
        Cookie: 'private=secret', Authorization: 'private-fixture', Referer: 'https://example.test/chat/private' } });
    assert.equal(native.status, 200); assert.equal(await native.text(), '0123456789');
    assert.equal(native.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal((await fetch(base + source.playbackPath, { headers: { 'X-Test-User': 'bob' } })).status, 404);
    assert.equal((await fetch(base + source.playbackPath)).status, 403);
    assert.equal((await fetch(base + source.playbackPath, { headers: { 'X-Test-User': 'alice', 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    assert.equal((await call('/v1/audio/sources/' + source.sourceId + '/delete', {})).status, 200);
    assert.equal((await fetch(base + source.playbackPath, { headers: { 'X-Test-User': 'alice' } })).status, 404);
    assert.doesNotMatch(JSON.stringify(logs), /signature|private-fixture|music\.mp3|audio\.example|alice|bob|userRoot|sources.sqlite/);
    assert(!JSON.stringify(logs).includes(source.sourceId));
});
