import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import express from 'express';
import { validatePolicy } from '../src/config.js';
import { createAudio } from '../src/network/audio.js';
import { createNetwork } from '../src/network/index.js';
import { audioResponse, singleRange } from '../src/network/audio-profile.js';
import { createCore } from '../src/core.js';

const origin = 'https://example.invalid';
const document = (network = {}, audio = {}) => ({ schemaVersion: 1, core: { allowedOrigins: [origin] },
    network: { enabled: true, transport: 'direct', destinationPolicy: 'allowlist-only', allowlist: ['audio.example.com'], ...network }, audio });
const config = (network, audio) => ({ policy: validatePolicy(document(network, audio)) });
const resolver = { resolve4: async () => ['8.8.8.8'], resolve6: async () => [] };
const signal = () => new AbortController().signal;
const source = 'https://audio.example.com/voice.mp3?signature=private-fixture';
function response(statusCode = 200, headers = {}, body = Buffer.from('0123456789')) {
    const stream = Readable.from([body]);
    stream.statusCode = statusCode; stream.headers = { 'content-type': 'audio/mpeg', 'content-length': String(body.length), ...headers };
    return { response: stream, close: () => stream.destroy() };
}
function sink() {
    const chunks = [], headers = {};
    const stream = new Writable({ write(chunk, _encoding, callback) { chunks.push(chunk); callback(); } });
    stream.setHeader = (key, value) => { headers[key] = value; };
    return Object.assign(stream, { headers, bytes: () => Buffer.concat(chunks) });
}
async function access(audio, user = 'alice', url = source) { return audio.create(url, user, signal()); }

test('opaque exact-source accesses are user scoped, bounded, expiring, idempotently released and boot local', async () => {
    let now = 1000;
    const audio = createAudio(config({}, { accessTtlMs: 50, perUserAccess: 1 }), { resolver, clock: () => now });
    const first = await access(audio);
    assert.match(first.accessId, /^[A-Za-z0-9_-]{32}$/);
    assert.doesNotMatch(JSON.stringify(first), /signature|voice|alice|audio\.example/);
    assert.throws(() => audio.inspect(first.accessId, 'bob'), { code: 'AUDIO_ACCESS_EXPIRED' });
    await assert.rejects(access(audio), { code: 'RESOURCE_BUSY' });
    audio.release(first.accessId, 'bob'); assert.equal(audio.inspect(first.accessId, 'alice').state, 'ready');
    now += 51;
    assert.throws(() => audio.inspect(first.accessId, 'alice'), { code: 'AUDIO_ACCESS_EXPIRED' });
    const next = await access(audio); assert.notEqual(next.accessId, first.accessId);
    const restarted = createAudio(config(), { resolver });
    assert.throws(() => restarted.inspect(next.accessId, 'alice'), { code: 'AUDIO_ACCESS_EXPIRED' });
    audio.release(next.accessId, 'alice'); audio.release(next.accessId, 'alice');
    assert.throws(() => audio.inspect(next.accessId, 'alice'), { code: 'AUDIO_ACCESS_EXPIRED' });
});

test('Range parsing and finite response validation reject multipart, unknown totals, forged intervals and oversized whole files', () => {
    for (const range of ['bytes=0-4', 'bytes=5-', 'bytes=-3']) assert.equal(singleRange(range), range);
    for (const range of ['bytes=0-1,4-5', 'items=0-4', 'bytes=-', 'bytes=3-2', 'bytes=-0', 'bytes=9007199254740992-'])
        assert.throws(() => singleRange(range), { code: 'UNSUPPORTED_RANGE' });
    assert.throws(() => audioResponse(response(206, { 'content-range': 'bytes 0-4/999', 'content-length': '5' }).response,
        'bytes=0-4', 100), { code: 'REMOTE_RESOURCE_TOO_LARGE' });
    assert.throws(() => audioResponse(response(206, { 'content-range': 'bytes 0-4/*', 'content-length': '5' }).response,
        'bytes=0-4', 100), { code: 'INVALID_REMOTE_RESPONSE' });
    assert.throws(() => audioResponse(response(200, { 'content-length': undefined }).response, undefined, 100), { code: 'REMOTE_SIZE_UNKNOWN' });
    assert.throws(() => audioResponse(response(206, { 'content-range': 'bytes 1-4/10', 'content-length': '4' }).response,
        'bytes=0-4', 100), { code: 'INVALID_REMOTE_RESPONSE' });
    assert.throws(() => audioResponse(response(200, { 'content-type': 'application/octet-stream' }).response, undefined, 100),
        { code: 'UNSUPPORTED_MEDIA_TYPE' });
    assert.throws(() => audioResponse(response(200, { 'content-encoding': 'gzip' }).response, undefined, 100), { code: 'UNSUPPORTED_MEDIA_TYPE' });
});

