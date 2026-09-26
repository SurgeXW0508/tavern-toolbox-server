import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { loadPolicy, policyRevision } from './config.js';
import { CapabilityRegistry } from './registry.js';
import { userContext, mutationGate, setPrivateHeaders } from './security.js';
import { createNetwork } from './network/index.js';
import { NetworkFailure } from './network/destination.js';
import { createMedia, MediaFailure } from './media/index.js';

export const PRODUCT = 'tavern-toolbox-server';
export const SERVER_VERSION = '0.1.0';
const PROTOCOL = Object.freeze({ major: 1, minor: 0 });
const RANGES = Object.freeze([{ major: 1, minMinor: 0, maxMinor: 0 }]);
const MAX_MODULES = 64;

function meta(requestId, protocol = null) {
    return { requestId, serverTime: new Date().toISOString(), ...(protocol ? { protocol: PROTOCOL } : {}) };
}

function send(res, status, data, requestId, protocol, budget) {
    setPrivateHeaders(res);
    const payload = JSON.stringify({ ok: status < 400, ...(status < 400 ? { data } : { error: data }), meta: meta(requestId, protocol) });
    if (Buffer.byteLength(payload) > budget) {
        const fallback = JSON.stringify({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE', message: '状态快照超出服务器上限',
            details: {}, retryable: false, outcome: 'notApplicable' }, meta: meta(requestId, protocol) });
        return res.status(503).type('json').send(fallback);
    }
    return res.status(status).type('json').send(payload);
}

function failure(code, message, outcome = 'notApplicable') {
    return { code, message, details: {}, retryable: false, outcome };
}

