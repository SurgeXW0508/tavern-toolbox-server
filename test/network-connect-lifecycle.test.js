import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { validatePolicy } from '../src/config.js';
import { createNetwork } from '../src/network/index.js';
import { createCore } from '../src/core.js';

const gif = Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64');
const resolver = { resolve4: async () => ['93.184.216.34'], resolve6: async () => [] };

test('stalled TLS after proxy CONNECT ends on timeout/abort and releases image slots for all clients', async t => {
    const sockets = new Set();
    let connected;
    const proxy = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'image/gif', 'Content-Length': String(gif.length) }); res.end(gif);
    });
    proxy.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
    proxy.on('connect', (_req, socket) => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        socket.on('data', () => {}); // Accept ClientHello; never complete TLS.
        connected?.();
    });
    proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
    t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => proxy.close(resolve)); });
    const config = { policy: validatePolicy({ schemaVersion: 1, core: { allowedOrigins: ['https://example.test'] },
        network: { enabled: true, transport: 'http-proxy', proxyUrl: `http://127.0.0.1:${proxy.address().port}`,
            destinationPolicy: 'allowlist-only', allowlist: ['example.test'], allowHttp: true,
            connectTimeoutMs: 80, firstByteTimeoutMs: 100, totalTimeoutMs: 120,
            perUserConcurrency: 1, globalConcurrency: 1, requestsPerMinute: 30 } }) };
    const network = createNetwork(config, { resolver }); t.after(() => network.shutdown());
    const bounded = async promise => {
        let timer;
        try { return await Promise.race([promise.then(() => 'unexpected-success', error => error.code),
            new Promise(resolve => { timer = setTimeout(() => resolve('stuck'), 600); })]); }
        finally { clearTimeout(timer); }
    };
    assert.equal(await bounded(network.fetchImage('https://example.test/stalled', 'desktop')), 'REMOTE_TIMEOUT');
    assert.equal((await network.fetchImage('http://example.test/recovered.gif', 'phone')).mime, 'image/gif');
    for (const limits of [{ connectTimeoutMs: 1500, firstByteTimeoutMs: 50, totalTimeoutMs: 2000 },
        { connectTimeoutMs: 1500, firstByteTimeoutMs: 1500, totalTimeoutMs: 50 }]) {
        const timeoutNetwork = createNetwork({ policy: { ...config.policy, network: { ...config.policy.network, ...limits } } }, { resolver });
        t.after(() => timeoutNetwork.shutdown());
        assert.equal(await bounded(timeoutNetwork.fetchImage('https://example.test/stalled', 'desktop')), 'REMOTE_TIMEOUT');
        assert.equal((await timeoutNetwork.fetchImage('http://example.test/recovered.gif', 'desktop')).mime, 'image/gif');
    }
    for (const user of ['desktop', 'phone', 'tablet']) {
        const controller = new AbortController();
        const tunnelReady = new Promise(resolve => { connected = resolve; });
        const pending = network.fetchImage('https://example.test/stalled', user, controller.signal);
        await tunnelReady;
        await assert.rejects(network.fetchImage('http://example.test/busy.gif', 'another'), { code: 'RESOURCE_BUSY' });
        controller.abort();
        assert.equal(await bounded(pending), 'REMOTE_TIMEOUT');
        assert.equal((await network.fetchImage('http://example.test/recovered.gif', user)).mime, 'image/gif');
    }
    // Full installed-host chain: browser disconnect -> res.close -> controller
    // -> pending proxy TLS acquisition -> image finally -> subsequent fetch.
    const root = await mkdtemp(path.join(tmpdir(), 'ttb-connect-disconnect-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const policy = { schemaVersion: 1, core: config.policy.core, network: { ...config.policy.network,
        connectTimeoutMs: 1500, firstByteTimeoutMs: 1500, totalTimeoutMs: 2000 } };
    const core = await createCore({ logger: { info() {}, error() {} }, networkOptions: { resolver },
        policyOptions: { configPath: path.join(root, 'policy.json'), read: async () => JSON.stringify(policy) } });
    t.after(() => core.shutdown());
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => {
        req.user = { profile: { handle: 'fixture', enabled: true }, directories: { root } };
        req.session = { csrfToken: 'fixture-csrf' }; next();
    });
    const router = express.Router(); core.attach(router); app.use(router);
    const host = app.listen(0, '127.0.0.1'); await once(host, 'listening'); t.after(() => new Promise(resolve => host.close(resolve)));
    const post = (url, signal) => fetch(`http://127.0.0.1:${host.address().port}/v1/network/fetch`, {
        method: 'POST', signal, headers: { Origin: 'https://example.test', 'Content-Type': 'application/json',
            'X-TTB-Protocol': '1.0', 'X-CSRF-Token': 'fixture-csrf' }, body: JSON.stringify({ profile: 'image', url }) });
    const ready = new Promise(resolve => { connected = resolve; }), controller = new AbortController();
    const pending = post('https://example.test/stalled', controller.signal); await ready;
    controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
    let recovered;
    const deadline = Date.now() + 700;
    do {
        recovered = await post('http://example.test/recovered.gif');
        if (recovered.status === 200) break;
        assert.equal((await recovered.json()).error.code, 'RESOURCE_BUSY');
        await new Promise(resolve => setTimeout(resolve, 10));
    } while (Date.now() < deadline);
    assert.equal(recovered.status, 200, 'HTTP disconnect releases the slot before connection/total timeout');
    assert.deepEqual(Buffer.from(await recovered.arrayBuffer()), gif);
});
