import { mutationGate, setPrivateHeaders } from '../security.js';
import { NetworkFailure } from '../network/destination.js';
import { AudioSourceFailure } from './store.js';
import { AudioAssetFailure, validAssetId } from '../audio-assets/store.js';

const fail = code => { throw new AudioSourceFailure(code); };
const statuses = { INVALID_REQUEST: 400, UNSUPPORTED_RANGE: 400, PROTOCOL_INCOMPATIBLE: 409, CONTEXT_CHANGED: 409,
    CSRF_REJECTED: 403, FORBIDDEN: 403, AUDIO_SOURCE_NOT_FOUND: 404, AUDIO_SOURCES_FULL: 409,
    TARGET_NOT_ALLOWED: 403, DNS_UNSAFE: 403, REDIRECT_REJECTED: 403, REMOTE_RESOURCE_TOO_LARGE: 413,
    UNSUPPORTED_MEDIA_TYPE: 415, REMOTE_SIZE_UNKNOWN: 422, INVALID_REMOTE_RESPONSE: 502, DNS_UNRESOLVED: 502,
    TOO_MANY_REDIRECTS: 502, REMOTE_UNAVAILABLE: 502, REMOTE_TIMEOUT: 504, RESOURCE_BUSY: 429, RATE_LIMITED: 429,
    CAPABILITY_UNAVAILABLE: 503, TRANSPORT_UNAVAILABLE: 503 };
Object.assign(statuses, { AUDIO_SOURCE_CONFLICT: 409, AUDIO_JOB_NOT_FOUND: 404, AUDIO_ASSET_NOT_FOUND: 404,
    AUDIO_ASSET_REFERENCED: 409, AUDIO_ASSET_UNHEALTHY: 422, AUDIO_ASSET_INVALID_CONTENT: 415, AUDIO_QUOTA_EXCEEDED: 413 });
