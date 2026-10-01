import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import path from 'node:path';
import { createCore, SERVER_VERSION } from '../src/core.js';
import { CapabilityRegistry } from '../src/registry.js';
import { loadPolicy, validatePolicy } from '../src/config.js';
import { info } from '../index.js';
import { userContext } from '../src/security.js';
import { Readable } from 'node:stream';
import sharp from 'sharp';
import express from 'express';
import bodyParser from 'body-parser';
import multer from 'multer';
import { card } from './localization-fixture.js';

function hostRouter() {
    const stack = [];
    return {
        stack,
        use(fn) { stack.push({ fn }); },
        get(path, fn) { stack.push({ method: 'GET', path, fn }); },
        post(path, fn) { stack.push({ method: 'POST', path, fn }); },
        put(path, fn) { stack.push({ method: 'PUT', path, fn }); },
        delete(path, fn) { stack.push({ method: 'DELETE', path, fn }); },
    };
}

async function host(core) {
    const router = hostRouter();
    core.attach(router);
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'ttb-media-test-'));
    const server = http.createServer((req, res) => {
        req.path = new URL(req.url, 'http://localhost').pathname;
        req.get = name => req.headers[name.toLowerCase()];
        req.session = { csrfToken: 'fixture-csrf-token' };
        req.user = req.headers['x-test-user'] ? {
            profile: { handle: req.headers['x-test-user'], enabled: true, admin: req.headers['x-test-admin'] === 'yes' },
            directories: { root: path.join(dataRoot, req.headers['x-test-user']) },
        } : undefined;
        res.locals = {};
        res.status = n => { res.statusCode = n; return res; };
        res.type = () => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); return res; };
        res.send = payload => res.end(payload);
        let index = 0;
        const next = () => {
            const layer = router.stack[index++];
            if (!layer) return res.end();
            if (layer.method && layer.method !== req.method) return next();
            if (layer.path) {
                const parts = layer.path.split('/'), actual = req.path.split('/');
                if (parts.length !== actual.length || parts.some((part, n) => !part.startsWith(':') && part !== actual[n])) return next();
                req.params = Object.fromEntries(parts.flatMap((part, n) => part.startsWith(':') ? [[part.slice(1), actual[n]]] : []));
            }
            Promise.resolve(layer.fn(req, res, next)).catch(() => { res.statusCode = 500; res.end(); });
        };
        next();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { server, dataRoot, url: `http://127.0.0.1:${server.address().port}`,
        close: async () => { await new Promise(resolve => server.close(resolve)); await rm(dataRoot, { recursive: true, force: true }); } };
}

async function sillyTavernHost(core) {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'ttb-st-upload-test-'));
    const app = express(), observed = [];
    // SillyTavern 1.19.0 server-main.js installs these before the native plugin router.
    app.use(bodyParser.json({ limit: '500mb' }));
    app.use(bodyParser.urlencoded({ extended: true, limit: '500mb' }));
    app.use((req, _res, next) => {
        req.session = { csrfToken: 'fixture-csrf-token' };
        req.user = req.headers['x-test-user'] ? {
            profile: { handle: req.headers['x-test-user'], enabled: true },
            directories: { root: path.join(dataRoot, req.headers['x-test-user']) },
        } : undefined;
        next();
    });
    app.use(multer({ dest: dataRoot, limits: { fieldSize: 500 * 1024 * 1024 } }).single('avatar'));
    app.use(async (req, _res, next) => {
        if (req.path.endsWith('/v1/media/import/local')) {
            observed.push({ body: req.body, readableEnded: req.readableEnded });
            if (req.headers['x-test-consume'] === 'yes') for await (const _ of req) { /* simulate a consuming host */ }
            if (req.headers['x-test-object'] === 'yes') req.body = { unexpected: true };
        }
        next();
    });
    const router = express.Router();
    core.attach(router);
    app.use('/api/plugins/tavern-toolbox-server', router);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { observed, dataRoot, url: `http://127.0.0.1:${server.address().port}/api/plugins/tavern-toolbox-server`,
        close: async () => { await new Promise(resolve => server.close(resolve)); await rm(dataRoot, { recursive: true, force: true }); } };
}

async function request(url, route = '/status', { user = 'alice', method = 'GET', protocol, headers = {}, body } = {}) {
    const result = await fetch(`${url}${route}`, { method, headers: {
        ...(user ? { 'x-test-user': user } : {}), ...(protocol ? { 'X-TTB-Protocol': protocol } : {}), ...headers,
    }, body });
    return { code: result.status, headers: result.headers, body: await result.json() };
}

const quiet = { info() {}, error() {} };

test('bindExisting HTTP reports missing media as 404 and corrupt Original as 422', async t => {
    const core = await createCore({ logger: quiet, policyOptions: { configPath: '/fixture/config',
        read: async () => JSON.stringify({ schemaVersion: 1, core: { allowedOrigins: ['https://example.invalid'] } }) } });
    const app = await sillyTavernHost(core);
    t.after(async () => { await app.close(); await core.shutdown(); });
    await mkdir(path.join(app.dataRoot, 'alice', 'characters'), { recursive: true });
    await card(path.join(app.dataRoot, 'alice', 'characters', 'A.png'), '2026-01-01');
    const headers = { 'x-test-user': 'alice', 'X-TTB-Protocol': '1.0', Origin: 'https://example.invalid',
        'X-CSRF-Token': 'fixture-csrf-token', 'Sec-Fetch-Site': 'same-origin' };
    const bind = mediaRef => request(app.url, '/v1/localization/bindExisting', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostId: 'A.png', displayName: 'A', url: 'https://blocked.example/image.png', revision: 0, mediaRef }) });
    const missing = await bind({ provider: 'server', assetId: '12345678-1234-4123-8123-123456789abc' });
    assert.equal(missing.code, 404); assert.equal(missing.body.error.code, 'MEDIA_NOT_FOUND');
    const bytes = await sharp({ create: { width: 3, height: 3, channels: 3, background: 'blue' } }).png().toBuffer();
    const uploaded = await request(app.url, '/v1/media/import/local', { method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: bytes });
    assert.equal(uploaded.code, 200);
    const ref = uploaded.body.data.mediaRef;
    await writeFile(path.join(app.dataRoot, 'alice', 'tavern-toolbox-server', 'media-v1', 'originals', ref.assetId + '.png'), 'corrupt');
    const corrupt = await bind(ref);
    assert.equal(corrupt.code, 422); assert.equal(corrupt.body.error.code, 'MEDIA_CORRUPT');
    const catalog = await request(app.url, '/v1/localization/catalog?hostId=A.png', { headers });
    assert.equal(catalog.body.data.revision, 0);
});

