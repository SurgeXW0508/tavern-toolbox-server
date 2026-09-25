import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { createCore, SERVER_VERSION } from '../src/core.js';
import { CapabilityRegistry } from '../src/registry.js';
import { loadPolicy, validatePolicy } from '../src/config.js';
import { info } from '../index.js';
import { userContext } from '../src/security.js';
import { Readable } from 'node:stream';

function hostRouter() {
    const stack = [];
    return {
        stack,
        use(fn) { stack.push({ fn }); },
        get(path, fn) { stack.push({ method: 'GET', path, fn }); },
        post(path, fn) { stack.push({ method: 'POST', path, fn }); },
    };
}

async function host(core) {
    const router = hostRouter();
    core.attach(router);
    const server = http.createServer((req, res) => {
        req.path = new URL(req.url, 'http://localhost').pathname;
        req.get = name => req.headers[name.toLowerCase()];
        req.session = { csrfToken: 'fixture-csrf-token' };
        req.user = req.headers['x-test-user'] ? {
            profile: { handle: req.headers['x-test-user'], enabled: true },
            directories: { root: `/srv/st/data/${req.headers['x-test-user']}` },
        } : undefined;
        res.locals = {};
        res.status = n => { res.statusCode = n; return res; };
        res.type = () => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); return res; };
        res.send = payload => res.end(payload);
        let index = 0;
        const next = () => {
            const layer = router.stack[index++];
            if (!layer) return res.end();
            if (layer.method && (layer.method !== req.method || layer.path !== req.path)) return next();
            Promise.resolve(layer.fn(req, res, next)).catch(() => { res.statusCode = 500; res.end(); });
        };
        next();
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return { server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => server.close(resolve)) };
}

async function request(url, route = '/status', { user = 'alice', method = 'GET', protocol, headers = {}, body } = {}) {
    const result = await fetch(`${url}${route}`, { method, headers: {
        ...(user ? { 'x-test-user': user } : {}), ...(protocol ? { 'X-TTB-Protocol': protocol } : {}), ...headers,
    }, body });
    return { code: result.status, headers: result.headers, body: await result.json() };
}

const quiet = { info() {}, error() {} };

test('real HTTP discovery: exact product, read-only routes, version contract and no-store', async t => {
    const fixture = JSON.parse(await readFile(new URL('../protocol/v1.0.fixture.json', import.meta.url), 'utf8'));
    const core = await createCore({ logger: quiet });
    const app = await host(core);
    t.after(async () => { await app.close(); await core.shutdown(); });
    const boot = await request(app.url);
    assert.equal(boot.code, 200);
    assert.equal(boot.body.data.product, info.id);
    assert.deepEqual(boot.body.data, fixture.bootstrap.data);
    assert.equal(boot.body.data.serverVersion, SERVER_VERSION);
    assert.deepEqual(boot.body.data.protocols, [{ major: 1, minMinor: 0, maxMinor: 0 }]);
    assert.equal(boot.headers.get('cache-control'), 'no-store');
    assert.ok(boot.body.meta.requestId);
    const status = await request(app.url, '/v1/status', { protocol: '1.0' });
    assert.equal(status.code, 200);
    assert.deepEqual(status.body.meta.protocol, { major: 1, minor: 0 });
    assert.deepEqual(status.body.data.capabilities.map(item => item.id), ['core.status', 'network.remoteFetch']);
    assert.deepEqual(status.body.data.capabilities[0], fixture.status.data.capabilities[0]);
    assert.deepEqual(status.body.data.effectivePolicy, fixture.status.data.effectivePolicy);
    assert.deepEqual(status.body.data.modules.map(item => item.id), ['core', 'network']);
    assert.equal(status.body.data.modules[1].state, 'disabled');
    assert.equal(status.body.data.core.state, 'ready');
    assert.equal(status.body.data.effectivePolicy.unsafeRequestsEnabled, false);
    assert.equal((await request(app.url, '/status', { method: 'POST' })).code, 405);
    assert.equal((await request(app.url, '/proxy?url=http://127.0.0.1')).code, 404);
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