test('stream forwards Range and preserves 206, 416 and ignored Range 200 without emulation', async () => {
    const seen = [];
    const audio = createAudio(config(), { resolver, open: async (target, _policy, _signal, _tls, profile) => {
        seen.push({ source: target.url.href, profile });
        if (profile.range === 'bytes=2-5') return response(206, { 'content-range': 'bytes 2-5/10', 'content-length': '4', 'accept-ranges': 'bytes' }, Buffer.from('2345'));
        if (profile.range === 'bytes=99-') return response(416, { 'content-range': 'bytes */10' });
        return response();
    } });
    const ticket = await access(audio);
    for (const [range, status, bytes] of [['bytes=2-5', 206, '2345'], ['bytes=99-', 416, ''], ['bytes=0-', 200, '0123456789']]) {
        const output = sink(); await audio.stream(ticket.accessId, 'alice', range, output, signal());
        assert.equal(output.statusCode, status); assert.equal(output.bytes().toString(), bytes);
        if (status === 206) { assert.equal(output.headers['Content-Range'], 'bytes 2-5/10'); assert.equal(output.headers['Content-Length'], '4'); }
    }
    assert.ok(seen.every(item => item.source === source));
    assert.deepEqual(seen.map(item => item.profile.range), ['bytes=2-5', 'bytes=99-', 'bytes=0-']);
});

test('every stream revalidates current allowlist and DNS; redirects cannot escape or downgrade', async () => {
    const cfg = config({ allowHttp: true }); let privateDns = false, opens = 0, redirect = null;
    const audio = createAudio(cfg, { resolver: { resolve4: async () => [privateDns ? '127.0.0.1' : '8.8.8.8'], resolve6: async () => [] },
        open: async () => { opens++; return redirect ? response(302, { location: redirect }) : response(); } });
    const ticket = await access(audio);
    privateDns = true;
    await assert.rejects(audio.stream(ticket.accessId, 'alice', undefined, sink(), signal()), { code: 'DNS_UNSAFE' });
    assert.equal(opens, 0); privateDns = false;
    for (const destination of ['https://other.example.com/x', 'http://audio.example.com/x', 'https://audio.example.com/x#token']) {
        redirect = destination;
        await assert.rejects(audio.stream(ticket.accessId, 'alice', 'bytes=0-', sink(), signal()), error => ['TARGET_NOT_ALLOWED', 'REDIRECT_REJECTED'].includes(error.code));
    }
    cfg.policy = validatePolicy(document({ allowlist: [] }));
    const before = opens;
    await assert.rejects(audio.stream(ticket.accessId, 'alice', undefined, sink(), signal()), { code: 'TARGET_NOT_ALLOWED' });
    assert.equal(opens, before);
    await assert.rejects(access(audio), { code: 'TARGET_NOT_ALLOWED' });
});

