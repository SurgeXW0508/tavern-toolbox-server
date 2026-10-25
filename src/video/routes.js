import { mutationGate, setPrivateHeaders } from '../security.js';
import { VideoFailure, fail, object, integer } from './validation.js';
import { FileTransferFailure } from '../transport/local-file-stream.js';

async function body(req, signal) {
    if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) fail('INVALID_REQUEST');
    let value = req.body;
    if (value === undefined) {
        let size = 0; const chunks = [];
        for await (const chunk of req) { if (signal.aborted) fail('CLIENT_ABORTED'); size += chunk.length; if (size > 8192) fail('INVALID_REQUEST'); chunks.push(chunk); }
        try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('INVALID_REQUEST'); }
    }
    if (Buffer.byteLength(JSON.stringify(value) || '') > 8192) fail('INVALID_REQUEST');
    return value;
}
const statusFor = code => ({ INVALID_REQUEST: 400, PROTOCOL_INCOMPATIBLE: 409, CONTEXT_CHANGED: 409, CSRF_REJECTED: 403, FORBIDDEN: 403,
    VIDEO_REFERENCED: 409, VIDEO_REFERENCES_INCOMPLETE: 503, VIDEO_METADATA_CONFLICT: 409, VIDEO_PROGRESS_CONFLICT: 409, VIDEO_POSTER_UNAVAILABLE: 422, VIDEO_SOURCE_REGISTERED: 409, VIDEO_NOT_FOUND: 404, VIDEO_SOURCE_CHANGED: 409, VIDEO_OPERATION_CONFLICT: 409, VIDEO_CANDIDATE_EXPIRED: 409,
    VIDEO_SOURCE_UNAVAILABLE: 422, VIDEO_FORMAT_UNSUPPORTED: 415, VIDEO_DIRECTORY_LIMIT: 422,
    UNSUPPORTED_RANGE: 400, VIDEO_CATALOG_FULL: 409, RESOURCE_BUSY: 429 }[code] || 503);