test('Network policy HTTP operations recheck admin, Origin and CSRF and never return secrets', async t => {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'ttb-policy-http-'));
    await writeFile(path.join(dataRoot, 'tavern-toolbox-server.config.json'), JSON.stringify({ schemaVersion: 1,
        core: { allowedOrigins: ['https://example.invalid'] }, network: { enabled: true, transport: 'direct',
            destinationPolicy: 'allowlist-only', allowlist: ['img.example.com'] } }));
    const core = await createCore({ logger: quiet, policyOptions: { dataRoot } }), app = await host(core);
    t.after(async () => { await app.close(); await core.shutdown(); await rm(dataRoot, { recursive: true, force: true }); });
    const read = await request(app.url, '/v1/network/policy', { protocol: '1.0', headers: { 'x-test-admin': 'yes' } });
    assert.equal(read.body.data.canManage, true);
    const body = JSON.stringify({ host: 'new.example.com', includeSubdomains: false, revision: read.body.data.revision });
    const headers = { Origin: 'https://example.invalid', 'Content-Type': 'application/json', 'X-CSRF-Token': 'fixture-csrf-token' };
    const add = more => request(app.url, '/v1/network/policy/add', { protocol: '1.0', method: 'POST', headers: { ...headers, ...more }, body });
    assert.equal((await add({})).body.error.code, 'ADMIN_REQUIRED');
    assert.equal((await add({ 'x-test-admin': 'yes', 'X-CSRF-Token': 'bad' })).body.error.code, 'CSRF_REJECTED');
    assert.equal((await add({ 'x-test-admin': 'yes', Origin: 'https://other.invalid' })).body.error.code, 'CSRF_REJECTED');
    const added = await add({ 'x-test-admin': 'yes' });
    assert.equal(added.code, 200);
    assert.equal((await add({ 'x-test-admin': 'yes' })).body.error.code, 'POLICY_CONFLICT');
    const ordinary = await request(app.url, '/v1/network/policy', { protocol: '1.0' });
    assert.equal(ordinary.body.data.hosts, undefined);
    assert.equal(ordinary.body.data.canManage, false);
    const snapshot = await request(app.url, '/v1/status', { protocol: '1.0' });
    assert.doesNotMatch(JSON.stringify(snapshot.body), /img\.example|new\.example/);
    assert.equal(snapshot.body.data.capabilities.find(x => x.id === 'network.remoteFetch').constraints.allowlistEntryCount, 2);
});

test('real HTTP discovery: exact product, read-only routes, version contract and no-store', async t => {
    const fixture = JSON.parse(await readFile(new URL('../protocol/v1.0.fixture.json', import.meta.url), 'utf8'));
    const releaseVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url))).version;
    const core = await createCore({ logger: quiet });
    const app = await host(core);
    t.after(async () => { await app.close(); await core.shutdown(); });
    const boot = await request(app.url);
    assert.equal(boot.code, 200);
    assert.equal(boot.body.data.product, info.id);
    // The fixed Protocol 1.0 example is independent of the package release version.
    assert.deepEqual(boot.body.data, { ...fixture.bootstrap.data, serverVersion: releaseVersion });
    assert.equal(boot.body.data.serverVersion, SERVER_VERSION);
    assert.equal(SERVER_VERSION, releaseVersion);
    assert.deepEqual(boot.body.data.protocols, [{ major: 1, minMinor: 0, maxMinor: 0 }]);
    assert.equal(boot.headers.get('cache-control'), 'no-store');
    assert.ok(boot.body.meta.requestId);
    const status = await request(app.url, '/v1/status', { protocol: '1.0' });
    assert.equal(status.code, 200);
    assert.equal(status.body.data.serverVersion, releaseVersion);
    assert.equal(status.body.data.core.version, releaseVersion);
    assert.deepEqual(status.body.meta.protocol, { major: 1, minor: 0 });
    assert.deepEqual(status.body.data.capabilities.map(item => item.id), ['core.status', 'network.remoteFetch', 'network.policy', 'media.assets', 'business.collections', 'localization.characters', 'media.governance']);
    assert.deepEqual(status.body.data.capabilities[0], fixture.status.data.capabilities[0]);
    assert.deepEqual(status.body.data.effectivePolicy, fixture.status.data.effectivePolicy);
    assert.deepEqual(status.body.data.modules.map(item => item.id), ['core', 'network', 'media', 'business', 'localization', 'governance']);
    assert.equal(status.body.data.modules[1].state, 'disabled');
    assert.equal(status.body.data.core.state, 'ready');
    assert.equal(status.body.data.effectivePolicy.unsafeRequestsEnabled, false);
    assert.equal((await request(app.url, '/status', { method: 'POST' })).code, 405);
    assert.equal((await request(app.url, '/proxy?url=http://127.0.0.1')).code, 404);
});