test('long finite streaming ignores image total timeout and does not consume image concurrency', async () => {
    const cfg = config({ totalTimeoutMs: 1, perUserConcurrency: 1, globalConcurrency: 1 });
    const audio = createAudio(cfg, { resolver, open: async () => {
        const stream = Readable.from((async function* () { yield Buffer.from('01234'); await new Promise(resolve => setTimeout(resolve, 35)); yield Buffer.from('56789'); })());
        stream.statusCode = 200; stream.headers = { 'content-type': 'audio/mp4', 'content-length': '10' };
        return { response: stream, close: () => stream.destroy() };
    } });
    const ticket = await access(audio), output = sink();
    const streaming = audio.stream(ticket.accessId, 'alice', undefined, output, signal());
    const network = createNetwork(config({ perUserConcurrency: 1, globalConcurrency: 1 }), { resolver,
        open: async () => response(200, { 'content-type': 'image/gif' }, Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64')) });
    const image = await network.fetchImage('https://audio.example.com/x.gif', 'alice');
    assert.equal(image.mime, 'image/gif'); await streaming; assert.equal(output.bytes().length, 10);
});

test('client abort and release promptly close upstream, free audio slots, and never return source URLs in inspect', async () => {
    let upstreamClosed = 0, started;
    const opened = new Promise(resolve => { started = resolve; });
    const audio = createAudio(config({}, { perUserConcurrency: 1, globalConcurrency: 1 }), { resolver, open: async () => {
        const stream = new Readable({ read() {} }); stream.statusCode = 200;
        stream.headers = { 'content-type': 'audio/mpeg', 'content-length': '100' }; started();
        return { response: stream, close() { upstreamClosed++; stream.destroy(); } };
    } });
    const ticket = await access(audio), controller = new AbortController();
    const first = audio.stream(ticket.accessId, 'alice', undefined, sink(), controller.signal);
    await opened;
    await assert.rejects(audio.stream(ticket.accessId, 'alice', undefined, sink(), signal()), { code: 'RESOURCE_BUSY' });
    controller.abort(); await assert.rejects(first, { code: 'CLIENT_ABORTED' }); assert.equal(upstreamClosed, 1);
    assert.doesNotMatch(JSON.stringify(audio.inspect(ticket.accessId, 'alice')), /signature|voice|alice/);
    const next = audio.stream(ticket.accessId, 'alice', undefined, sink(), signal());
    await new Promise(resolve => setImmediate(resolve)); audio.release(ticket.accessId, 'alice');
    await assert.rejects(next, { code: 'CLIENT_ABORTED' }); assert.equal(upstreamClosed, 2);
});

test('unknown length and stalled body fail closed; audio failures leave image health unchanged', async () => {
    const cfg = config({ transport: 'http-proxy', proxyUrl: 'http://localhost:1234' }, { firstByteTimeoutMs: 20 });
    let mode = 'proxy';
    const audio = createAudio(cfg, { resolver, open: async () => {
        if (mode === 'proxy') throw new Error('fixture');
        if (mode === 'unknown') return response(200, { 'content-length': undefined });
        if (mode === 'mime') return response(200, { 'content-type': 'text/html' });
        const stream = new Readable({ read() {} }); stream.statusCode = 200; stream.headers = { 'content-type': 'audio/mpeg', 'content-length': '10' };
        return { response: stream, close: () => stream.destroy() };
    } });
    const ticket = await access(audio);
    await assert.rejects(audio.stream(ticket.accessId, 'alice', undefined, sink(), signal()), { code: 'TRANSPORT_UNAVAILABLE' });
    assert.equal(audio.definition.health().state, 'degraded');
    assert.equal(createNetwork(cfg).definition.health().state, 'ready');
    mode = 'unknown'; await assert.rejects(audio.stream(ticket.accessId, 'alice', undefined, sink(), signal()), { code: 'REMOTE_SIZE_UNKNOWN' });
    mode = 'mime'; await assert.rejects(audio.stream(ticket.accessId, 'alice', undefined, sink(), signal()), { code: 'UNSUPPORTED_MEDIA_TYPE' });
    mode = 'stall'; await assert.rejects(audio.stream(ticket.accessId, 'alice', undefined, sink(), signal()), { code: 'REMOTE_TIMEOUT' });
    assert.equal(audio.inspect(ticket.accessId, 'alice').code, 'REMOTE_TIMEOUT');
});

test('invalid audio policy is isolated from Network and legacy policy gets additive defaults', () => {
    const cfg = config({}, { maxResourceBytes: 0 });
    assert.equal(cfg.policy.audioError, 'INVALID_AUDIO_CONFIG'); assert.equal(cfg.policy.networkError, null);
    assert.equal(createAudio(cfg).definition.health().state, 'unavailable');
    assert.equal(createNetwork(cfg).definition.health().state, 'ready');
    const legacy = document(); delete legacy.audio;
    assert.equal(validatePolicy(legacy).audio.accessTtlMs, 30 * 60 * 1000);
});

test('installed-host control requires Origin/CSRF/protocol; native GET uses session identity and controlled upstream headers', async t => {
    const seen = [], logs = [];
    const proxy = http.createServer((req, res) => { seen.push({ url: req.url, headers: req.headers });
        const range = req.headers.range;
        res.writeHead(range ? 206 : 200, { 'Content-Type': 'audio/mpeg', 'Content-Length': range ? '4' : '10',
            ...(range ? { 'Content-Range': 'bytes 2-5/10' } : {}) }); res.end(range ? '2345' : '0123456789'); });
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    const policy = document({ transport: 'http-proxy', proxyUrl: `http://127.0.0.1:${proxy.address().port}`, allowHttp: true });
    const core = await createCore({ logger: { info: value => logs.push(value), error: value => logs.push(value) },
        policyOptions: { configPath: '/fixture/config', read: async () => JSON.stringify(policy) }, audioOptions: { resolver } });
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.session = { csrfToken: 'fixture-csrf' };
        req.user = req.headers['x-test-user'] ? { profile: { handle: req.headers['x-test-user'], enabled: true }, directories: { root: '/fixture/' + req.headers['x-test-user'] } } : null; next(); });
    const router = express.Router(); core.attach(router); app.use('/api/plugins/tavern-toolbox-server', router);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    t.after(async () => { await core.shutdown(); server.closeAllConnections(); proxy.closeAllConnections();
        await new Promise(resolve => server.close(resolve)); await new Promise(resolve => proxy.close(resolve)); });
    const base = `http://127.0.0.1:${server.address().port}/api/plugins/tavern-toolbox-server`;
    const headers = { 'x-test-user': 'alice', 'X-TTB-Protocol': '1.0', Origin: origin, 'X-CSRF-Token': 'fixture-csrf', 'Content-Type': 'application/json' };
    const body = JSON.stringify({ profile: 'audio', url: source.replace('https:', 'http:') });
    for (const [key, status] of [['Origin', 403], ['X-CSRF-Token', 403], ['X-TTB-Protocol', 409], ['x-test-user', 403]]) {
        const broken = { ...headers }; delete broken[key];
        assert.equal((await fetch(base + '/v1/network/audio/access', { method: 'POST', headers: broken, body })).status, status);
    }
    const created = await fetch(base + '/v1/network/audio/access', { method: 'POST', headers, body });
    const ticket = (await created.json()).data; assert.ok(ticket.accessId);
    const path = base + '/v1/network/audio/stream/' + ticket.accessId;
    const native = await fetch(path, { headers: { 'x-test-user': 'alice', Range: 'bytes=2-5', Cookie: 'private-cookie', Authorization: 'private-auth', Referer: origin + '/private' } });
    assert.equal(native.status, 206); assert.equal(await native.text(), '2345');
    assert.equal(native.headers.get('cache-control'), 'no-store');
    assert.equal(native.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(seen[0].headers.range, 'bytes=2-5'); assert.equal(seen[0].headers.host, 'audio.example.com');
    for (const key of ['cookie', 'authorization', 'referer', 'x-test-user', 'x-csrf-token']) assert.equal(seen[0].headers[key], undefined);
    assert.equal((await fetch(path, { headers: { 'x-test-user': 'bob' } })).status, 410);
    assert.equal((await fetch(path, { headers: { 'x-test-user': 'alice', 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await fetch(path, { headers: { 'x-test-user': 'alice', Range: 'bytes=0-1,4-5' } })).status, 400);
    assert.doesNotMatch(JSON.stringify(logs), /signature|private-cookie|private-auth|alice|voice\.mp3/);
    assert.doesNotMatch(JSON.stringify(logs), new RegExp(ticket.accessId));
});