export async function createCore({ policyOptions, registerModules, networkOptions, logger = console, now = () => Date.now() } = {}) {
    const config = await loadPolicy(policyOptions);
    const registry = new CapabilityRegistry();
    const bootId = randomUUID();
    const secret = randomBytes(32);
    registry.register({ id: 'core', version: SERVER_VERSION, dependsOn: [],
        capabilities: [{ id: 'core.status', contract: { major: 1, minMinor: 0, maxMinor: 0 },
            operations: [{ id: 'read', available: true }], limits: { maxStatusResponseBytes: config.policy.core.maxStatusResponseBytes }, constraints: {} }],
        health: () => config.error ? { state: 'degraded', reasonCode: config.error } : { state: 'ready', reasonCode: null },
    });
    const network = createNetwork(config, networkOptions);
    registry.register(network.definition);
    const media = createMedia(config, network);
    registry.register(media.definition);
    registerModules?.(registry); // Test fixture or a future trusted composition root; not callable over HTTP.
    await registry.initialize();
    let stopped = false;
    const policyRev = policyRevision(config);

    async function status(context) {
        const snapshot = await registry.snapshot(context);
        if (snapshot.modules.length > MAX_MODULES) throw new Error('STATUS_TOO_LARGE');
        const core = snapshot.modules.find(module => module.id === 'core');
        const statusRevision = createHash('sha256').update(JSON.stringify([snapshot.modules, snapshot.capabilities, policyRev])).digest('hex').slice(0, 16);
        return { product: PRODUCT, serverVersion: SERVER_VERSION, bootId, contextId: context.contextId,
            statusRevision, policyRevision: policyRev, observedAt: new Date().toISOString(), core,
            modules: snapshot.modules, capabilities: snapshot.capabilities,
            effectivePolicy: { source: config.source, maxStatusResponseBytes: config.policy.core.maxStatusResponseBytes,
                unsafeRequestsEnabled: config.policy.network.enabled === true && !config.policy.networkError
                    && config.policy.core.allowedOrigins.length > 0 } };
    }

    function attach(router) {
        router.use((req, res, next) => {
            const requestId = randomUUID();
            const context = userContext(req, secret);
            res.locals.ttbRequest = { requestId, context, start: now() };
            if (!context) return send(res, 403, failure('AUTH_REQUIRED', '当前 SillyTavern 用户身份不可用'), requestId, false, 4096);
            if (stopped) return send(res, 503, { ...failure('CAPABILITY_UNAVAILABLE', '插件正在退出'),
                details: { product: PRODUCT, discoveryVersion: 1, serverVersion: SERVER_VERSION } }, requestId, false, 4096);
            next();
        });

        const route = (protocol, handler) => async (req, res) => {
            const { requestId, context, start } = res.locals.ttbRequest;
            const budget = config.policy.core.maxStatusResponseBytes;
            try {
                if (protocol && req.get('X-TTB-Protocol') !== '1.0') {
                    const supplied = req.get('X-TTB-Protocol');
                    const code = supplied && /^\d+\.\d+$/.test(supplied) ? 'PROTOCOL_INCOMPATIBLE' : 'INVALID_REQUEST';
                    return send(res, code === 'INVALID_REQUEST' ? 400 : 409,
                        failure(code, code === 'INVALID_REQUEST' ? '缺少有效的协议版本' : '不支持请求的协议版本'), requestId, true, budget);
                }
                const data = await handler(context);
                return send(res, 200, data, requestId, protocol, budget);
            } catch {
                logger.error?.({ service: PRODUCT, time: new Date().toISOString(), severity: 'error',
                    requestId, moduleId: 'core', operation: protocol ? 'status' : 'discovery',
                    code: 'INTERNAL_ERROR', outcome: 'notApplicable' });
                return send(res, 500, failure('INTERNAL_ERROR', '状态读取失败'), requestId, protocol, budget);
            } finally {
                logger.info?.({ service: PRODUCT, time: new Date().toISOString(), severity: 'info',
                    requestId, moduleId: 'core', operation: protocol ? 'status' : 'discovery',
                    durationMs: now() - start, code: res.statusCode < 400 ? 'OK' : `HTTP_${res.statusCode}`,
                    outcome: 'notApplicable' });
            }
        };
        router.get('/status', route(false, async () => ({ product: PRODUCT, discoveryVersion: 1,
            serverVersion: SERVER_VERSION, protocols: RANGES, coreState: config.error ? 'degraded' : 'ready' })));
        router.get('/v1/status', route(true, status));
        router.post('/v1/network/fetch', async (req, res) => {
            const { requestId, context, start } = res.locals.ttbRequest;
            const controller = new AbortController();
            const disconnected = () => { if (!res.writableEnded) controller.abort(); };
            res.once('close', disconnected);
            let code = 'OK';
            try {
                if (req.get('X-TTB-Protocol') !== '1.0') throw new NetworkFailure('PROTOCOL_INCOMPATIBLE');
                if (!config.policy.core.allowedOrigins.includes(req.headers?.origin) || req.headers?.origin === 'null'
                    || (req.headers?.['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin'))
                    throw new NetworkFailure('FORBIDDEN');
                if (!mutationGate(req, config.policy.core.allowedOrigins)) throw new NetworkFailure('CSRF_REJECTED');
                const type = req.headers?.['content-type'] || '';
                if (!/^application\/json(?:\s*;|\s*$)/i.test(type)) throw new NetworkFailure('INVALID_REQUEST');
                let body = req.body;
                if (body === undefined) {
                    const chunks = []; let size = 0;
                    for await (const chunk of req) {
                        size += chunk.length;
                        if (size > 4096) throw new NetworkFailure('INVALID_REQUEST');
                        chunks.push(chunk);
                    }
                    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
                    catch { throw new NetworkFailure('INVALID_REQUEST'); }
                }
                if (!body || typeof body !== 'object' || Array.isArray(body)
                    || Object.keys(body).sort().join(',') !== 'profile,url' || body.profile !== 'image'
                    || typeof body.url !== 'string' || body.url.length > 2048) throw new NetworkFailure('INVALID_REQUEST');
                const capability = (await registry.snapshot(context)).capabilities.find(item => item.id === 'network.remoteFetch');
                if (capability?.moduleId !== 'network' || !['ready', 'degraded'].includes(capability.state)
                    || capability.operations.find(item => item.id === 'fetch')?.available !== true)
                    throw new NetworkFailure('CAPABILITY_UNAVAILABLE');
                const result = await network.fetchImage(body.url, context.contextId, controller.signal);
                if (controller.signal.aborted || res.destroyed) return;
                setPrivateHeaders(res);
                res.setHeader('Content-Type', result.mime);
                res.setHeader('Content-Length', result.body.length);
                res.setHeader('X-TTB-Request-Id', requestId);
                res.status(200).end(result.body);
            } catch (error) {
                code = error instanceof NetworkFailure ? error.code : 'INTERNAL_ERROR';
                if (!res.destroyed && !res.headersSent) {
                    const statusCode = { INVALID_REQUEST: 400, PROTOCOL_INCOMPATIBLE: 409, FORBIDDEN: 403,
                        CSRF_REJECTED: 403, CAPABILITY_UNAVAILABLE: 503, TRANSPORT_UNAVAILABLE: 503,
                        TARGET_NOT_ALLOWED: 403, DNS_UNRESOLVED: 502, DNS_UNSAFE: 403,
                        REDIRECT_REJECTED: 403, TOO_MANY_REDIRECTS: 502, REMOTE_UNAVAILABLE: 502,
                        REMOTE_TIMEOUT: 504, REMOTE_RESOURCE_TOO_LARGE: 413, UNSUPPORTED_MEDIA_TYPE: 415,
                        VALIDATION_FAILED: 422, RATE_LIMITED: 429, RESOURCE_BUSY: 429 }[code] || 500;
                    send(res, statusCode, failure(code, '远程图片获取失败'), requestId, true, 4096);
                }
            } finally {
                res.off('close', disconnected);
                logger.info?.({ service: PRODUCT, time: new Date().toISOString(), severity: 'info', requestId,
                    moduleId: 'network', operation: 'fetch', durationMs: now() - start, code, outcome: 'notApplicable' });
            }
        });
        const mediaRoute = (operation, { mutation = false, binary = false, upload = false } = {}) => async (req, res) => {
            const { requestId, context, start } = res.locals.ttbRequest;
            let code = 'OK';
            const controller = new AbortController();
            const disconnected = () => { if (!res.writableEnded) controller.abort(); };
            res.once('close', disconnected);
            try {
                if ((!binary || mutation) && req.get('X-TTB-Protocol') !== '1.0')
                    throw new MediaFailure('PROTOCOL_INCOMPATIBLE');
                if (mutation && !mutationGate(req, config.policy.core.allowedOrigins))
                    throw new MediaFailure('CSRF_REJECTED');
                let result;
                if (upload) {
                    const release = media.reserveImport();
                    try {
                        const type = String(req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
                        if (!['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/octet-stream'].includes(type)
                            || req.body !== undefined && !Buffer.isBuffer(req.body)) throw new MediaFailure('INVALID_REQUEST');
                        const limit = config.policy.media.maxBytes;
                        if (Number(req.headers['content-length']) > limit) throw new MediaFailure('MEDIA_TOO_LARGE');
                        let size = 0; const chunks = [];
                        const incoming = Buffer.isBuffer(req.body) ? [req.body] : req;
                        for await (const chunk of incoming) {
                            size += chunk.length;
                            if (size > limit) throw new MediaFailure('MEDIA_TOO_LARGE');
                            chunks.push(chunk);
                        }
                        result = await media.importBytes(context, Buffer.concat(chunks), type, true);
                    } finally { release(); }
                } else if (operation === 'remoteImport') {
                    if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers?.['content-type'] || ''))
                        throw new MediaFailure('INVALID_REQUEST');
                    let body = req.body;
                    if (body === undefined) {
                        let size = 0; const chunks = [];
                        for await (const chunk of req) {
                            size += chunk.length;
                            if (size > 4096) throw new MediaFailure('INVALID_REQUEST');
                            chunks.push(chunk);
                        }
                        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
                        catch { throw new MediaFailure('INVALID_REQUEST'); }
                    }
                    if (!body || typeof body !== 'object' || Array.isArray(body)
                        || Object.keys(body).join(',') !== 'url' || typeof body.url !== 'string'
                        || body.url.length > 2048) throw new MediaFailure('INVALID_REQUEST');
                    result = await media.remoteImport(context, body.url, controller.signal);
                } else if (operation === 'read') {
                    if (!['original', 'thumbnail'].includes(req.params.variant)) throw new MediaFailure('MEDIA_NOT_FOUND');
                    result = await media.read(context, req.params.id, req.params.variant === 'thumbnail');
                }
                else if (operation === 'metadata') result = await media.metadata(context, req.params.id);
                else if (operation === 'delete') result = await media.delete(context, req.params.id);
                else if (operation === 'rebuildThumbnail') result = await media.rebuild(context, req.params.id);
                else if (operation === 'cleanupTechnicalGarbage') result = await media.cleanup(context);
                else result = await media.storage(context);
                if (controller.signal.aborted || res.destroyed) return;
                if (binary) {
                    setPrivateHeaders(res); // revalidate authenticated identity for every request, including user switch.
                    res.setHeader('Content-Type', result.mime);
                    res.setHeader('Content-Length', result.bytes.length);
                    res.setHeader('X-TTB-Request-Id', requestId);
                    return res.status(200).end(result.bytes);
                }
                return send(res, 200, result, requestId, true, config.policy.core.maxStatusResponseBytes);
            } catch (error) {
                code = error instanceof MediaFailure || error instanceof NetworkFailure ? error.code : 'MEDIA_UNAVAILABLE';
                const statusCode = { INVALID_REQUEST: 400, PROTOCOL_INCOMPATIBLE: 409, CSRF_REJECTED: 403,
                    MEDIA_NOT_FOUND: 404, MEDIA_CORRUPT: 503, DERIVED_UNAVAILABLE: 503,
                    MEDIA_TOO_LARGE: 413, UNSUPPORTED_MEDIA_TYPE: 415, MIME_MISMATCH: 415,
                    ANIMATION_UNSUPPORTED: 415, INVALID_MEDIA: 422, MEDIA_COMPLEXITY_EXCEEDED: 422,
                    QUOTA_EXCEEDED: 507, RESOURCE_BUSY: 429, NETWORK_UNAVAILABLE: 503,
                    CAPABILITY_UNAVAILABLE: 503, TRANSPORT_UNAVAILABLE: 503, TARGET_NOT_ALLOWED: 403,
                    DNS_UNSAFE: 403, REMOTE_RESOURCE_TOO_LARGE: 413, VALIDATION_FAILED: 422 }[code] || 503;
                if (!res.destroyed && !res.headersSent)
                    return send(res, statusCode, failure(code, '媒体操作失败'), requestId, !binary, 4096);
            } finally {
                res.off('close', disconnected);
                logger.info?.({ service: PRODUCT, time: new Date().toISOString(), severity: 'info', requestId,
                    moduleId: 'media', operation, durationMs: now() - start, code, outcome: 'notApplicable' });
            }
        };
        router.post('/v1/media/import/local', mediaRoute('localImport', { mutation: true, upload: true }));
        router.post('/v1/media/import/remote', mediaRoute('remoteImport', { mutation: true }));
        router.get('/v1/media/storage', mediaRoute('storage'));
        router.get('/v1/media/assets/:id', mediaRoute('metadata'));
        router.delete('/v1/media/assets/:id', mediaRoute('delete', { mutation: true }));
        router.post('/v1/media/assets/:id/rebuild-thumbnail', mediaRoute('rebuildThumbnail', { mutation: true }));
        router.post('/v1/media/maintenance/cleanup', mediaRoute('cleanupTechnicalGarbage', { mutation: true }));
        router.get('/v1/media/assets/:id/:variant', mediaRoute('read', { binary: true }));
        router.use((req, res) => {
            const knownPath = req.path === '/status' || req.path === '/v1/status' || req.path === '/v1/network/fetch';
            const { requestId } = res.locals.ttbRequest;
            return send(res, knownPath ? 405 : 404,
                failure(knownPath ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND', knownPath ? '不支持该请求方法' : '接口不存在'), requestId, false, 4096);
        });
    }

    async function shutdown() {
        stopped = true;
        network.shutdown();
        let timer;
        try {
            await Promise.race([registry.shutdown(), new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
        } finally { clearTimeout(timer); }
    }

    return { attach, shutdown, status, registry, bootId,
        // For future privileged operations; the test fixture verifies fail-closed policy.
        allowMutation: req => Boolean(userContext(req, secret)) && mutationGate(req, config.policy.core.allowedOrigins),
    };
}