test('installed-host localization routes require trusted user, host avatar and CSRF', async t => {
    const core = await createCore({ logger: quiet, policyOptions: { configPath: '/fixture/config',
        read: async () => JSON.stringify({ schemaVersion: 1,
            core: { allowedOrigins: ['https://example.invalid'] }, network: { enabled: false } }) } });
    const app = await sillyTavernHost(core);
    t.after(async () => { await app.close(); await core.shutdown(); });
    await mkdir(path.join(app.dataRoot, 'alice', 'characters'), { recursive: true });
    await mkdir(path.join(app.dataRoot, 'bob', 'characters'), { recursive: true });
    await card(path.join(app.dataRoot, 'alice', 'characters', 'A.png'), '2025-01-01');
    const headers = { 'X-TTB-Protocol': '1.0', 'x-test-user': 'alice',
        Origin: 'https://example.invalid', 'Sec-Fetch-Site': 'same-origin',
        'X-CSRF-Token': 'fixture-csrf-token', 'Content-Type': 'application/json' };
    const read = async (user, hostId) => fetch(app.url + '/v1/localization/catalog?hostId=' + hostId,
        { headers: { ...headers, 'x-test-user': user } });
    assert.equal((await (await read('alice', 'A.png')).json()).data.revision, 0);
    assert.equal((await (await read('bob', 'A.png')).json()).error.code, 'HOST_IDENTITY_UNAVAILABLE');
    const url = 'https://img.example/private.png?token=secret';
    const resolve = csrf => fetch(app.url + '/v1/localization/resolve', { method: 'POST',
        headers: { ...headers, 'X-CSRF-Token': csrf }, body: JSON.stringify({ hostId: 'A.png', url }) });
    assert.equal((await (await resolve('invalid')).json()).error.code, 'CSRF_REJECTED');
    const response = await resolve('fixture-csrf-token');
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.mediaRef, null);
});

test('protocol negotiation rejects absent and incompatible versions without business routing', async t => {
    const core = await createCore({ logger: quiet }), app = await host(core);
    t.after(async () => { await app.close(); await core.shutdown(); });
    const missing = await request(app.url, '/v1/status');
    const old = await request(app.url, '/v1/status', { protocol: '2.0' });
    assert.equal(missing.code, 400); assert.equal(missing.body.error.code, 'INVALID_REQUEST');
    assert.equal(old.code, 409); assert.equal(old.body.error.code, 'PROTOCOL_INCOMPATIBLE');
    assert.equal(old.body.error.outcome, 'notApplicable');
});

test('SillyTavern relative user roots normalize to the same authenticated context identity', () => {
    const user = root => ({ user: { profile: { handle: 'default-user', enabled: true }, directories: { root } } });
    const relative = userContext(user('./data/default-user'), 'test-secret');
    const absolute = userContext(user(path.resolve('./data/default-user')), 'test-secret');
    assert.ok(relative?.contextId);
    assert.equal(relative.contextId, absolute.contextId);
    assert.equal(userContext(user('   '), 'test-secret'), null);
});

test('host user isolation is determined on every request; missing identity fails closed', async t => {
    const core = await createCore({ logger: quiet }), app = await host(core);
    t.after(async () => { await app.close(); await core.shutdown(); });
    const a = await request(app.url, '/v1/status?user=bob', { user: 'alice', protocol: '1.0' });
    const b = await request(app.url, '/v1/status', { user: 'bob', protocol: '1.0' });
    assert.notEqual(a.body.data.contextId, b.body.data.contextId);
    assert.equal(a.body.data.bootId, b.body.data.bootId);
    assert.ok(!JSON.stringify(a.body).includes('/srv/st/data/'));
    const anonymous = await request(app.url, '/status', { user: null });
    assert.equal(anonymous.code, 403);
    assert.equal(anonymous.body.error.code, 'AUTH_REQUIRED');
});

test('module failure isolates independent module and its dependent while Core remains readable', async t => {
    const core = await createCore({ logger: quiet, registerModules(registry) {
        registry.register({ id: 'broken', version: '1', capabilities: [], initialize: () => { throw new Error('private detail'); } });
        registry.register({ id: 'dependent', version: '1', dependsOn: ['broken'], capabilities: [] });
        registry.register({ id: 'independent', version: '1', capabilities: [{ id: 'test.read', contract: { major: 1, minMinor: 0, maxMinor: 0 }, operations: [{ id: 'read' }] }] });
    } });
    const app = await host(core);
    t.after(async () => { await app.close(); await core.shutdown(); });
    const response = await request(app.url, '/v1/status', { protocol: '1.0' });
    assert.equal(response.code, 200);
    assert.equal(response.body.data.modules.find(m => m.id === 'core').state, 'ready');
    assert.deepEqual(response.body.data.modules.filter(m => m.state === 'unavailable').map(m => m.id), ['broken', 'dependent']);
    assert.equal(response.body.data.capabilities.find(c => c.id === 'test.read').operations[0].available, true);
    assert.ok(!JSON.stringify(response.body).includes('private detail'));
});

test('duplicate ID and cycles are unavailable without replacing existing registrations', async () => {
    const registry = new CapabilityRegistry();
    registry.register({ id: 'one', version: '1', capabilities: [] });
    registry.register({ id: 'one', version: '2', capabilities: [] });
    registry.register({ id: 'two', version: '1', dependsOn: ['three'], capabilities: [] });
    registry.register({ id: 'three', version: '1', dependsOn: ['two'], capabilities: [] });
    await registry.initialize();
    const snapshot = await registry.snapshot({});
    assert.equal(snapshot.modules.find(m => m.id === 'one').version, '1');
    assert.equal(snapshot.modules.find(m => m.id === 'one').reasonCode, 'DUPLICATE_MODULE_ID');
    assert.equal(snapshot.modules.find(m => m.id === 'two').reasonCode, 'DEPENDENCY_CYCLE');
});

