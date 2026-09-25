import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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
    const proxy = http.createServer((req, res) => {
        seen.push({ url: req.url, host: req.headers.host, authorization: req.headers.authorization });
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': String(gif.length) }); res.end(gif);
    });
    const port = await listen(proxy); t.after(() => close(proxy));
    const network = createNetwork(config({ transport: 'http-proxy', proxyUrl: `http://127.0.0.1:${port}`,
        allowHttp: true }), { resolver });
    const result = await network.fetchImage('http://example.test/photo.gif', 'alice');
    assert.equal(result.mime, 'image/gif');
    assert.deepEqual(seen, [{ url: 'http://93.184.216.34:80/photo.gif', host: 'example.test', authorization: undefined }]);
    await close(proxy);
    await assert.rejects(network.fetchImage('http://example.test/photo.gif', 'alice'), { code: 'TRANSPORT_UNAVAILABLE' });
    assert.equal(network.definition.health().state, 'degraded');
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
    const valid = await openApproved(target, policy, new AbortController().signal, { ca: cert });
    valid.close();
    assert.equal(observed.connect, '93.184.216.34:443');
    assert.equal(observed.sni, 'example.test');
    assert.equal(observed.host, 'example.test');
    await assert.rejects(openApproved(target, policy, new AbortController().signal), /self-signed|certificate/i);
});
