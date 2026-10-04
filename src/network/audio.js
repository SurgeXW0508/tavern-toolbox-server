import { randomBytes } from 'node:crypto';
import { AUDIO_DEFAULTS } from '../config.js';
import { NetworkFailure, parseTarget, approveDestination } from './destination.js';
import { AUDIO_ACCEPT, AUDIO_MIME, singleRange, audioResponse } from './audio-profile.js';
import { openRelay, transferRelay, waitFor } from './relay.js';

const fail = code => { throw new NetworkFailure(code); };
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{32}$/.test(id);

export function createAudio(config, { resolver, open, clock = () => Date.now() } = {}) {
    const limits = config.policy.audio || AUDIO_DEFAULTS;
    const state = config.policy.audioError || config.policy.networkError ? 'unavailable'
        : !config.policy.network.enabled ? 'disabled'
            : !config.policy.core.allowedOrigins.length ? 'unavailable' : 'ready';
    const tickets = new Map(), users = new Map(), active = new Set();
    let concurrent = 0, creating = 0, transportFailed = false, stopped = false;
    const ready = () => { if (stopped || state !== 'ready') fail('CAPABILITY_UNAVAILABLE'); };
    const sweep = () => {
        const moment = clock();
        for (const [id, ticket] of tickets) if (ticket.expiresAt <= moment) tickets.delete(id);
        for (const [id, user] of users) if (!user.concurrent && !user.creating && user.lastUsed < moment - 60000) users.delete(id);
    };
    const userFor = id => {
        sweep();
        const user = users.get(id) || { times: [], accesses: [], concurrent: 0, creating: 0 };
        user.lastUsed = clock();
        users.set(id, user);
        return user;
    };
    function rate(user, field, maximum) {
        user[field] = user[field].filter(time => time > clock() - 60000);
        if (user[field].length >= maximum) fail('RATE_LIMITED');
        user[field].push(clock());
    }
    function ticketFor(id, userId) {
        const ticket = validId(id) ? tickets.get(id) : null;
        if (!ticket || ticket.userId !== userId || ticket.expiresAt <= clock()) fail('AUDIO_ACCESS_EXPIRED');
        return ticket;
    }
    function detail(error) {
        return error?.code === 'TARGET_NOT_ALLOWED' && /^[a-z0-9.-]{1,253}$/.test(error.details?.hostname || '')
            ? { hostname: error.details.hostname } : {};
    }
    async function create(url, userId, signal) {
        ready();
        const policy = { ...config.policy.network, ...limits };
        const target = parseTarget(url, policy);
        if (/\.(?:m3u8|mpd)$/i.test(target.url.pathname)) fail('UNSUPPORTED_MEDIA_TYPE');
        const user = userFor(userId);
        rate(user, 'accesses', limits.accessPerMinute);
        const count = [...tickets.values()].filter(ticket => ticket.userId === userId).length;
        if (count + user.creating >= limits.perUserAccess || tickets.size + creating >= limits.globalAccess) fail('RESOURCE_BUSY');
        user.creating++; creating++;
        try {
            try { await waitFor(approveDestination(url, policy, undefined, resolver), signal, limits.connectTimeoutMs); }
            catch (error) { if (error instanceof NetworkFailure) throw error; fail('DNS_UNRESOLVED'); }
            ready();
            // A concurrent allowlist removal must also veto access creation.
            parseTarget(url, config.policy.network);
            const accessId = randomBytes(24).toString('base64url'), expiresAt = clock() + limits.accessTtlMs;
            tickets.set(accessId, { userId, url, profile: 'audio', expiresAt, code: null, details: {} });
            return { accessId, expiresAt, profile: 'audio' };
        } finally { user.creating--; creating--; }
    }
    // One Audio transport/budget for both temporary accesses and durable
    // Sources. Durable callers resolve a private URL from their user store;
    // this entry point is never exposed as an arbitrary URL HTTP endpoint.
    async function relay(url, userId, requestRange, downstream, clientSignal, ticket = null, id = null, maximum = limits.maxResourceBytes) {
        ready();
        const user = userFor(userId);
        let connection, reserved = false;
        const controller = new AbortController();
        const abort = () => controller.abort();
        clientSignal.addEventListener('abort', abort, { once: true });
        if (clientSignal.aborted) abort();
        const running = { id, controller }; active.add(running);
        try {
            const range = singleRange(requestRange);
            rate(user, 'times', limits.requestsPerMinute);
            if (user.concurrent >= limits.perUserConcurrency || concurrent >= limits.globalConcurrency) fail('RESOURCE_BUSY');
            user.concurrent++; concurrent++; reserved = true;
            const policy = { ...config.policy.network, ...limits };
            connection = await openRelay(url, policy, { accept: AUDIO_ACCEPT, range }, controller.signal, { resolver, open });
            transportFailed = false;
            const result = audioResponse(connection.response, range, Math.min(limits.maxResourceBytes, maximum));
            if (ticket) { ticket.code = null; ticket.details = {}; }
            downstream.statusCode = result.status;
            for (const [key, value] of Object.entries(result.headers)) downstream.setHeader(key, value);
            if (result.status === 416) { downstream.end(); return; }
            await transferRelay(connection.response, downstream, controller.signal, { ...limits, length: result.length });
        } catch (error) {
            const code = error instanceof NetworkFailure ? error.code : 'REMOTE_UNAVAILABLE';
            if (code === 'TRANSPORT_UNAVAILABLE') transportFailed = true;
            if (ticket && code !== 'CLIENT_ABORTED') { ticket.code = code; ticket.details = detail(error); }
            throw new NetworkFailure(code, detail(error));
        } finally {
            connection?.close(); clientSignal.removeEventListener('abort', abort); active.delete(running);
            if (reserved) { user.concurrent--; concurrent--; }
        }
    }
    return { create, relay,
        // Trusted Source localization only: same transport, approval, MIME,
        // timeout, rate and stream budget. No arbitrary download HTTP API.
        download(url, userId, downstream, signal, maximum) {
            return relay(url, userId, undefined, downstream, signal, null, null, maximum);
        },
        stream(id, userId, requestRange, downstream, clientSignal) {
            ready();
            const ticket = ticketFor(id, userId);
            return relay(ticket.url, userId, requestRange, downstream, clientSignal, ticket, id);
        },
        inspect(id, userId) { const ticket = ticketFor(id, userId); return { expiresAt: ticket.expiresAt,
            state: ticket.code ? 'failed' : 'ready', code: ticket.code, details: ticket.details }; },
        release(id, userId) {
            // Idempotent release reveals neither another user's access nor its existence.
            const ticket = validId(id) ? tickets.get(id) : null;
            if (ticket?.userId === userId) {
                tickets.delete(id);
                for (const running of active) if (running.id === id) running.controller.abort();
            }
            return { released: true };
        },
        definition: { id: 'network-audio', version: '0.1.0', dependsOn: ['core'],
            capabilities: [{ id: 'network.remoteAudio', contract: { major: 1, minMinor: 0, maxMinor: 0 },
                operations: ['create', 'inspect', 'release', 'stream'].map(id => ({ id, available: state === 'ready' })),
                limits, constraints: { profiles: ['audio'], mimeTypes: AUDIO_MIME, finiteFilesOnly: true,
                    singleRangeOnly: true, accessScope: 'current-user', transport: config.policy.network.transport || 'none' } }],
            health: () => ({ state: transportFailed ? 'degraded' : state,
                reasonCode: config.policy.audioError || config.policy.networkError
                    || (transportFailed ? 'TRANSPORT_UNAVAILABLE' : state === 'unavailable' ? 'ORIGIN_POLICY_MISSING' : null) }),
            shutdown() { stopped = true; for (const running of active) running.controller.abort(); tickets.clear(); users.clear(); },
        },
    };
}
