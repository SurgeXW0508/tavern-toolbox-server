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

export function openApproved(target, policy, signal, tlsOptions = {}) {
    const ip = target.addresses[0]; // Every candidate passed the same policy; never resolve the hostname again.
    const hostname = hostHeader(target);
    const headers = { Host: hostname, Accept: 'image/png,image/jpeg,image/webp,image/gif',
        'Accept-Encoding': 'identity', 'User-Agent': 'TavernToolboxServer/remoteFetch' };
    const path = target.url.pathname + target.url.search;
    let request;
    const agents = [];
    if (policy.transport === 'http-proxy') {
        const proxy = new URL(policy.proxyUrl);
        const auth = proxy.username ? `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` : null;
        const proxyHost = proxy.hostname.startsWith('[') ? proxy.hostname.slice(1, -1) : proxy.hostname;
        const proxyAgent = plainAgent(proxyHost, Number(proxy.port || 80));
        agents.push(proxyAgent);
        if (target.url.protocol === 'http:') {
            request = http.request({ hostname: proxy.hostname, port: proxy.port, method: 'GET',
                path: `http://${ip.includes(':') ? `[${ip}]` : ip}:${target.port}${path}`, headers: { ...headers, ...(auth ? { 'Proxy-Authorization': auth } : {}) },
                signal, agent: proxyAgent });
        } else {
            const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
            agents.push(agent);
            agent.createConnection = (options, callback) => {
                const tunnel = http.request({ hostname: proxy.hostname, port: proxy.port, method: 'CONNECT',
                    path: `${ip.includes(':') ? `[${ip}]` : ip}:${target.port}`, signal, agent: proxyAgent,
                    headers: { Host: `${ip.includes(':') ? `[${ip}]` : ip}:${target.port}`,
                        ...(auth ? { 'Proxy-Authorization': auth } : {}) } });
                let settled = false;
                const done = (error, value) => { if (!settled) { settled = true; callback(error, value); } };
                const timer = setTimeout(() => tunnel.destroy(new Error('REMOTE_TIMEOUT')), policy.connectTimeoutMs);
                tunnel.once('connect', (response, socket) => {
                    clearTimeout(timer);
                    if (response.statusCode !== 200) { socket.destroy(); done(new NetworkFailure('TRANSPORT_UNAVAILABLE')); return; }
                    const secure = tls.connect({ socket, ...tlsOptions, servername: target.host,
                        rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
                    secure.once('secureConnect', () => done(null, secure));
                    secure.once('error', error => done(error));
                    signal.addEventListener('abort', () => secure.destroy(), { once: true });
                });
                tunnel.once('error', error => { clearTimeout(timer); done(error); });
                tunnel.end();
            };
            request = https.request({ hostname: target.host, port: target.port, method: 'GET', path,
                headers, signal, agent, ...tlsOptions, servername: target.host, rejectUnauthorized: true });
        }
    } else {
        const secure = target.url.protocol === 'https:';
        const agent = secure ? new https.Agent({ keepAlive: false, maxSockets: 1 }) : plainAgent(ip, target.port);
        agents.push(agent);
        if (secure) agent.createConnection = () => tls.connect({ host: ip, port: target.port,
            ...tlsOptions, servername: target.host, rejectUnauthorized: true, ALPNProtocols: ['http/1.1'] });
        const options = { hostname: target.host, port: target.port, method: 'GET', path, headers, signal, agent };
        request = secure ? https.request({ ...options, ...tlsOptions, servername: target.host,
            rejectUnauthorized: true }) : http.request(options);
    }
    const destroyAgents = () => { for (const agent of agents) agent.destroy(); };
    return new Promise((resolve, reject) => {
        const connectTimer = setTimeout(() => request.destroy(new Error('REMOTE_TIMEOUT')), policy.connectTimeoutMs);
        const timer = setTimeout(() => request.destroy(new Error('REMOTE_TIMEOUT')), policy.firstByteTimeoutMs);
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