export function attachVideoRoutes(router, { video, registry, config, send, failure, logger, now }) {
    const route = (operation, capability, post = false) => async (req, res) => {
        const { context, requestId, start } = res.locals.ttbRequest;
        const controller = new AbortController(); let code = 'OK';
        const disconnect = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', disconnect);
        try {
            const streaming = operation === 'stream';
            if (streaming) {
                const site = req.headers['sec-fetch-site'], origin = req.headers.origin;
                if (site && !['same-origin', 'none'].includes(site) || origin && !config.policy.core.allowedOrigins.includes(origin)) fail('FORBIDDEN');
                object(req.query, ['context', 'version'], ['context', 'version']);
                if (req.query.context !== context.contextId) fail('CONTEXT_CHANGED');
                if (typeof req.query.version !== 'string' || !/^[1-9]\d{0,9}$/.test(req.query.version)) fail('INVALID_REQUEST');
            } else {
                if (req.get('X-TTB-Protocol') !== '1.0') fail('PROTOCOL_INCOMPATIBLE');
                if (req.get('X-TTB-Context') !== context.contextId) fail('CONTEXT_CHANGED');
                if (post && !mutationGate(req, config.policy.core.allowedOrigins)) fail('CSRF_REJECTED');
            }
            const cap = (await registry.snapshot(context)).capabilities.find(row => row.id === capability);
            if (cap?.moduleId !== 'video' || !cap.operations.find(row => row.id === (operation === 'readProgress' ? 'read' : operation === 'writeProgress' ? 'write' : operation))?.available) fail('VIDEO_UNAVAILABLE');
            let result;
            if (streaming) {
                setPrivateHeaders(res); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin'); res.setHeader('Referrer-Policy', 'no-referrer');
                await video.stream(context, req.params.id, Number(req.query.version), req.headers.range, req.method === 'HEAD', res, controller.signal); return;
            }
            const input = post ? await body(req, controller.signal) : null;
            if (operation !== 'list' && !streaming && Object.keys(req.query).length) fail('INVALID_REQUEST');
            if (operation === 'roots') result = video.roots(context);
            else if (operation === 'browse') result = await video.browse(context, input, controller.signal);
            else if (operation === 'cancel') { object(input, ['sessionId'], ['sessionId']); result = video.cancel(context, input.sessionId); }
            else if (operation === 'register') result = await video.register(context, input, controller.signal);
            else if (operation === 'operation') result = await video.operation(context, req.params.id, controller.signal);
            else if (operation === 'references') result = await video.references(context, req.params.id, controller.signal);
            else if (['update', 'unregister', 'source'].includes(operation)) result = await video[operation](context, req.params.id, input, controller.signal);
            else if (operation === 'readProgress' || operation === 'writeProgress') result = await video.progress(context, req.params.id, input, controller.signal);
            else if (operation === 'read') result = await video.read(context, req.params.id, controller.signal);
            else if (operation === 'presentation') { object(input, ['assetIds'], ['assetIds']); result = await video.presentation(context, input.assetIds, controller.signal); }
            else if (operation === 'resolve') { object(input, []); result = await video.resolve(context, req.params.id, controller.signal); }
            else {
                object(req.query, ['search', 'offset', 'limit']);
                for (const key of ['offset', 'limit']) if (req.query[key] !== undefined && (typeof req.query[key] !== 'string' || !/^\d{1,4}$/.test(req.query[key]))) fail('INVALID_REQUEST');
                result = await video.list(context, { search: req.query.search ?? '', offset: req.query.offset === undefined ? 0 : integer(Number(req.query.offset), 0, 5000), limit: req.query.limit === undefined ? 24 : integer(Number(req.query.limit), 1, 48) }, controller.signal);
            }
            if (!res.destroyed && !controller.signal.aborted) send(res, 200, result, requestId, true, 65536);
        } catch (error) {
            code = error instanceof FileTransferFailure && error.code === 'FILE_CHANGED' ? 'VIDEO_SOURCE_CHANGED' : error instanceof VideoFailure || error instanceof FileTransferFailure ? error.code : 'VIDEO_UNAVAILABLE';
            if (res.headersSent) { if (!res.writableEnded) res.destroy(); }
            else if (!res.destroyed && !controller.signal.aborted) send(res, statusFor(code), failure(code, '视频操作未完成'), requestId, true, 4096);
        } finally {
            res.off('close', disconnect);
            logger.info?.({ service: 'tavern-toolbox-server', time: new Date().toISOString(), severity: 'info', requestId,
                moduleId: 'video', operation, code, durationMs: now() - start, outcome: 'notApplicable' });
        }
    };
    router.get('/v1/video/operations/:id', route('operation', 'video.catalog'));
    router.get('/v1/video/items/:id/references', route('references', 'video.catalog'));
    for (const operation of ['update', 'unregister', 'source']) router.post('/v1/video/items/:id/' + operation, route(operation, operation === 'source' ? 'video.sources' : 'video.catalog', true));
    router.get('/v1/video/items/:id/progress', route('readProgress', 'video.progress'));
    router.post('/v1/video/items/:id/progress', route('writeProgress', 'video.progress', true));
    router.get('/v1/video/roots', route('roots', 'video.sources'));
    router.post('/v1/video/source-browse', route('browse', 'video.sources', true));
    router.post('/v1/video/source-browse/cancel', route('cancel', 'video.sources', true));
    router.post('/v1/video/register', route('register', 'video.sources', true));
    router.get('/v1/video/items', route('list', 'video.catalog'));
    router.post('/v1/video/presentation', route('presentation', 'video.catalog', true));
    router.get('/v1/video/items/:id', route('read', 'video.catalog'));
    router.post('/v1/video/items/:id/playback', route('resolve', 'video.playback', true));
    // Express GET automatically serves HEAD; minimal host fixtures also support GET.
    router.get('/v1/video/items/:id/stream', route('stream', 'video.playback'));
}