test('per-user health failure does not poison other user health', async t => {
    let firstUser;
    const core = await createCore({ logger: quiet, registerModules(registry) {
        registry.register({ id: 'user-test', version: '1', capabilities: [], health(context) {
            firstUser ||= context.contextId;
            if (context.contextId === firstUser) throw new Error('private storage failed');
            return { state: 'ready' };
        } });
    } });
    const app = await host(core);
    t.after(async () => { await app.close(); await core.shutdown(); });
    const a = await request(app.url, '/v1/status', { user: 'alice', protocol: '1.0' });
    const b = await request(app.url, '/v1/status', { user: 'bob', protocol: '1.0' });
    assert.notEqual(a.body.data.contextId, b.body.data.contextId);
    assert.equal(a.body.data.modules.find(m => m.id === 'user-test').state, 'unavailable');
    assert.equal(b.body.data.modules.find(m => m.id === 'user-test').state, 'ready');
    assert.ok(!JSON.stringify(a.body).includes('private storage failed'));
});

test('relative SillyTavern dataRoot resolves the default administrator config path', async () => {
    let observedPath;
    const missing = new Error('missing');
    missing.code = 'ENOENT';
    const config = await loadPolicy({ dataRoot: './data', read: async target => {
        observedPath = target;
        throw missing;
    } });
    assert.equal(observedPath, path.resolve('./data/tavern-toolbox-server.config.json'));
    assert.equal(config.source, 'defaults');
    assert.equal(config.error, null);
    const explicitRelative = await loadPolicy({ dataRoot: './data', configPath: './private.json',
        read: async () => { throw new Error('must not read relative explicit config'); } });
    assert.equal(explicitRelative.source, 'invalid');
    assert.equal(explicitRelative.error, 'INVALID_CORE_CONFIG');
});

test('administrator policy validation and unsafe-operation gate fail closed', async () => {
    assert.throws(() => validatePolicy({ schemaVersion: 1, core: { allowedOrigins: ['null'] } }), /INVALID_CORE_CONFIG/);
    assert.throws(() => validatePolicy({ schemaVersion: 1, core: { arbitraryAllowAll: true } }), /INVALID_CORE_CONFIG/);
    const core = await createCore({ logger: quiet, policyOptions: { configPath: '/tmp/ttb-admin-config', read: async () => JSON.stringify({
        schemaVersion: 1, core: { allowedOrigins: ['https://example.invalid'] },
    }) } });
    const user = { profile: { handle: 'alice' }, directories: { root: '/srv/st/data/alice' } };
    assert.equal(core.allowMutation({ user, session: { csrfToken: 'token' }, headers: { origin: 'https://example.invalid', 'sec-fetch-site': 'same-origin', 'x-csrf-token': 'token' } }), true);
    assert.equal(core.allowMutation({ user, headers: { origin: 'null' } }), false);
    assert.equal(core.allowMutation({ user, headers: { origin: 'https://example.invalid', 'sec-fetch-site': 'cross-site' } }), false);
    assert.equal(core.allowMutation({ user: null, headers: { origin: 'https://example.invalid' } }), false);
    await core.shutdown();
});

test('real HTTP POST enforces host user, session CSRF, trusted Origin, protocol and disabled module', async t => {
    const core = await createCore({ logger: quiet, policyOptions: { configPath: '/fixture/config', read: async () => JSON.stringify({
        schemaVersion: 1, core: { allowedOrigins: ['https://example.invalid'] },
        network: { enabled: false },
    }) } });
    const app = await host(core);
    t.after(async () => { await app.close(); await core.shutdown(); });
    const fetchOperation = (headers = {}, user = 'alice') => request(app.url, '/v1/network/fetch', {
        method: 'POST', user, protocol: '1.0', body: JSON.stringify({ url: 'https://example.invalid/p.png', profile: 'image' }), headers: { 'content-type': 'application/json',
            origin: 'https://example.invalid', 'sec-fetch-site': 'same-origin', 'x-csrf-token': 'fixture-csrf-token', ...headers },
    });
    assert.equal((await fetchOperation({}, null)).body.error.code, 'AUTH_REQUIRED');
    assert.equal((await fetchOperation({ 'x-csrf-token': 'invalid' })).body.error.code, 'CSRF_REJECTED');
    assert.equal((await fetchOperation({ origin: 'null' })).body.error.code, 'FORBIDDEN');
    assert.equal((await fetchOperation({ origin: 'https://untrusted.invalid' })).body.error.code, 'FORBIDDEN');
    assert.equal((await fetchOperation()).body.error.code, 'CAPABILITY_UNAVAILABLE');
    assert.equal((await request(app.url, '/v1/status', { protocol: '1.0' })).body.data.core.state, 'ready');
});

test('real HTTP POST returns verified binary and structured policy failures without leaking URL', async t => {
    const gif = Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64');
    const logger = { info() {}, error() {} };
    const core = await createCore({ logger, policyOptions: { configPath: '/fixture/config', read: async () => JSON.stringify({
        schemaVersion: 1, core: { allowedOrigins: ['https://example.invalid'] },
        network: { enabled: true, transport: 'direct', destinationPolicy: 'allowlist-only', allowlist: ['example.invalid'] },
    }) }, networkOptions: {
        resolver: { resolve4: async () => ['93.184.216.34'], resolve6: async () => [] },
        open: async () => { const response = Readable.from([gif]); response.statusCode = 200;
            response.headers = { 'content-type': 'image/gif' }; return { response, close() { response.destroy(); } }; },
    } });
    const app = await host(core);
    t.after(async () => { await app.close(); await core.shutdown(); });
    const post = url => fetch(`${app.url}/v1/network/fetch`, { method: 'POST', headers: {
        'x-test-user': 'alice', 'X-TTB-Protocol': '1.0', 'Content-Type': 'application/json',
        Origin: 'https://example.invalid', 'X-CSRF-Token': 'fixture-csrf-token', 'Sec-Fetch-Site': 'same-origin',
    }, body: JSON.stringify({ url, profile: 'image' }) });
    const valid = await post('https://example.invalid/one.gif');
    assert.equal(valid.status, 200);
    assert.equal(valid.headers.get('content-type'), 'image/gif');
    assert.equal(valid.headers.get('cache-control'), 'no-store');
    assert.equal(valid.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await valid.arrayBuffer()), gif);
    const blocked = await post('https://other.invalid/private?token=fixture-secret');
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).error.code, 'TARGET_NOT_ALLOWED');
});

