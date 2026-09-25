import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { NetworkFailure } from './destination.js';

function hostHeader(target) {
    return target.host.includes(':') ? `[${target.host}]` : target.host;
}

export function openApproved(target, policy, signal, tlsOptions = {}) {
    const ip = target.addresses[0]; // Every candidate passed the same policy; never resolve the hostname again.
    const hostname = hostHeader(target);
    const headers = { Host: hostname, Accept: 'image/png,image/jpeg,image/webp,image/gif',
        'Accept-Encoding': 'identity', 'User-Agent': 'TavernToolboxServer/remoteFetch' };
    const path = target.url.pathname + target.url.search;
    let request, agent;
    if (policy.transport === 'http-proxy') {
        const proxy = new URL(policy.proxyUrl);
        const auth = proxy.username ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` : null;
        if (target.url.protocol === 'http:') {
            request = http.request({ hostname: proxy.hostname, port: proxy.port, method: 'GET',
                path: `http://${ip.includes(':') ? `[${ip}]` : ip}:${target.port}${path}`, headers: { ...headers, ...(auth ? { 'Proxy-Authorization': auth } : {}) },
                signal, agent: false });
        } else {
            agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
            agent.createConnection = (options, callback) => {
                const tunnel = http.request({ hostname: proxy.hostname, port: proxy.port, method: 'CONNECT',
                    path: `${ip.includes(':') ? `[${ip}]` : ip}:${target.port}`, signal, agent: false,
                    headers: { Host: `${ip.includes(':') ? `[${ip}]` : ip}:${target.port}`,
                        ...(auth ? { 'Proxy-Authorization': auth } : {}) } });
                const timer = setTimeout(() => tunnel.destroy(new Error('REMOTE_TIMEOUT')), policy.connectTimeoutMs);
                tunnel.once('connect', (response, socket) => {
                    clearTimeout(timer);
                    if (response.statusCode !== 200) { socket.destroy(); callback(new NetworkFailure('TRANSPORT_UNAVAILABLE')); return; }
                    const secure = tls.connect({ socket, servername: target.host, rejectUnauthorized: true, ...tlsOptions,
                        ALPNProtocols: ['http/1.1'] });
                    let settled = false;
                    const done = (error, value) => { if (!settled) { settled = true; callback(error, value); } };
                    secure.once('secureConnect', () => done(null, secure));
                    secure.once('error', error => done(error));
                    signal.addEventListener('abort', () => secure.destroy(), { once: true });
                });
                tunnel.once('error', error => { clearTimeout(timer); callback(error); });
                tunnel.end();
            };
            request = https.request({ hostname: target.host, port: target.port, method: 'GET', path,
                headers, signal, agent, servername: target.host, rejectUnauthorized: true, ...tlsOptions });
        }
    } else {
        const options = { hostname: target.host, port: target.port, method: 'GET', path, headers, signal,
            agent: false, lookup: (_host, _options, cb) => cb(null, ip, ip.includes(':') ? 6 : 4) };
        request = target.url.protocol === 'https:' ? https.request({ ...options, servername: target.host,
            rejectUnauthorized: true, ...tlsOptions }) : http.request(options);
    }
    return new Promise((resolve, reject) => {
        const connectTimer = setTimeout(() => request.destroy(new Error('REMOTE_TIMEOUT')), policy.connectTimeoutMs);
        const timer = setTimeout(() => request.destroy(new Error('REMOTE_TIMEOUT')), policy.firstByteTimeoutMs);
        request.once('socket', socket => {
            if (!socket.connecting && !socket.secureConnecting) clearTimeout(connectTimer);
            else { socket.once('connect', () => { if (!socket.secureConnecting) clearTimeout(connectTimer); });
                socket.once('secureConnect', () => clearTimeout(connectTimer)); }
        });
        request.once('response', response => { clearTimeout(timer); clearTimeout(connectTimer); resolve({ response, close: () => { response.destroy(); request.destroy(); agent?.destroy(); } }); });
        request.once('error', error => { clearTimeout(timer); clearTimeout(connectTimer); agent?.destroy(); reject(error); });
        request.end();
    });
}
