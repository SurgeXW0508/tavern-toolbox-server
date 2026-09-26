import { approveDestination, NetworkFailure } from './destination.js';
import { openApproved } from './transport.js';

const MIME = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const fail = code => { throw new NetworkFailure(code); };
const signatures = [
    ['image/jpeg', b => b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b.at(-2) === 0xff && b.at(-1) === 0xd9],
    ['image/png', b => b.length > 24 && b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && b.toString('ascii', 12, 16) === 'IHDR'],
    ['image/webp', b => b.length > 16 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP'
        && b.readUInt32LE(4) + 8 === b.length && ['VP8 ', 'VP8L', 'VP8X'].includes(b.toString('ascii', 12, 16))],
    ['image/gif', b => b.length > 14 && ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6)) && b.at(-1) === 0x3b],
];

function mediaType(body, declared) {
    const found = signatures.find(([, match]) => match(body))?.[0];
    if (!found) fail('VALIDATION_FAILED');
    const upstream = String(declared || '').split(';')[0].trim().toLowerCase();
    if (upstream && upstream !== found && upstream !== 'application/octet-stream') fail('UNSUPPORTED_MEDIA_TYPE');
    return found;
}

export function createNetwork(config, { resolver, open = openApproved, clock = () => Date.now() } = {}) {
    const policy = config.policy.network;
    const invalid = config.policy.networkError;
    const state = !policy.enabled ? invalid ? 'unavailable' : 'disabled' :
        !config.policy.core.allowedOrigins.length ? 'unavailable' : 'ready';
    let transportFailed = false;
    const active = new Set();
    const users = new Map();
    let concurrent = 0;

    const definition = { id: 'network', version: '0.1.0', dependsOn: ['core'],
        capabilities: [{ id: 'network.remoteFetch', contract: { major: 1, minMinor: 0, maxMinor: 0 },
            operations: [{ id: 'fetch', available: state === 'ready' }],
            limits: { maxBytes: policy.maxBytes || 16 * 1024 * 1024, maxRedirects: policy.maxRedirects || 3,
                connectTimeoutMs: policy.connectTimeoutMs || 5000, firstByteTimeoutMs: policy.firstByteTimeoutMs || 10000,
                idleTimeoutMs: policy.idleTimeoutMs || 10000, totalTimeoutMs: policy.totalTimeoutMs || 30000,
                perUserConcurrency: policy.perUserConcurrency || 2, globalConcurrency: policy.globalConcurrency || 4,
                requestsPerMinute: policy.requestsPerMinute || 30 },
            constraints: { profiles: ['image'], mimeTypes: MIME, https: true, http: Boolean(policy.allowHttp),
                ports: policy.allowHttp ? [80, 443] : [443], destinationPolicy: policy.destinationPolicy || 'allowlist-only',
                allowlistEntryCount: policy.allowlist?.length || 0, transport: policy.transport || 'none' } }],
        health: () => ({ state: transportFailed ? 'degraded' : state,
            reasonCode: invalid || (state === 'unavailable' ? 'ORIGIN_POLICY_MISSING' :
                transportFailed ? 'TRANSPORT_UNAVAILABLE' : null) }),
        shutdown: () => { for (const controller of active) controller.abort(); },
    };

    async function fetchImage(url, contextId, clientSignal) {
        if (state !== 'ready') fail('CAPABILITY_UNAVAILABLE');
        const moment = clock();
        const user = users.get(contextId) || { times: [], concurrent: 0 };
        user.times = user.times.filter(time => time > moment - 60000);
        users.set(contextId, user);
        if (user.times.length >= policy.requestsPerMinute) fail('RATE_LIMITED');
        if (concurrent >= policy.globalConcurrency || user.concurrent >= policy.perUserConcurrency) fail('RESOURCE_BUSY');
        user.times.push(moment);
        user.concurrent += 1;
        concurrent += 1;
        const controller = new AbortController();
        const abort = () => controller.abort();
        clientSignal?.addEventListener('abort', abort, { once: true });
        if (clientSignal?.aborted) abort();
        active.add(controller);
        const total = setTimeout(abort, policy.totalTimeoutMs);
        try {
            let current = url, previous, redirects = 0;
            const visited = new Set();
            for (;;) {
                if (controller.signal.aborted) fail('REMOTE_TIMEOUT');
                let target;
                try {
                    target = await Promise.race([approveDestination(current, policy, previous, resolver),
                        new Promise((_, reject) => controller.signal.addEventListener('abort',
                            () => reject(new NetworkFailure('REMOTE_TIMEOUT')), { once: true }))]);
                }
                catch (error) {
                    if (error instanceof NetworkFailure) throw error;
                    fail('DNS_UNRESOLVED');
                }
                if (visited.has(target.url.href)) fail('REDIRECT_REJECTED');
                visited.add(target.url.href);
                let connection;
                try {
                    connection = await open(target, policy, controller.signal);
                    transportFailed = false;
                } catch (error) {
                    if (controller.signal.aborted || error?.message === 'REMOTE_TIMEOUT') fail('REMOTE_TIMEOUT');
                    if (policy.transport === 'http-proxy') { transportFailed = true; fail('TRANSPORT_UNAVAILABLE'); }
                    fail('REMOTE_UNAVAILABLE');
                }
                const { response, close } = connection;
                try {
                    if (response.statusCode >= 300 && response.statusCode < 400) {
                        if (++redirects > policy.maxRedirects) fail('TOO_MANY_REDIRECTS');
                        const location = response.headers.location;
                        if (typeof location !== 'string') fail('REDIRECT_REJECTED');
                        previous = target.url;
                        try { current = new URL(location, previous).href; } catch { fail('REDIRECT_REJECTED'); }
                        // Strict raw checks on the redirect header, before WHATWG URL normalization.
                        if (/[\u0000-\u001f\u007f\\#]/.test(location)) fail('REDIRECT_REJECTED');
                        continue;
                    }
                    if (response.statusCode < 200 || response.statusCode >= 300) fail('REMOTE_UNAVAILABLE');
                    if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') fail('UNSUPPORTED_MEDIA_TYPE');
                    const length = response.headers['content-length'];
                    if (length && (!/^\d+$/.test(length) || Number(length) > policy.maxBytes)) fail('REMOTE_RESOURCE_TOO_LARGE');
                    const chunks = [];
                    let bytes = 0;
                    let idle = setTimeout(() => response.destroy(new Error('REMOTE_TIMEOUT')), policy.idleTimeoutMs);
                    try {
                        for await (const chunk of response) {
                            clearTimeout(idle);
                            bytes += chunk.length;
                            if (bytes > policy.maxBytes) fail('REMOTE_RESOURCE_TOO_LARGE');
                            chunks.push(chunk);
                            idle = setTimeout(() => response.destroy(new Error('REMOTE_TIMEOUT')), policy.idleTimeoutMs);
                        }
                    } catch (error) {
                        if (error instanceof NetworkFailure) throw error;
                        if (controller.signal.aborted || error?.message === 'REMOTE_TIMEOUT') fail('REMOTE_TIMEOUT');
                        fail('REMOTE_UNAVAILABLE');
                    } finally { clearTimeout(idle); }
                    const body = Buffer.concat(chunks, bytes);
                    if (!body.length) fail('VALIDATION_FAILED');
                    return { body, mime: mediaType(body, response.headers['content-type']), redirects };
                } finally { close(); }
            }
        } finally {
            clearTimeout(total);
            clientSignal?.removeEventListener('abort', abort);
            active.delete(controller);
            user.concurrent -= 1;
            concurrent -= 1;
            if (!user.concurrent && !user.times.length) users.delete(contextId);
        }
    }
    return { definition, fetchImage, shutdown: definition.shutdown };
}