test('authenticated Media serving is scoped to the current ST user with no browser cache reuse', async t => {
    const core = await createCore({ logger: quiet, policyOptions: { configPath: '/fixture/config', read: async () => JSON.stringify({
        schemaVersion: 1, core: { allowedOrigins: ['https://example.invalid'] }, network: { enabled: false },
    }) } });
    const app = await host(core);
    t.after(async () => { await core.shutdown(); await app.close(); });
    const status = await request(app.url, '/v1/status', { protocol: '1.0' });
    const mediaCapability = status.body.data.capabilities.find(item => item.id === 'media.assets');
    assert.equal(mediaCapability.state, 'ready');
    assert.equal(mediaCapability.operations.find(op => op.id === 'localImport').available, true);
    assert.equal(mediaCapability.operations.find(op => op.id === 'read').available, true);
    assert.equal(mediaCapability.operations.find(op => op.id === 'remoteImport').available, false);
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#00ff00' } }).png().toBuffer();
    const headers = { 'X-TTB-Protocol': '1.0', Origin: 'https://example.invalid',
        'Sec-Fetch-Site': 'same-origin', 'X-CSRF-Token': 'fixture-csrf-token', 'Content-Type': 'image/png' };
    const denied = await fetch(`${app.url}/v1/media/import/local`, { method: 'POST',
        headers: { ...headers, 'x-test-user': 'alice', 'X-CSRF-Token': 'wrong' }, body: bytes });
    assert.equal((await denied.json()).error.code, 'CSRF_REJECTED');
    const upload = await fetch(`${app.url}/v1/media/import/local`, { method: 'POST',
        headers: { ...headers, 'x-test-user': 'alice' }, body: bytes });
    assert.equal(upload.status, 200);
    const id = (await upload.json()).data.mediaRef.assetId;
    const original = `/v1/media/assets/${id}/original`;
    const own = await fetch(`${app.url}${original}`, { headers: { 'x-test-user': 'alice' } });
    assert.equal(own.status, 200);
    assert.equal(own.headers.get('cache-control'), 'no-store');
    assert.equal(own.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(own.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await own.arrayBuffer()), bytes);
    const other = await fetch(`${app.url}${original}`, { headers: { 'x-test-user': 'bob' } });
    assert.equal(other.status, 404);
    const absent = await fetch(`${app.url}/v1/media/assets/00000000-0000-4000-8000-000000000000/original`,
        { headers: { 'x-test-user': 'bob' } });
    assert.equal(absent.status, other.status);
    const anonymous = await fetch(`${app.url}${original}`);
    assert.equal(anonymous.status, 403);
    await mkdir(path.join(app.dataRoot, 'alice', 'characters'), { recursive: true });
    const destroy = await fetch(`${app.url}/v1/media/assets/${id}`, { method: 'DELETE',
        headers: { ...headers, 'x-test-user': 'alice' } });
    assert.equal(destroy.status, 200);
    assert.equal((await fetch(`${app.url}${original}`, { headers: { 'x-test-user': 'alice' } })).status, 404);
});

test('installed-host Business collection uses trusted user, explicit schema, CSRF and stale revision conflict', async t => {
    const core = await createCore({ logger: quiet, policyOptions: { configPath: '/fixture/config', read: async () => JSON.stringify({
        schemaVersion: 1, core: { allowedOrigins: ['https://example.invalid'] },
    }) } });
    const app = await sillyTavernHost(core);
    t.after(async () => { await app.close(); await core.shutdown(); });
    const route = '/v1/business/collections/outfit';
    const read = user => request(app.url, `${route}?schemaVersion=1`, { user, protocol: '1.0' });
    const initial = await read('alice');
    assert.equal(initial.code, 200);
    assert.equal(initial.body.data.revision, 0);
    assert.deepEqual(initial.body.data.document, { assets: [], persons: [], wearStates: [] });
    const headers = { Origin: 'https://example.invalid', 'X-CSRF-Token': 'fixture-csrf-token',
        'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json' };
    const commit = (user, revision, options = {}) => request(app.url, route, { user, protocol: '1.0',
        method: 'PUT', headers: { ...headers, ...options.headers }, body: JSON.stringify({
            schemaVersion: 1, revision, document: { assets: [], persons: [], wearStates: [] },
        }) });
    assert.equal((await commit('alice', 0, { headers: { 'X-CSRF-Token': 'wrong' } })).body.error.code, 'CSRF_REJECTED');
    assert.equal((await commit('alice', 0)).body.data.revision, 1);
    const stale = await commit('alice', 0);
    assert.equal(stale.code, 409);
    assert.equal(stale.body.error.code, 'BUSINESS_CONFLICT');
    assert.equal((await read('alice')).body.data.revision, 1);
    assert.equal((await read('bob')).body.data.revision, 0);
    assert.equal((await request(app.url, `${route}?schemaVersion=2`, { protocol: '1.0' })).body.error.code,
        'BUSINESS_SCHEMA_INCOMPATIBLE');
    assert.equal((await request(app.url, `${route}?schemaVersion=1`, { user: '', protocol: '1.0' })).code, 403);
});

