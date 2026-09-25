import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validatePolicy } from '../src/config.js';
import { createNetwork } from '../src/network/index.js';
import { openApproved } from '../src/network/transport.js';
import { initRequestProxy } from './fixtures/st-request-proxy.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
const approvedIP = '93.184.216.34';
const imageUrl = 'https://example.test/image.png';
async function listen(server) {
    server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port;
}

test('real ST ProxyAgent initialization preserves TTB HTTPS fetch and host API proxy, including recovery', async t => {
    const originalHttp = http.globalAgent, originalHttps = https.globalAgent;
    const envNames = ['all_proxy', 'no_proxy', 'http_proxy', 'https_proxy', 'npm_config_proxy',
        'npm_config_http_proxy', 'npm_config_https_proxy', 'npm_config_no_proxy']
        .flatMap(name => [name, name.toUpperCase()]);
    const environment = new Map(envNames.map(name => [name, process.env[name]]));
    // Only this isolated test process is normalized; production never changes host environment.
    for (const name of envNames) delete process.env[name];
    const sockets = new Set();
    const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); return socket; };
    const folder = await mkdtemp(path.join(tmpdir(), 'ttb-host-proxy-'));
    let origin, proxy, hostAgent;
    t.after(async () => {
        hostAgent?.destroy();
        http.globalAgent = originalHttp; https.globalAgent = originalHttps;
        for (const [name, value] of environment) {
            if (value === undefined) delete process.env[name]; else process.env[name] = value;
        }
        for (const socket of sockets) socket.destroy();
        await Promise.all([origin, proxy].filter(Boolean).map(server => new Promise(resolve => server.close(resolve))));
        await rm(folder, { recursive: true, force: true });
    });
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(folder, 'key.pem'),
        '-out', path.join(folder, 'cert.pem'), '-days', '1', '-subj', '/CN=example.test',
        '-addext', 'subjectAltName=DNS:example.test'], { stdio: 'ignore' });
    const key = await readFile(path.join(folder, 'key.pem'));
    const cert = await readFile(path.join(folder, 'cert.pem'));
    const authorities = [], identities = [];
    origin = tls.createServer({ key, cert }, socket => {
        socket.once('data', data => {
            identities.push({ sni: socket.servername, host: data.toString().match(/\r\nHost: ([^\r\n]+)/i)?.[1] });
            socket.end(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nContent-Length: ${png.length}\r\nConnection: close\r\n\r\n`), png]));
        });
    });
    origin.on('connection', track);
    const originPort = await listen(origin);
    let proxyHealthy = true;
    proxy = http.createServer();
    proxy.on('connection', track);
    proxy.on('connect', (req, client) => {
        authorities.push(req.url);
        if (!proxyHealthy) { client.destroy(); return; }
        // A disposable proxy maps only the two known fixture authorities. It
        // never resolves an unchecked target or accesses any external service.
        if (![`${approvedIP}:443`, 'example.test:443'].includes(req.url)) { client.destroy(); return; }
        const upstream = track(net.connect({ host: '127.0.0.1', port: originPort }));
        client.once('error', () => upstream.destroy());
        upstream.once('error', () => client.destroy());
        client.once('close', () => upstream.destroy());
        upstream.once('close', () => client.destroy());
        upstream.once('connect', () => { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); client.pipe(upstream).pipe(client); });
    });
    const proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
    const config = { policy: validatePolicy({ schemaVersion: 1, core: { allowedOrigins: ['https://example.test'] },
        network: { enabled: true, transport: 'http-proxy', proxyUrl, destinationPolicy: 'allowlist-only', allowlist: ['example.test'] } }) };
    const rootErrors = [];
    const network = createNetwork(config, {
        resolver: { resolve4: async () => [approvedIP], resolve6: async () => [] },
        open: async (...args) => {
            // Development instrumentation at the real transport boundary. Only
            // synthetic fixture errors are retained; nothing enters production logs.
            try { return await openApproved(...args, { ca: cert }); }
            catch (error) { rootErrors.push(error); throw error; }
        },
    });
    const fetchImage = async () => {
        let result;
        try { result = await network.fetchImage(imageUrl, 'fixture'); }
        catch (error) { assert.fail(`Fixture transport: ${rootErrors.at(-1)?.stack || error.code}`); }
        assert.equal(result.mime, 'image/png');
        assert.deepEqual(result.body, png);
        assert.equal(authorities.at(-1), `${approvedIP}:443`);
        assert.deepEqual(identities.at(-1), { sni: 'example.test', host: 'example.test' });
    };
    await fetchImage(); // Before initRequestProxy.
    hostAgent = initRequestProxy({ url: proxyUrl, bypass: ['bypass.example.test'] });
    await fetchImage(); // After initRequestProxy: used to fail before any CONNECT.
    assert.equal(rootErrors.length, 0);

    const hostApiRequest = () => new Promise((resolve, reject) => {
        // ST-style request uses the host global Agent, without a TTB override.
        const request = https.get(imageUrl, { ca: cert }, async response => {
            try {
                assert.equal(response.socket.authorized, true);
                const chunks = []; for await (const chunk of response) chunks.push(chunk);
                assert.deepEqual(Buffer.concat(chunks), png);
                resolve();
            } catch (error) { reject(error); }
        });
        request.on('error', reject);
        request.setTimeout(3000, () => request.destroy(new Error('fixture timeout')));
    });
    await hostApiRequest();
    assert.equal(authorities.at(-1), 'example.test:443', 'ST still uses its own proxy transport');
    proxyHealthy = false;
    await assert.rejects(network.fetchImage(imageUrl, 'fixture'), { code: 'TRANSPORT_UNAVAILABLE' });
    assert.equal(network.definition.health().state, 'degraded');
    proxyHealthy = true;
    await fetchImage();
    assert.equal(network.definition.health().state, 'ready');
    await hostApiRequest();
    assert.equal(authorities.at(-1), 'example.test:443');
    assert.equal(http.globalAgent, hostAgent); assert.equal(https.globalAgent, hostAgent);
    assert.equal(process.env.all_proxy, proxyUrl);
    assert.equal(process.env.no_proxy, 'bypass.example.test');
});
