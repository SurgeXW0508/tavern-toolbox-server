import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import { Readable } from 'node:stream';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validatePolicy } from '../src/config.js';
import { approveDestination, parseTarget, publicUnicast } from '../src/network/destination.js';
import { createNetwork } from '../src/network/index.js';
import { openApproved } from '../src/network/transport.js';

const gif = Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64');
const config = overrides => ({ policy: validatePolicy({ schemaVersion: 1,
    core: { allowedOrigins: ['https://example.test'] }, network: { enabled: true, transport: 'direct',
        destinationPolicy: 'allowlist-only', allowlist: ['example.test', '*.example.test'], ...overrides } }) });
const resolver = { resolve4: async () => ['93.184.216.34'], resolve6: async () => [] };
const v4 = (...octets) => octets.join('.');
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
const close = server => new Promise(resolve => server.close(resolve));
async function withHostProxyPollution(run) {
    const originalHttp = http.globalAgent;
    const originalHttps = https.globalAgent;
    const names = ['all_proxy', 'no_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];
    const environment = new Map(names.map(name => [name, process.env[name]]));
    let inheritedRequests = 0;
    const blocked = Agent => {
        // agent:false constructs a new instance of globalAgent.constructor,
        // so the sentinel must also poison newly constructed instances.
        class HostAgent extends Agent {
            addRequest() { inheritedRequests++; throw new Error('host global Agent used'); }
        }
        return new HostAgent();
    };
    try {
        http.globalAgent = blocked(http.Agent);
        https.globalAgent = blocked(https.Agent);
        for (const name of names) process.env[name] = 'http://proxy.invalid:9';
        await run();
        assert.equal(inheritedRequests, 0, 'no request inherits a host global Agent');
    } finally {
        http.globalAgent = originalHttp;
        https.globalAgent = originalHttps;
        for (const [name, value] of environment) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
    }
}
function fakeResponse(statusCode, headers = {}, body = gif) {
    const response = Readable.from([body]);
    response.statusCode = statusCode;
    response.headers = headers;
    return { response, close() { response.destroy(); } };
}

test('URL, allowlist, special IPv4/IPv6 and complete DNS set are fail closed', async () => {
    const policy = config().policy.network;
    for (const bad of ['file:///etc/passwd', ['https://', 'u:p', '@example.test/x'].join(''), 'https://example.test:444/x',
        'http://example.test/', 'https://example.test/x#secret', 'https://example.test/\nfoo',
        'https://example.test.evil/x', 'https://evil-example.test/x', 'https://example.test\\@evil.test/x'])
        assert.throws(() => parseTarget(bad, policy), { code: 'TARGET_NOT_ALLOWED' });
    assert.equal(parseTarget('https://EXAMPLE.TEST./p', policy).host, 'example.test');
    assert.equal(parseTarget('https://sub.example.test/p', policy).host, 'sub.example.test');
    assert.equal(parseTarget('https://example.test:443/', policy).host, 'example.test');
    const idn = config({ allowlist: ['BÜCHER.example.test.'] }).policy.network;
    assert.equal(parseTarget('https://bücher.example.test/x', idn).host, 'xn--bcher-kva.example.test');
    for (const ip of [v4(127,0,0,1), v4(10,0,0,1), v4(100,100,100,100), v4(169,254,169,254),
        '192.0.2.1', '198.18.0.1', '224.1.2.3', '0.0.0.0', '::1', 'fd00::1', 'fe80::1',
        '2001:db8::1', '2002:c0a8:1::1', '::ffff:93.184.216.34']) assert.equal(publicUnicast(ip), false, ip);
    for (const ip of ['93.184.216.34', '2606:4700:4700::1111']) assert.equal(publicUnicast(ip), true, ip);
    assert.deepEqual((await approveDestination('https://example.test/x', policy, null,
        { resolve4: async () => ['93.184.216.34'], resolve6: async () => ['2606:4700:4700::1111'] })).addresses,
    ['93.184.216.34', '2606:4700:4700::1111']);
    await assert.rejects(approveDestination('https://example.test/x', policy, null,
        { resolve4: async () => ['93.184.216.34'], resolve6: async () => ['fd00::1'] }), { code: 'DNS_UNSAFE' });
    await assert.rejects(approveDestination('https://example.test/x', policy, null,
        { resolve4: async () => [], resolve6: async () => [] }), { code: 'DNS_UNRESOLVED' });
});

test('image bytes, media validation, redirect checks, limits and slots apply to actual streams', async () => {
    const routes = new Map(); let opens = 0;
    const open = async target => { opens++; return routes.get(target.url.pathname)(); };
    const network = createNetwork(config({ allowHttp: true, maxBytes: 1024, perUserConcurrency: 1, globalConcurrency: 1,
        requestsPerMinute: 3 }), { resolver, open });
    routes.set('/ok', () => fakeResponse(200, { 'content-type': 'image/gif' }));
    routes.set('/html', () => fakeResponse(200, { 'content-type': 'image/gif' }, Buffer.from('<html>')));
    routes.set('/oversize', () => fakeResponse(200, { 'content-type': 'image/gif' }, Buffer.alloc(1025)));
    routes.set('/redirect', () => fakeResponse(302, { location: 'http://127.0.0.1/secret' }));
    assert.equal((await network.fetchImage('https://example.test/ok', 'alice')).mime, 'image/gif');
    await assert.rejects(network.fetchImage('https://example.test/html', 'alice'), { code: 'VALIDATION_FAILED' });
    await assert.rejects(network.fetchImage('https://example.test/oversize', 'alice'), { code: 'REMOTE_RESOURCE_TOO_LARGE' });
    const before = opens;
    await assert.rejects(network.fetchImage('https://example.test/redirect', 'bob'), { code: 'TARGET_NOT_ALLOWED' });
    assert.equal(opens, before + 1, 'redirect never connects to forbidden target');
    await assert.rejects(network.fetchImage('https://example.test/ok', 'alice'), { code: 'RATE_LIMITED' });
    assert.equal((await network.fetchImage('https://example.test/ok', 'bob')).body.length, gif.length);
});

test('HTTP proxy receives approved IP absolute-form while Host keeps original identity; failed proxy never goes direct', async t => {
    const seen = [];
    let proxyAvailable = true;
    const proxy = http.createServer((req, res) => {
        if (!proxyAvailable) { req.socket.destroy(); return; }
        seen.push({ url: req.url, host: req.headers.host, authorization: req.headers.authorization });
        if (req.url.endsWith('/jump')) { res.writeHead(302, { Location: `http://${v4(10,0,0,1)}/private` }); res.end(); return; }
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': String(gif.length) }); res.end(gif);
    });
    const port = await listen(proxy); t.after(() => close(proxy));
    const network = createNetwork(config({ transport: 'http-proxy', proxyUrl: `http://127.0.0.1:${port}`,
        allowHttp: true }), { resolver });
    await withHostProxyPollution(async () => {
        const result = await network.fetchImage('http://example.test/photo.gif', 'alice');
        assert.equal(result.mime, 'image/gif');
        assert.deepEqual(seen, [{ url: 'http://93.184.216.34:80/photo.gif', host: 'example.test', authorization: undefined }]);
        await assert.rejects(network.fetchImage('http://example.test/jump', 'bob'), { code: 'TARGET_NOT_ALLOWED' });
        assert.equal(seen.length, 2, 'proxy does not receive the forbidden redirect destination');
        proxyAvailable = false;
        await assert.rejects(network.fetchImage('http://example.test/photo.gif', 'charlie'), { code: 'TRANSPORT_UNAVAILABLE' });
        assert.equal(network.definition.health().state, 'degraded');
        proxyAvailable = true;
        assert.equal((await network.fetchImage('http://example.test/photo.gif', 'charlie')).mime, 'image/gif');
        assert.equal(network.definition.health().state, 'ready');
        await close(proxy);
        await assert.rejects(network.fetchImage('http://example.test/photo.gif', 'alice'), { code: 'TRANSPORT_UNAVAILABLE' });
        assert.equal(network.definition.health().state, 'degraded');
    });
});

test('HTTPS CONNECT pins the validated IP and preserves hostname SNI and certificate verification', async t => {
    const folder = await mkdtemp(path.join(tmpdir(), 'ttb-network-'));
    t.after(() => rm(folder, { recursive: true, force: true }));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(folder, 'key.pem'),
        '-out', path.join(folder, 'cert.pem'), '-days', '1', '-subj', '/CN=example.test',
        '-addext', 'subjectAltName=DNS:example.test'], { stdio: 'ignore' });
    const key = await readFile(path.join(folder, 'key.pem'));
    const cert = await readFile(path.join(folder, 'cert.pem'));
    const observed = { connect: null, sni: null, host: null };
    const secureServer = tls.createServer({ key, cert }, socket => {
        observed.sni = socket.servername;
        socket.once('data', data => { observed.host = data.toString().match(/\r\nHost: ([^\r\n]+)/i)?.[1];
            socket.end(`HTTP/1.1 200 OK\r\nContent-Type: image/gif\r\nContent-Length: ${gif.length}\r\nConnection: close\r\n\r\n`); });
    });
    const securePort = await listen(secureServer); t.after(() => close(secureServer));
    const proxy = http.createServer();
    proxy.on('connect', (req, client) => {
        observed.connect = req.url;
        const upstream = net.connect({ host: '127.0.0.1', port: securePort });
        upstream.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); client.pipe(upstream).pipe(client); });
    });
    const proxyPort = await listen(proxy); t.after(() => close(proxy));
    const target = await approveDestination('https://example.test/x', config().policy.network, null, resolver);
    const policy = config({ transport: 'http-proxy', proxyUrl: `http://127.0.0.1:${proxyPort}` }).policy.network;
    await withHostProxyPollution(async () => {
        const valid = await openApproved(target, policy, new AbortController().signal, { ca: cert });
        valid.close();
        assert.equal(observed.connect, '93.184.216.34:443');
        assert.equal(observed.sni, 'example.test');
        assert.equal(observed.host, 'example.test');
        await assert.rejects(openApproved(target, policy, new AbortController().signal), /self-signed|certificate/i);
        await assert.rejects(openApproved(target, policy, new AbortController().signal,
            { rejectUnauthorized: false }), /self-signed|certificate/i);
        await assert.rejects(openApproved({ ...target, host: 'wrong.example.test' }, policy,
            new AbortController().signal, { ca: cert }), /altname|hostname/i);
        const directTarget = { ...target, addresses: [v4(127,0,0,1)], port: securePort };
        // Transport-only fixture: production approval rejects this loopback address.
        const direct = await openApproved(directTarget, config().policy.network,
            new AbortController().signal, { ca: cert });
        direct.close();
        assert.equal(observed.sni, 'example.test');
        assert.equal(observed.host, 'example.test');
    });
});