test('installed-host Outfit record resolves Server MediaRef; business removal retains Media asset', async t => {
    const core = await createCore({ logger: quiet, policyOptions: { configPath: '/fixture/config', read: async () => JSON.stringify({
        schemaVersion: 1, core: { allowedOrigins: ['https://example.invalid'] },
    }) } });
    const app = await sillyTavernHost(core);
    t.after(async () => { await app.close(); await core.shutdown(); });
    const headers = { 'x-test-user': 'alice', 'X-TTB-Protocol': '1.0', Origin: 'https://example.invalid',
        'X-CSRF-Token': 'fixture-csrf-token', 'Sec-Fetch-Site': 'same-origin' };
    const bytes = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#0088ff' } }).png().toBuffer();
    const upload = await fetch(`${app.url}/v1/media/import/local`, { method: 'POST',
        headers: { ...headers, 'Content-Type': 'image/png' }, body: bytes });
    assert.equal(upload.status, 200);
    const ref = (await upload.json()).data.mediaRef;
    const document = { assets: [{ id: 'item-one', kind: 'item', name: 'Coat', category: '',
        tags: [], sceneTags: [], ownerPersonId: '', scope: { type: 'global', id: '', label: 'Global' },
        mediaRef: ref, createdAt: '2026-01-01', updatedAt: '2026-01-01', itemType: 'clothing',
        wearSlot: 'outer-layer', modelDescription: 'Blue coat' }], persons: [], wearStates: [] };
    const put = (user, revision, value) => fetch(`${app.url}/v1/business/collections/outfit`, { method: 'PUT',
        headers: { ...headers, 'x-test-user': user, 'Content-Type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1, revision, document: value }) });
    assert.equal((await put('bob', 0, document)).status, 422);
    const committed = await put('alice', 0, document);
    assert.equal(committed.status, 200);
    assert.deepEqual((await committed.json()).data.document.assets[0].mediaRef, ref);
    assert.equal((await put('alice', 1, { assets: [], persons: [], wearStates: [] })).status, 200);
    const served = await fetch(`${app.url}/v1/media/assets/${ref.assetId}/original`, { headers });
    assert.equal(served.status, 200);
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), bytes);
});

test('SillyTavern 1.19.0 middleware leaves raw PNG readable behind an empty body placeholder', async t => {
    const core = await createCore({ logger: quiet, policyOptions: { configPath: '/fixture/config', read: async () => JSON.stringify({
        schemaVersion: 1, core: { allowedOrigins: ['https://example.invalid'] },
    }) } });
    const app = await sillyTavernHost(core);
    t.after(async () => { await app.close(); await core.shutdown(); });
    const pixels = Buffer.alloc(80 * 80 * 3);
    let seed = 0x12345678;
    for (let i = 0; i < pixels.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        pixels[i] = seed >>> 24;
    }
    const png = await sharp(pixels, { raw: { width: 80, height: 80, channels: 3 } }).png().toBuffer();
    assert.ok(png.length > 1000);
    const headers = { 'X-TTB-Protocol': '1.0', Origin: 'https://example.invalid',
        'Sec-Fetch-Site': 'same-origin', 'X-CSRF-Token': 'fixture-csrf-token',
        'Content-Type': 'image/png', 'x-test-user': 'alice' };
    const upload = extra => request(app.url, '/v1/media/import/local', { method: 'POST', user: null,
        headers: { ...headers, ...extra }, body: png });
    const accepted = await upload();
    assert.deepEqual(Object.keys(app.observed[0].body), []);
    assert.equal(app.observed[0].readableEnded, false, 'the raw stream reaches the plugin unread');
    assert.equal(accepted.code, 200);
    assert.equal(accepted.body.data.mediaRef.provider, 'server');
    const original = await fetch(`${app.url}/v1/media/assets/${accepted.body.data.mediaRef.assetId}/original`,
        { headers: { 'x-test-user': 'alice' } });
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), png);

    const badCsrf = await upload({ 'X-CSRF-Token': 'wrong' });
    assert.equal(badCsrf.code, 403);
    assert.equal(badCsrf.body.error.code, 'CSRF_REJECTED');
    const badOrigin = await upload({ Origin: 'https://other.invalid' });
    assert.equal(badOrigin.code, 403);
    const consumed = await upload({ 'x-test-consume': 'yes' });
    assert.equal(consumed.code, 400);
    assert.equal(consumed.body.error.code, 'INVALID_REQUEST');
    const wrongBody = await upload({ 'x-test-object': 'yes' });
    assert.equal(wrongBody.code, 400);
    assert.equal(wrongBody.body.error.code, 'INVALID_REQUEST');
    const wrongMime = await upload({ 'Content-Type': 'image/jpeg' });
    assert.equal(wrongMime.code, 415);
    assert.equal(wrongMime.body.error.code, 'MIME_MISMATCH');

    const boundedCore = await createCore({ logger: quiet, policyOptions: { configPath: '/fixture/config',
        read: async () => JSON.stringify({ schemaVersion: 1, core: { allowedOrigins: ['https://example.invalid'] },
            media: { maxBytes: 1024 } }) } });
    const bounded = await sillyTavernHost(boundedCore);
    t.after(async () => { await bounded.close(); await boundedCore.shutdown(); });
    const tooLarge = await request(bounded.url, '/v1/media/import/local', { method: 'POST', user: null,
        headers, body: png });
    assert.equal(tooLarge.code, 413);
    assert.equal(tooLarge.body.error.code, 'MEDIA_TOO_LARGE');
});

test('proxy failure degrades Network but permits recovery without a Server restart', async t => {
    const gif = Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64');
    let proxyAvailable = false, attempts = 0;
    const core = await createCore({ logger: quiet, policyOptions: { configPath: '/fixture/config', read: async () => JSON.stringify({
        schemaVersion: 1, core: { allowedOrigins: ['https://example.invalid'] },
        network: { enabled: true, transport: 'http-proxy', proxyUrl: 'http://proxy.example.com:8080',
            destinationPolicy: 'allowlist-only', allowlist: ['example.invalid'] },
    }) }, networkOptions: {
        resolver: { resolve4: async () => ['93.184.216.34'], resolve6: async () => [] },
        open: async () => {
            attempts++;
            if (!proxyAvailable) throw new Error('proxy unavailable');
            const response = Readable.from([gif]); response.statusCode = 200;
            response.headers = { 'content-type': 'image/gif' };
            return { response, close() { response.destroy(); } };
        },
    } });
    const app = await host(core);
    t.after(async () => { await app.close(); await core.shutdown(); });
    const post = () => fetch(`${app.url}/v1/network/fetch`, { method: 'POST', headers: {
        'x-test-user': 'alice', 'X-TTB-Protocol': '1.0', 'Content-Type': 'application/json',
        Origin: 'https://example.invalid', 'X-CSRF-Token': 'fixture-csrf-token',
    }, body: JSON.stringify({ url: 'https://example.invalid/photo.gif', profile: 'image' }) });
    const status = async () => (await request(app.url, '/v1/status', { protocol: '1.0' })).body.data;
    assert.equal((await status()).modules.find(item => item.id === 'network').state, 'ready');
    const failed = await post();
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).error.code, 'TRANSPORT_UNAVAILABLE');
    const degraded = await status();
    assert.equal(degraded.core.state, 'ready');
    assert.equal(degraded.modules.find(item => item.id === 'network').state, 'degraded');
    assert.equal(degraded.capabilities.find(item => item.id === 'network.remoteFetch').operations[0].available, true);
    proxyAvailable = true;
    const recovered = await post();
    assert.equal(recovered.status, 200);
    assert.deepEqual(Buffer.from(await recovered.arrayBuffer()), gif);
    assert.equal(attempts, 2, 'the degraded operation actually retries the proxy');
    assert.equal((await status()).modules.find(item => item.id === 'network').state, 'ready');
});

