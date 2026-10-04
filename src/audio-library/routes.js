import { mutationGate } from '../security.js';
import { AudioLibraryFailure } from './store.js';
import { AudioAssetFailure } from '../audio-assets/store.js';
const fail = (code) => {
    throw new AudioLibraryFailure(code);
};
async function body(req) {
    if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) fail('INVALID_REQUEST');
    let value = req.body;
    if (value === undefined) {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
            size += chunk.length;
            if (size > 4096) fail('INVALID_REQUEST');
            chunks.push(chunk);
        }
        try {
            value = JSON.parse(Buffer.concat(chunks));
        } catch {
            fail('INVALID_REQUEST');
        }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.byteLength(JSON.stringify(value)) > 4096)
        fail('INVALID_REQUEST');
    return value;
}
export function attachAudioLibraryRoutes(router, { library, registry, config, send, failure, logger, now }) {
    const route = (operation) => async (req, res) => {
        const { context, requestId, start } = res.locals.ttbRequest;
        let code = 'OK';
        try {
            if (req.get('X-TTB-Protocol') !== '1.0') fail('PROTOCOL_INCOMPATIBLE');
            if (req.get('X-TTB-Context') !== context.contextId) fail('CONTEXT_CHANGED');
            const mutation = ['update', 'observe', 'category'].includes(operation);
            if (mutation && !mutationGate(req, config.policy.core.allowedOrigins)) fail('CSRF_REJECTED');
            const cap = (await registry.snapshot(context)).capabilities.find((item) => item.id === 'audio.library');
            if (
                cap?.moduleId !== 'audio-library' ||
                cap.operations.find((item) => item.id === operation)?.available !== true
            )
                fail(cap?.reasonCode || 'AUDIO_LIBRARY_UNAVAILABLE');
            let result;
            if (operation === 'list') result = await library.list(context, req.query);
            else if (operation === 'read') result = await library.read(context, req.params.assetId);
            else if (operation === 'categories') result = await library.categories(context);
            else {
                const value = await body(req);
                if (operation === 'observe') {
                    if (Object.keys(value).join(',') !== 'title') fail('INVALID_REQUEST');
                    result = await library.observe(context, req.params.assetId, value.title);
                } else
                    result =
                        operation === 'category'
                            ? await library.category(context, value)
                            : await library.update(context, req.params.assetId, value);
            }
            send(res, 200, result, requestId, true, 131072);
        } catch (error) {
            code =
                error instanceof AudioLibraryFailure || error instanceof AudioAssetFailure
                    ? error.code
                    : 'AUDIO_LIBRARY_UNAVAILABLE';
            const status =
                {
                    INVALID_REQUEST: 400,
                    CSRF_REJECTED: 403,
                    PROTOCOL_INCOMPATIBLE: 409,
                    CONTEXT_CHANGED: 409,
                    AUDIO_LIBRARY_CONFLICT: 409,
                    AUDIO_CATEGORY_EXISTS: 409,
                    AUDIO_CATEGORIES_FULL: 409,
                    AUDIO_CATEGORY_NOT_FOUND: 404,
                    AUDIO_ASSET_NOT_FOUND: 404,
                }[code] || 503;
            send(
                res,
                status,
                failure(
                    code,
                    code === 'AUDIO_LIBRARY_CONFLICT'
                        ? '音乐信息已在其他设备修改，请刷新后重试。'
                        : '本地音乐库暂不可用',
                ),
                requestId,
                true,
                4096,
            );
        } finally {
            logger.info?.({
                service: 'tavern-toolbox-server',
                time: new Date().toISOString(),
                severity: 'info',
                requestId,
                moduleId: 'audio-library',
                operation,
                durationMs: now() - start,
                code,
                outcome: 'notApplicable',
            });
        }
    };
    router.get('/v1/audio/library', route('list'));
    router.get('/v1/audio/library/categories', route('categories'));
    router.post('/v1/audio/library/categories', route('category'));
    router.get('/v1/audio/library/:assetId', route('read'));
    router.post('/v1/audio/library/:assetId/update', route('update'));
    router.post('/v1/audio/library/:assetId/observe', route('observe'));
}
