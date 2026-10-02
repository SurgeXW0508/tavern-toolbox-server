import { NetworkFailure } from './destination.js';
import { mutationGate, setPrivateHeaders } from '../security.js';

const fail = code => { throw new NetworkFailure(code); };
const statuses = { INVALID_REQUEST: 400, UNSUPPORTED_RANGE: 400, PROTOCOL_INCOMPATIBLE: 409,
    CSRF_REJECTED: 403, FORBIDDEN: 403, TARGET_NOT_ALLOWED: 403, DNS_UNSAFE: 403,
    REDIRECT_REJECTED: 403, AUDIO_ACCESS_EXPIRED: 410, REMOTE_RESOURCE_TOO_LARGE: 413,
    UNSUPPORTED_MEDIA_TYPE: 415, REMOTE_SIZE_UNKNOWN: 422, INVALID_REMOTE_RESPONSE: 502,
    DNS_UNRESOLVED: 502, TOO_MANY_REDIRECTS: 502, REMOTE_UNAVAILABLE: 502, REMOTE_TIMEOUT: 504,
    RATE_LIMITED: 429, RESOURCE_BUSY: 429, CAPABILITY_UNAVAILABLE: 503, TRANSPORT_UNAVAILABLE: 503 };

async function jsonBody(req) {
    if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) fail('INVALID_REQUEST');
    let body = req.body;
    if (body === undefined) {
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 4096) fail('INVALID_REQUEST'); chunks.push(chunk); }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('INVALID_REQUEST'); }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body) || Buffer.byteLength(JSON.stringify(body)) > 4096) fail('INVALID_REQUEST');
    return body;
}

export function attachAudioRoutes(router, { audio, registry, config, send, failure, networkFailureDetails, logger, now }) {
    const route = operation => async (req, res) => {
        const { requestId, context, start } = res.locals.ttbRequest;
        let code = 'OK';
        const controller = new AbortController();
        const disconnected = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', disconnected);
        try {
            if (operation !== 'stream' && req.get('X-TTB-Protocol') !== '1.0') fail('PROTOCOL_INCOMPATIBLE');
            if (['create', 'release'].includes(operation) && !mutationGate(req, config.policy.core.allowedOrigins)) fail('CSRF_REJECTED');
            if (operation === 'stream') {
                // Native media GET carries session cookies, not custom protocol/CSRF headers.
                const site = req.headers['sec-fetch-site'], origin = req.headers.origin;
                if (site && !['same-origin', 'none'].includes(site)
                    || origin && !config.policy.core.allowedOrigins.includes(origin)) fail('FORBIDDEN');
            }
            const capability = (await registry.snapshot(context)).capabilities.find(item => item.id === 'network.remoteAudio');
            if (capability?.moduleId !== 'network-audio' || capability.operations.find(op => op.id === operation)?.available !== true) fail('CAPABILITY_UNAVAILABLE');
            let result;
            if (operation === 'create') {
                const body = await jsonBody(req);
                if (Object.keys(body).sort().join(',') !== 'profile,url' || body.profile !== 'audio'
                    || typeof body.url !== 'string' || body.url.length > 2048) fail('INVALID_REQUEST');
                result = await audio.create(body.url, context.contextId, controller.signal);
            } else if (operation === 'release') {
                const body = await jsonBody(req);
                if (Object.keys(body).join(',') !== 'accessId' || typeof body.accessId !== 'string' || body.accessId.length > 64) fail('INVALID_REQUEST');
                result = audio.release(body.accessId, context.contextId);
            } else if (operation === 'inspect') result = audio.inspect(req.params.accessId, context.contextId);
            else {
                setPrivateHeaders(res);
                res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
                res.setHeader('Referrer-Policy', 'no-referrer');
                await audio.stream(req.params.accessId, context.contextId, req.headers.range, res, controller.signal);
                return;
            }
            if (!res.destroyed && !controller.signal.aborted) send(res, 200, result, requestId, true, 4096);
        } catch (error) {
            code = error instanceof NetworkFailure ? error.code : 'INTERNAL_ERROR';
            if (!res.destroyed && !res.headersSent) {
                for (const name of ['Content-Length', 'Content-Range', 'Accept-Ranges']) res.removeHeader(name);
                send(res, statuses[code] || 500, { ...failure(code, '远程音频暂不可用'),
                    details: networkFailureDetails(error) }, requestId, true, 4096);
            } else if (!res.writableEnded) res.destroy();
        } finally {
            res.off('close', disconnected);
            // Never log request URLs, access IDs, user context, headers or upstream exceptions.
            logger.info?.({ service: 'tavern-toolbox-server', time: new Date().toISOString(), severity: 'info',
                requestId, moduleId: 'network-audio', operation, durationMs: now() - start, code, outcome: 'notApplicable' });
        }
    };
    router.post('/v1/network/audio/access', route('create'));
    router.get('/v1/network/audio/access/:accessId', route('inspect'));
    router.post('/v1/network/audio/release', route('release'));
    router.get('/v1/network/audio/stream/:accessId', route('stream'));
}