test('Media Remote Import retries through degraded Network after proxy recovery', async t => {
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ee4400' } }).png().toBuffer();
    let proxyAvailable = false, attempts = 0;
    const core = await createCore({ logger: quiet, policyOptions: { configPath: '/fixture/config', read: async () => JSON.stringify({
        schemaVersion: 1, core: { allowedOrigins: ['https://example.invalid'] },
        network: { enabled: true, transport: 'http-proxy', proxyUrl: 'http://proxy.example.com:8080',
            destinationPolicy: 'allowlist-only', allowlist: ['example.invalid'] },
    }) }, networkOptions: {
        resolver: { resolve4: async () => ['93.184.216.34'], resolve6: async () => [] },
        open: async () => {
            attempts++;
            if (!proxyAvailable) throw new Error('proxy unavailable');
            const response = Readable.from([png]); response.statusCode = 200;
            response.headers = { 'content-type': 'image/png' };
            return { response, close() { response.destroy(); } };
        },
    } });
    const app = await host(core);
    t.after(async () => { await app.close(); await core.shutdown(); });
    const post = () => request(app.url, '/v1/media/import/remote', { method: 'POST', protocol: '1.0', headers: {
        'Content-Type': 'application/json', Origin: 'https://example.invalid',
        'Sec-Fetch-Site': 'same-origin', 'X-CSRF-Token': 'fixture-csrf-token',
    }, body: JSON.stringify({ url: 'https://example.invalid/photo.png' }) });
    const status = async () => (await request(app.url, '/v1/status', { protocol: '1.0' })).body.data;
    const remoteAvailable = snapshot => snapshot.capabilities.find(item => item.id === 'media.assets')
        .operations.find(item => item.id === 'remoteImport').available;

    const failed = await post();
    assert.equal(failed.code, 503);
    assert.equal(failed.body.error.code, 'TRANSPORT_UNAVAILABLE');
    const degraded = await status();
    assert.equal(degraded.modules.find(item => item.id === 'network').state, 'degraded');
    assert.equal(degraded.modules.find(item => item.id === 'media').state, 'ready');
    assert.equal(remoteAvailable(degraded), true);
    proxyAvailable = true;
    const recovered = await post();
    assert.equal(recovered.code, 200);
    assert.equal(recovered.body.data.mediaRef.provider, 'server');
    assert.equal(attempts, 2, 'Media must allow Network to retry the recovered proxy');
    assert.equal((await status()).modules.find(item => item.id === 'network').state, 'ready');
    const original = await fetch(`${app.url}/v1/media/assets/${recovered.body.data.mediaRef.assetId}/original`,
        { headers: { 'x-test-user': 'alice' } });
    assert.equal(original.status, 200);
    assert.deepEqual(Buffer.from(await original.arrayBuffer()), png);
});

test('real HTTP client disconnect aborts the outbound operation', async t => {
    let started, outboundSignal;
    const outboundStarted = new Promise(resolve => { started = resolve; });
    const core = await createCore({ logger: quiet, policyOptions: { configPath: '/fixture/config', read: async () => JSON.stringify({
        schemaVersion: 1, core: { allowedOrigins: ['https://example.invalid'] },
        network: { enabled: true, transport: 'direct', destinationPolicy: 'allowlist-only', allowlist: ['example.invalid'] },
    }) }, networkOptions: {
        resolver: { resolve4: async () => ['93.184.216.34'], resolve6: async () => [] },
        open: async (_target, _policy, signal) => { outboundSignal = signal; started();
            return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); },
    } });
    const app = await host(core);
    t.after(async () => { await app.close(); await core.shutdown(); });
    const abort = new AbortController();
    const pending = fetch(`${app.url}/v1/network/fetch`, { method: 'POST', signal: abort.signal, headers: {
        'x-test-user': 'alice', 'X-TTB-Protocol': '1.0', 'Content-Type': 'application/json',
        Origin: 'https://example.invalid', 'X-CSRF-Token': 'fixture-csrf-token',
    }, body: JSON.stringify({ url: 'https://example.invalid/slow.gif', profile: 'image' }) });
    await outboundStarted;
    abort.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    for (let i = 0; i < 40 && !outboundSignal.aborted; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(outboundSignal.aborted, true);
});

test('explicitly invalid administrator config stays degraded and reports no secrets', async t => {
    const core = await createCore({ logger: quiet, policyOptions: { configPath: '/explicit/file', read: async () => '{bad' } });
    const app = await host(core);
    t.after(async () => { await app.close(); await core.shutdown(); });
    const response = await request(app.url, '/v1/status', { protocol: '1.0' });
    assert.equal(response.body.data.core.state, 'degraded');
    assert.equal(response.body.data.core.reasonCode, 'INVALID_CORE_CONFIG');
    assert.equal(response.body.data.effectivePolicy.source, 'invalid');
    assert.ok(!JSON.stringify(response.body).includes('/explicit/file'));
});