test('direct HTTP owns its pinned socket despite host global Agents and proxy environment', async t => {
    const origin = http.createServer((req, response) => {
        assert.equal(req.headers.host, 'example.test');
        response.end(gif);
    });
    const port = await listen(origin); t.after(() => close(origin));
    const policy = config({ allowHttp: true }).policy.network;
    const approved = await approveDestination('http://example.test/image.gif', policy, null, resolver);
    // Transport-only fixture: production approval rejects this loopback address.
    const target = { ...approved, addresses: [v4(127,0,0,1)], port };
    await withHostProxyPollution(async () => {
        const connection = await openApproved(target, policy, new AbortController().signal);
        assert.equal(connection.response.statusCode, 200);
        connection.close();
    });
});

test('every redirect hop revalidates DNS, allowlist, port, downgrade, cycles and shared hop limit', async () => {
    const policy = config({ allowlist: ['example.test', '*.example.test'], allowHttp: true }).policy;
    let dnsCalls = 0, opened = 0;
    const changing = { resolve4: async () => (++dnsCalls > 1 ? [v4(10,0,0,1)] : ['93.184.216.34']), resolve6: async () => [] };
    const redirect = location => { const response = Readable.from([]); response.statusCode = 302;
        response.headers = { location }; opened++; return { response, close() { response.destroy(); } }; };
    const rebinding = createNetwork({ policy }, { resolver: changing, open: async () => redirect('/next') });
    await assert.rejects(rebinding.fetchImage('https://example.test/first', 'alice'), { code: 'DNS_UNSAFE' });
    assert.equal(opened, 1);
    for (const location of ['https://outside.test/x', 'https://sub.example.test:444/x',
        'http://example.test/x', 'https://example.test/x#fragment', 'https://example.test/first']) {
        const network = createNetwork({ policy }, { resolver, open: async () => redirect(location) });
        await assert.rejects(network.fetchImage('https://example.test/first', 'alice'),
            { code: location.endsWith('/first') || location.includes('#') ? 'REDIRECT_REJECTED' : 'TARGET_NOT_ALLOWED' });
    }
    const visited = [];
    const allowed = createNetwork({ policy }, { resolver, open: async target => {
        visited.push(target.host + target.url.pathname);
        return target.url.pathname === '/done' ? fakeResponse(200, { 'content-type': 'image/gif' })
            : redirect('https://sub.example.test/done');
    } });
    assert.equal((await allowed.fetchImage('https://example.test/first', 'alice')).redirects, 1);
    assert.deepEqual(visited, ['example.test/first', 'sub.example.test/done']);
    let number = 0;
    const endless = createNetwork({ policy }, { resolver, open: async () => redirect(`/hop${++number}`) });
    await assert.rejects(endless.fetchImage('https://example.test/first', 'alice'), { code: 'TOO_MANY_REDIRECTS' });
    assert.equal(number, 4);
});

