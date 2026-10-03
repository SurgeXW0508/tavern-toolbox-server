import { mutationGate, setPrivateHeaders } from '../security.js';
import { NetworkFailure } from '../network/destination.js';
import { AudioSourceFailure } from './store.js';

const fail = code => { throw new AudioSourceFailure(code); };
const statuses = { INVALID_REQUEST: 400, UNSUPPORTED_RANGE: 400, PROTOCOL_INCOMPATIBLE: 409, CONTEXT_CHANGED: 409,
    CSRF_REJECTED: 403, FORBIDDEN: 403, AUDIO_SOURCE_NOT_FOUND: 404, AUDIO_SOURCES_FULL: 409,
    TARGET_NOT_ALLOWED: 403, DNS_UNSAFE: 403, REDIRECT_REJECTED: 403, REMOTE_RESOURCE_TOO_LARGE: 413,
    UNSUPPORTED_MEDIA_TYPE: 415, REMOTE_SIZE_UNKNOWN: 422, INVALID_REMOTE_RESPONSE: 502, DNS_UNRESOLVED: 502,
    TOO_MANY_REDIRECTS: 502, REMOTE_UNAVAILABLE: 502, REMOTE_TIMEOUT: 504, RESOURCE_BUSY: 429, RATE_LIMITED: 429,
    CAPABILITY_UNAVAILABLE: 503, TRANSPORT_UNAVAILABLE: 503 };

async function body(req) {
    if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) fail('INVALID_REQUEST');
    let value = req.body;
    if (value === undefined) {
        const chunks = []; let bytes = 0;
        for await (const chunk of req) { bytes += chunk.length; if (bytes > 4096) fail('INVALID_REQUEST'); chunks.push(chunk); }
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('INVALID_REQUEST'); }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 4096)
        fail('INVALID_REQUEST');
    return value;
}

export function attachAudioSourceRoutes(router, { sources, registry, config, send, failure, networkFailureDetails, logger, now }) {
    const route = operation => async (req, res) => {
        const { requestId, context, start } = res.locals.ttbRequest;
        const controller = new AbortController(); let code = 'OK';
        const disconnected = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', disconnected);
        try {
            if (operation === 'stream') {
                const site = req.headers['sec-fetch-site'], origin = req.headers.origin;
                if (site && !['same-origin', 'none'].includes(site)
                    || origin && !config.policy.core.allowedOrigins.includes(origin)) fail('FORBIDDEN');
            } else {
                if (req.get('X-TTB-Protocol') !== '1.0') fail('PROTOCOL_INCOMPATIBLE');
                if (req.get('X-TTB-Context') !== context.contextId) fail('CONTEXT_CHANGED');
            }
            if (['create', 'delete'].includes(operation) && !mutationGate(req, config.policy.core.allowedOrigins)) fail('CSRF_REJECTED');
            const capability = (await registry.snapshot(context)).capabilities.find(item => item.id === 'audio.sources');
            if (capability?.moduleId !== 'audio-sources' || capability.operations.find(op => op.id === operation)?.available !== true)
                fail(capability?.reasonCode || 'AUDIO_SOURCE_UNAVAILABLE');
            let result;
            if (operation === 'create') {
                const value = await body(req);
                if (Object.keys(value).join(',') !== 'url' || typeof value.url !== 'string') fail('INVALID_REQUEST');
                result = await sources.create(context, value.url);
            } else if (operation === 'delete') {
                if (Object.keys(await body(req)).length) fail('INVALID_REQUEST');
                result = await sources.remove(context, req.params.sourceId);
            } else if (operation === 'list') {
                if (Object.keys(req.query).some(key => key !== 'cursor') || req.query.cursor !== undefined && typeof req.query.cursor !== 'string')
                    fail('INVALID_REQUEST');
                result = await sources.list(context, req.query.cursor ?? null);
            } else if (operation === 'read') result = await sources.read(context, req.params.sourceId);
            else {
                setPrivateHeaders(res);
                res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
                res.setHeader('Referrer-Policy', 'no-referrer');
                await sources.stream(context, req.params.sourceId, req.headers.range, res, controller.signal);
                return;
            }
            if (!res.destroyed && !controller.signal.aborted) send(res, 200, result, requestId, true, 65536);
        } catch (error) {
            code = error instanceof AudioSourceFailure || error instanceof NetworkFailure ? error.code : 'AUDIO_SOURCE_STORE_UNAVAILABLE';
            if (!res.destroyed && !res.headersSent) {
                for (const name of ['Content-Length', 'Content-Range', 'Accept-Ranges']) res.removeHeader(name);
                send(res, statuses[code] || 503, { ...failure(code, '音频来源暂不可用'), details: networkFailureDetails(error) }, requestId, true, 4096);
            } else if (!res.writableEnded) res.destroy();
        } finally {
            res.off('close', disconnected);
            // No URL/source ID, filesystem path, identity hash, or exceptions.
            logger.info?.({ service: 'tavern-toolbox-server', time: new Date().toISOString(), severity: 'info', requestId,
                moduleId: 'audio-sources', operation, durationMs: now() - start, code, outcome: 'notApplicable' });
        }
    };
    router.post('/v1/audio/sources', route('create'));
    router.get('/v1/audio/sources', route('list'));
    router.get('/v1/audio/sources/:sourceId', route('read'));
    router.post('/v1/audio/sources/:sourceId/delete', route('delete'));
    router.get('/v1/audio/sources/:sourceId/stream', route('stream'));
}