test('shutdown rejects subsequent requests without a stale success snapshot', async t => {
    const core = await createCore({ logger: quiet }), app = await host(core);
    t.after(() => app.close());
    await core.shutdown();
    const response = await request(app.url);
    assert.equal(response.code, 503);
    assert.equal(response.body.error.code, 'CAPABILITY_UNAVAILABLE');
});

test('process restart rotates boot and derived user context without creating persistent files', async () => {
    const first = await createCore({ logger: quiet });
    const second = await createCore({ logger: quiet });
    const a = await host(first), b = await host(second);
    try {
        const one = (await request(a.url, '/v1/status', { protocol: '1.0' })).body.data;
        const two = (await request(b.url, '/v1/status', { protocol: '1.0' })).body.data;
        assert.notEqual(one.bootId, two.bootId);
        assert.notEqual(one.contextId, two.contextId);
        assert.equal(one.policyRevision, two.policyRevision);
    } finally { await a.close(); await b.close(); await first.shutdown(); await second.shutdown(); }
});

test('slow module health and oversized status fail within bounded budget without leaking private content', async t => {
    const slow = await createCore({ logger: quiet, registerModules(registry) {
        registry.register({ id: 'slow', version: '1', capabilities: [], health: () => new Promise(() => {}) });
    } });
    const app = await host(slow);
    t.after(async () => { await app.close(); await slow.shutdown(); });
    const start = Date.now();
    const status = await request(app.url, '/v1/status', { protocol: '1.0' });
    assert.ok(Date.now() - start < 2000);
    assert.equal(status.body.data.modules.find(m => m.id === 'slow').reasonCode, 'MODULE_HEALTH_FAILED');
    const huge = await createCore({ logger: quiet, registerModules(registry) {
        registry.register({ id: 'large', version: 'sensitive'.repeat(40000), capabilities: [] });
    } });
    const largeApp = await host(huge);
    try {
        const result = await request(largeApp.url, '/v1/status', { protocol: '1.0' });
        assert.equal(result.code, 503);
        assert.equal(result.body.error.code, 'CAPABILITY_UNAVAILABLE');
        assert.ok(!JSON.stringify(result.body).includes('sensitive'));
    } finally { await largeApp.close(); await huge.shutdown(); }
});

test('every external hard delete is reference-aware; Governance is paginated, authenticated and fails closed on provider failure', async t => {
    const core = await createCore({ logger: quiet, policyOptions: { configPath: '/fixture/config', read: async () => JSON.stringify({
        schemaVersion: 1, core: { allowedOrigins: ['https://example.invalid'] },
    }) } });
    const app = await sillyTavernHost(core);
    t.after(async () => { await app.close(); await core.shutdown(); });
    await mkdir(path.join(app.dataRoot, 'alice', 'characters'), { recursive: true });
    const headers = { Origin: 'https://example.invalid', 'X-CSRF-Token': 'fixture-csrf-token', 'X-TTB-Protocol': '1.0', 'x-test-user': 'alice' };
    const bytes = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } }).png().toBuffer();
    const upload = await fetch(app.url + '/v1/media/import/local', { method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: bytes });
    const mediaRef = (await upload.json()).data.mediaRef;
    const asset = { id: 'governance-item', kind: 'item', name: '治理测试', category: '', tags: [], sceneTags: [], ownerPersonId: '',
        scope: { type: 'global', id: '', label: '全局' }, mediaRef, createdAt: '2026-01-01', updatedAt: '2026-01-01', itemType: 'clothing', wearSlot: 'outer-layer', modelDescription: '' };
    const commit = (revision, document) => request(app.url, '/v1/business/collections/outfit', { user: 'alice', protocol: '1.0', method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ schemaVersion: 1, revision, document }) });
    assert.equal((await commit(0, { assets: [asset], persons: [], wearStates: [] })).code, 200);
    const raw = () => request(app.url, '/v1/media/assets/' + mediaRef.assetId, { user: 'alice', protocol: '1.0', method: 'DELETE', headers });
    assert.equal((await raw()).body.error.code, 'MEDIA_REFERENCED');
    const batch = csrf => request(app.url, '/v1/governance/delete', { user: 'alice', protocol: '1.0', method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ assetIds: [mediaRef.assetId] }) });
    assert.equal((await batch('wrong')).body.error.code, 'CSRF_REJECTED');
    assert.equal((await batch('fixture-csrf-token')).body.data.items[0].code, 'MEDIA_REFERENCED');
    const page = await request(app.url, '/v1/governance/assets?limit=1&search=' + encodeURIComponent('治理'), { user: 'alice', protocol: '1.0' });
    assert.equal(page.body.data.items.length, 1); assert.equal(page.body.data.total, 1);
    assert.equal((await request(app.url, '/v1/governance/assets?limit=100000', { user: 'alice', protocol: '1.0' })).code, 400);
    assert.equal((await request(app.url, '/v1/governance/assets', { user: '', protocol: '1.0' })).code, 403);
    assert.equal((await request(app.url, '/v1/governance/assets/' + mediaRef.assetId, { user: 'bob', protocol: '1.0' })).code, 404);
    assert.equal((await commit(1, { assets: [], persons: [], wearStates: [] })).code, 200);
    await rm(path.join(app.dataRoot, 'alice', 'characters'), { recursive: true });
    assert.equal((await raw()).body.error.code, 'REFERENCE_ANALYSIS_INCOMPLETE');
    const incomplete = await request(app.url, '/v1/governance/assets', { user: 'alice', protocol: '1.0' });
    assert.equal(incomplete.body.data.items[0].referenceState, 'unknown');
    assert.equal((await fetch(app.url + '/v1/media/assets/' + mediaRef.assetId + '/original', { headers })).status, 200);
    await mkdir(path.join(app.dataRoot, 'alice', 'characters'));
    assert.equal((await raw()).code, 200);
});