test('response profile checks signatures, upstream status, encoding, length, idle and stream budget', async () => {
    const jpeg = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);
    const png = Buffer.alloc(25); Buffer.from('89504e470d0a1a0a', 'hex').copy(png); png.write('IHDR', 12);
    const webp = Buffer.alloc(20); webp.write('RIFF'); webp.writeUInt32LE(12, 4); webp.write('WEBP', 8); webp.write('VP8 ', 12);
    for (const [type, body] of [['image/jpeg', jpeg], ['image/png', png], ['image/webp', webp], ['image/gif', gif]]) {
        const network = createNetwork(config(), { resolver, open: async () => fakeResponse(200, { 'content-type': type }, body) });
        assert.equal((await network.fetchImage('https://example.test/x', 'alice')).mime, type);
    }
    for (const status of [403, 404, 429, 500]) {
        const network = createNetwork(config(), { resolver, open: async () => fakeResponse(status, {}, Buffer.from('<html>')) });
        await assert.rejects(network.fetchImage('https://example.test/x', 'alice'), { code: 'REMOTE_UNAVAILABLE' });
    }
    for (const [headers, body, expected] of [
        [{ 'content-type': 'image/png' }, Buffer.from('<html>'), 'VALIDATION_FAILED'],
        [{ 'content-type': 'image/svg+xml' }, Buffer.from('<svg></svg>'), 'VALIDATION_FAILED'],
        [{ 'content-type': 'image/png' }, gif, 'UNSUPPORTED_MEDIA_TYPE'],
        [{ 'content-type': 'image/gif', 'content-encoding': 'gzip' }, gif, 'UNSUPPORTED_MEDIA_TYPE'],
        [{ 'content-type': 'image/gif', 'content-length': String(17 * 1024 * 1024) }, gif, 'REMOTE_RESOURCE_TOO_LARGE'],
        [{ 'content-type': 'image/gif' }, Buffer.alloc(0), 'VALIDATION_FAILED'],
    ]) {
        const network = createNetwork(config(), { resolver, open: async () => fakeResponse(200, headers, body) });
        await assert.rejects(network.fetchImage('https://example.test/x', 'alice'), { code: expected });
    }
    const slow = createNetwork(config({ idleTimeoutMs: 5 }), { resolver, open: async () => {
        const response = Readable.from((async function* () { await new Promise(resolve => setTimeout(resolve, 50)); yield gif; })());
        response.statusCode = 200; response.headers = { 'content-type': 'image/gif' };
        return { response, close() { response.destroy(); } };
    } });
    await assert.rejects(slow.fetchImage('https://example.test/x', 'alice'), { code: 'REMOTE_TIMEOUT' });
    const chunks = createNetwork(config({ maxBytes: gif.length }), { resolver, open: async () => {
        const response = Readable.from([gif, Buffer.from('extra')]); response.statusCode = 200;
        response.headers = { 'content-type': 'image/gif' }; return { response, close() { response.destroy(); } };
    } });
    await assert.rejects(chunks.fetchImage('https://example.test/x', 'alice'), { code: 'REMOTE_RESOURCE_TOO_LARGE' });
});

