import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { NetworkFailure } from './destination.js';

function hostHeader(target) {
    return target.host.includes(':') ? `[${target.host}]` : target.host;
}

// Always own the socket creation. An implicit Agent (including agent:false) can
// inherit the host's process-wide proxy settings; neither must choose our peer.
function plainAgent(host, port) {
    const agent = new http.Agent({ keepAlive: false, maxSockets: 1 });
    agent.createConnection = () => net.connect({ host, port });
    return agent;
}

export function openApproved(target, policy, signal, tlsOptions = {}, profile = {}) {
    const ip = target.addresses[0]; // Every candidate passed the same policy; never resolve the hostname again.
    const hostname = hostHeader(target);
    // Profiles are trusted server code, never browser-supplied headers. Image defaults stay unchanged.
    const headers = { Host: hostname, Accept: profile.accept || 'image/png,image/jpeg,image/webp,image/gif',
        'Accept-Encoding': 'identity', 'User-Agent': 'TavernToolboxServer/remoteFetch',
        ...(profile.range ? { Range: profile.range } : {}) };
    const path = target.url.pathname + target.url.search;
    let request;
    const agents = [];
    const pendingConnections = new Set();
    if (policy.transport === 'http-proxy') {
        const proxy = new URL(policy.proxyUrl);
        const auth = proxy.username ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` : null;
        const proxyHost = proxy.hostname.startsWith('[') ? proxy.hostname.slice(1, -1) : proxy.hostname;
        const proxyAgent = plainAgent(proxyHost, Number(proxy.port || 80));
        agents.push(proxyAgent);
        if (target.url.protocol === 'http:') {
            request = http.request({ protocol: 'http:', hostname: proxy.hostname, port: proxy.port, method: 'GET',
                path: `http://${ip.includes(':') ? `[${ip}]` : ip}:${target.port}${path}`, headers: { ...headers, ...(auth ? { 'Proxy-Authorization': auth } : {}) },
                signal, agent: proxyAgent });
        } else {
            const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
            agents.push(agent);
            agent.createConnection = (options, callback) => {
                // Node defaults an omitted protocol from globalAgent even with an
                // explicit agent. ST's ProxyAgent guesses HTTPS from this enclosing
                // https.request stack, so the HTTP CONNECT must name its protocol.
                const tunnel = http.request({ protocol: 'http:', hostname: proxy.hostname, port: proxy.port, method: 'CONNECT',
                    path: `${ip.includes(':') ? `[${ip}]` : ip}:${target.port}`, signal, agent: proxyAgent,
                    headers: { Host: `${ip.includes(':') ? `[${ip}]` : ip}:${target.port}`,
                        ...(auth ? { 'Proxy-Authorization': auth } : {}) } });
                let settled = false, secure;
                const done = (error, value) => {
                    if (settled) return;
                    settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); pendingConnections.delete(abort);
                    if (error) { secure?.destroy(); tunnel.destroy(); }
                    callback(error, value);
                };
                // Node can defer ClientRequest's error while an async Agent is
                // still acquiring its socket. Always finish that callback on
                // timeout/abort, including the TLS phase after CONNECT 200.
                const abort = () => done(new Error('REMOTE_TIMEOUT'));
                pendingConnections.add(abort);
                const timer = setTimeout(abort, policy.connectTimeoutMs);
                signal.addEventListener('abort', abort, { once: true });
                tunnel.once('connect', (response, socket) => {
                    if (settled) { socket.destroy(); return; }
                    if (response.statusCode !== 200) { socket.destroy(); done(new NetworkFailure('TRANSPORT_UNAVAILABLE')); return; }
                    secure = tls.connect({ socket, ...tlsOptions, servername: target.host,
                        rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
                    secure.once('secureConnect', () => done(null, secure));
                    secure.once('error', error => done(error));
                    secure.once('close', () => done(new Error('TLS_CONNECTION_CLOSED')));
                });
                tunnel.once('error', error => done(error));
                if (signal.aborted) abort();
                tunnel.end();
            };
            request = https.request({ hostname: target.host, port: target.port, method: 'GET', path,
                headers, signal, agent, ...tlsOptions, protocol: 'https:', servername: target.host, rejectUnauthorized: true });
        }
    } else {
        const secure = target.url.protocol === 'https:';
        const agent = secure ? new https.Agent({ keepAlive: false, maxSockets: 1 }) : plainAgent(ip, target.port);
        agents.push(agent);
        if (secure) agent.createConnection = () => tls.connect({ host: ip, port: target.port,
            ...tlsOptions, servername: target.host, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
        const options = { protocol: target.url.protocol, hostname: target.host, port: target.port, method: 'GET', path, headers, signal, agent };
        request = secure ? https.request({ ...options, ...tlsOptions, protocol: 'https:', servername: target.host,
            rejectUnauthorized: true }) : http.request(options);
    }
    const destroyAgents = () => { for (const agent of agents) agent.destroy(); };
    return new Promise((resolve, reject) => {
        const expire = () => {
            for (const cancel of pendingConnections) cancel();
            request.destroy(new Error('REMOTE_TIMEOUT'));
        };
        const connectTimer = setTimeout(expire, policy.connectTimeoutMs);
        const timer = setTimeout(expire, policy.firstByteTimeoutMs);
        request.once('socket', socket => {
            if (!socket.connecting && !socket.secureConnecting) clearTimeout(connectTimer);
            else { socket.once('connect', () => { if (!socket.secureConnecting) clearTimeout(connectTimer); });
                socket.once('secureConnect', () => clearTimeout(connectTimer)); }
        });
        request.once('response', response => { clearTimeout(timer); clearTimeout(connectTimer); resolve({ response, close: () => { response.destroy(); request.destroy(); destroyAgents(); } }); });
        request.once('error', error => { clearTimeout(timer); clearTimeout(connectTimer); destroyAgents(); reject(error); });
        request.end();
    });
}
