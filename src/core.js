import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { loadPolicy, policyRevision } from './config.js';
import { CapabilityRegistry } from './registry.js';
import { userContext, mutationGate, setPrivateHeaders } from './security.js';

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

export async function createCore({ policyOptions, registerModules, logger = console, now = () => Date.now() } = {}) {
    const config = await loadPolicy(policyOptions);
    const registry = new CapabilityRegistry();
    const bootId = randomUUID();
    const secret = randomBytes(32);
    registry.register({ id: 'core', version: SERVER_VERSION, dependsOn: [],
        capabilities: [{ id: 'core.status', contract: { major: 1, minMinor: 0, maxMinor: 0 },
            operations: [{ id: 'read', available: true }], limits: { maxStatusResponseBytes: config.policy.core.maxStatusResponseBytes }, constraints: {} }],
        health: () => config.error ? { state: 'degraded', reasonCode: config.error } : { state: 'ready', reasonCode: null },
    });
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
                unsafeRequestsEnabled: false } };
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
        router.use((req, res) => {
            const knownPath = req.path === '/status' || req.path === '/v1/status';
            const { requestId } = res.locals.ttbRequest;
            return send(res, knownPath ? 405 : 404,
                failure(knownPath ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND', knownPath ? '不支持该请求方法' : '接口不存在'), requestId, false, 4096);
        });
    }

    async function shutdown() {
        stopped = true;
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