test('per-user and global slots reject without queues and are freed by abort and shutdown', async () => {
    const pending = [];
    const network = createNetwork(config({ perUserConcurrency: 1, globalConcurrency: 2 }), { resolver,
        open: async (_target, _policy, signal) => new Promise((resolve, reject) => {
            const item = { resolve, reject }; pending.push(item);
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }) });
    const a = new AbortController(), b = new AbortController();
    const first = network.fetchImage('https://example.test/one', 'alice', a.signal);
    const second = network.fetchImage('https://example.test/two', 'bob', b.signal);
    while (pending.length < 2) await new Promise(resolve => setTimeout(resolve, 0));
    await assert.rejects(network.fetchImage('https://example.test/three', 'alice'), { code: 'RESOURCE_BUSY' });
    await assert.rejects(network.fetchImage('https://example.test/three', 'charlie'), { code: 'RESOURCE_BUSY' });
    a.abort();
    await assert.rejects(first, { code: 'REMOTE_TIMEOUT' });
    const third = network.fetchImage('https://example.test/three', 'charlie');
    while (pending.length < 3) await new Promise(resolve => setTimeout(resolve, 0));
    network.shutdown();
    await assert.rejects(second, { code: 'REMOTE_TIMEOUT' });
    await assert.rejects(third, { code: 'REMOTE_TIMEOUT' });
});