const fields = (value, keys) => Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const revision = value => Number.isSafeInteger(value) && value >= 0;

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
    const route = (operation, asset = false) => async (req, res) => {
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
            if (!['list', 'read', 'stream', 'job'].includes(operation) && !mutationGate(req, config.policy.core.allowedOrigins)) fail('CSRF_REJECTED');
            const capability = (await registry.snapshot(context)).capabilities.find(item => item.id === (asset ? 'audio.assets' : 'audio.sources'));
            if (capability?.moduleId !== (asset ? 'audio-assets' : 'audio-sources') || capability.operations.find(op => op.id === operation)?.available !== true)
                fail(capability?.reasonCode || 'AUDIO_SOURCE_UNAVAILABLE');
            let result;
            if (asset) {
                if (operation === 'list') {
                    if (Object.keys(req.query).some(key => key !== 'cursor') || req.query.cursor !== undefined && typeof req.query.cursor !== 'string') fail('INVALID_REQUEST');
                    result = await sources.assets.list(context, req.query.cursor ?? null);
                } else if (operation === 'read') result = await sources.assets.read(context, req.params.assetId);
                else if (operation === 'stream') {
                    setPrivateHeaders(res); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin'); res.setHeader('Referrer-Policy', 'no-referrer');
                    await sources.assets.stream(context, req.params.assetId, req.headers.range, res, controller.signal); return;
                } else {
                    const value = await body(req);
                    if (operation === 'cleanup') {
                        if (!fields(value, ['assetIds']) || !Array.isArray(value.assetIds) || !value.assetIds.length || value.assetIds.length > 50
                            || !value.assetIds.every(validAssetId) || new Set(value.assetIds).size !== value.assetIds.length) fail('INVALID_REQUEST');
                        result = await sources.assets.cleanup(context, value.assetIds);
                    } else {
                        if (!fields(value, [])) fail('INVALID_REQUEST');
                        result = operation === 'check' ? await sources.assets.check(context, req.params.assetId, controller.signal)
                            : await sources.assets.remove(context, req.params.assetId);
                    }
                }
            } else if (['create', 'lookup'].includes(operation)) {
                const value = await body(req);
                if (Object.keys(value).join(',') !== 'url' || typeof value.url !== 'string') fail('INVALID_REQUEST');
                result = await sources[operation](context, value.url);
            } else if (operation === 'restore') {
                if (!fields(await body(req), [])) fail('INVALID_REQUEST');
                result = await sources.restore(context, req.params.sourceId);
            } else if (operation === 'delete') {
                const value = await body(req);
                if (!(fields(value, []) || fields(value, ['revision']) && revision(value.revision))) fail('INVALID_REQUEST');
                result = await sources.remove(context, req.params.sourceId, value.revision);
            } else if (operation === 'list') {
                if (Object.keys(req.query).some(key => key !== 'cursor') || req.query.cursor !== undefined && typeof req.query.cursor !== 'string')
                    fail('INVALID_REQUEST');
                result = await sources.list(context, req.query.cursor ?? null);
            } else if (operation === 'read') result = await sources.read(context, req.params.sourceId);
            else if (operation === 'job') result = sources.job(context, req.params.jobId);
            else if (operation === 'cancel') { if (Object.keys(await body(req)).length) fail('INVALID_REQUEST'); result = sources.cancel(context, req.params.jobId); }
            else if (['localize', 'repair', 'releaseLocal', 'backend'].includes(operation)) {
                const value = await body(req), keys = operation === 'backend' ? ['revision', 'backend'] : ['revision'];
                if (!fields(value, keys) || !revision(value.revision) || operation === 'backend' && !['remote', 'local'].includes(value.backend)) fail('INVALID_REQUEST');
                result = ['localize', 'repair'].includes(operation) ? await sources.localize(context, req.params.sourceId, value.revision, operation === 'repair', controller.signal)
                    : await sources.backend(context, req.params.sourceId, value.revision, operation === 'releaseLocal' ? 'remote' : value.backend, operation === 'releaseLocal');
            }
            else {
                setPrivateHeaders(res);
                res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
                res.setHeader('Referrer-Policy', 'no-referrer');
                await sources.stream(context, req.params.sourceId, req.headers.range, res, controller.signal);
                return;
            }
            if (!res.destroyed && !controller.signal.aborted) send(res, 200, result, requestId, true, 65536);
        } catch (error) {
            code = error instanceof AudioSourceFailure || error instanceof NetworkFailure || error instanceof AudioAssetFailure ? error.code : 'AUDIO_SOURCE_STORE_UNAVAILABLE';
            if (!res.destroyed && !res.headersSent) {
                for (const name of ['Content-Length', 'Content-Range', 'Accept-Ranges']) res.removeHeader(name);
                send(res, statuses[code] || 503, { ...failure(code, '音频来源暂不可用'), details: networkFailureDetails(error) }, requestId, true, 4096);
            } else if (!res.writableEnded) res.destroy();
        } finally {
            res.off('close', disconnected);
            // No URL/source ID, filesystem path, identity hash, or exceptions.
            logger.info?.({ service: 'tavern-toolbox-server', time: new Date().toISOString(), severity: 'info', requestId,
                moduleId: asset ? 'audio-assets' : 'audio-sources', operation, durationMs: now() - start, code, outcome: 'notApplicable' });
        }
    };
    router.post('/v1/audio/sources', route('create'));
    router.get('/v1/audio/sources', route('list'));
    router.post('/v1/audio/sources/lookup', route('lookup'));
    router.get('/v1/audio/jobs/:jobId', route('job'));
    router.post('/v1/audio/jobs/:jobId/cancel', route('cancel'));
    router.get('/v1/audio/sources/:sourceId', route('read'));
    router.post('/v1/audio/sources/:sourceId/delete', route('delete'));
    router.get('/v1/audio/sources/:sourceId/stream', route('stream'));
    for (const operation of ['localize', 'repair', 'releaseLocal', 'backend', 'restore']) router.post('/v1/audio/sources/:sourceId/' + operation, route(operation));
    router.get('/v1/audio/assets', route('list', true));
    router.post('/v1/audio/assets/cleanup', route('cleanup', true));
    router.get('/v1/audio/assets/:assetId', route('read', true));
    router.get('/v1/audio/assets/:assetId/stream', route('stream', true));
    router.post('/v1/audio/assets/:assetId/check', route('check', true));
    router.post('/v1/audio/assets/:assetId/delete', route('delete', true));
}
