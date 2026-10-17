import { mutationGate } from '../security.js';
import { WorldbookFailure, LIMITS } from './index.js';
import { fail, object, id, page, query } from './validation.js';
async function body(req) {
    if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) fail('WORLDBOOK_VALIDATION');
    let value = req.body;
    if (value === undefined) {
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
            size += chunk.length;
            if (size > LIMITS.maxBodyBytes) fail('WORLDBOOK_VALIDATION');
            chunks.push(chunk);
        }
        try {
            value = JSON.parse(Buffer.concat(chunks));
        } catch {
            fail('WORLDBOOK_VALIDATION');
        }
    }
    if (
        !value ||
        Array.isArray(value) ||
        typeof value !== 'object' ||
        Buffer.byteLength(JSON.stringify(value)) > LIMITS.maxBodyBytes
    )
        fail('WORLDBOOK_VALIDATION');
    return value;
}
export function attachWorldbookRoutes(router, { worldbook, registry, config, send, failure, logger, now }) {
    const route = (operation) => async (req, res) => {
        const { context, requestId, start } = res.locals.ttbRequest;
        let code = 'OK';
        try {
            if (req.get('X-TTB-Protocol') !== '1.0') fail('PROTOCOL_INCOMPATIBLE');
            if (req.get('X-TTB-Context') !== context.contextId) fail('CONTEXT_CHANGED');
            if (['runtime', 'command', 'media-command'].includes(operation) && !mutationGate(req, config.policy.core.allowedOrigins))
                fail('CSRF_REJECTED');
            const media = operation.startsWith('media-');
            const cap = (await registry.snapshot(context)).capabilities.find((row) => row.id === (media ? 'worldbook.media' : 'worldbook.core')),
                feature = cap?.operations.find((row) => row.id === (media ? operation.slice(6) : operation));
            if (cap?.moduleId !== (media ? 'worldbook-media' : 'worldbook') || feature?.available !== true)
                fail(feature?.reasonCode || cap?.reasonCode || 'WORLDBOOK_UNAVAILABLE');
            let result;
            if (operation === 'media-read') result = await worldbook.readMedia(context,await body(req));
            else if (operation === 'media-command') result = await worldbook.mediaCommand(context,await body(req));
            else if (operation === 'command') result = await worldbook.command(context, await body(req));
            else if (operation === 'features') result = await worldbook.read(context,'features',await body(req));
            else if (operation === 'runtime') result = await worldbook.runtime(context, await body(req));
            else {
                let input;
                if (operation === 'catalog') input = query(req.query);
                else if (operation === 'summary' || operation === 'sources') {
                    object(req.query, ['page']);
                    input = { page: page(req.query.page) };
                } else if (operation === 'detail') {
                    object(req.query, []);
                    input = { id: id(req.params.id) };
                } else {
                    object(req.query, ['cursor']);
                    let offset = 0,
                        stamp = null;
                    if (req.query.cursor) {
                        if (typeof req.query.cursor !== 'string' || !/^\d{1,16}:\d{1,7}$/.test(req.query.cursor))
                            fail('WORLDBOOK_VALIDATION');
                        [stamp, offset] = req.query.cursor.split(':').map(Number);
                        if (!Number.isSafeInteger(stamp) || offset > 60000) fail('WORLDBOOK_VALIDATION');
                    }
                    input = { id: id(req.params.id), offset, stamp };
                }
                result = await worldbook.read(context, operation, input);
            }
            if (!res.destroyed) send(res, 200, result, requestId, true, LIMITS.maxResponseBytes);
        } catch (error) {
            code = error instanceof WorldbookFailure ? error.code : 'WORLDBOOK_UNAVAILABLE';
            const status =
                code === 'WORLDBOOK_VALIDATION'
                    ? 400
                    : code === 'WORLDBOOK_NOT_FOUND'
                      ? 404
                      : ['CSRF_REJECTED', 'WORLDBOOK_BUILTIN'].includes(code)
                        ? 403
                        : code === 'RESOURCE_BUSY'
                          ? 429
                          : [
                                  'WORLDBOOK_CONFLICT',
                                  'WORLDBOOK_MEDIA_CONFLICT',
                                  'WORLDBOOK_DUPLICATE',
                                  'WORLDBOOK_SOURCE_COLLISION',
                                  'WORLDBOOK_TREE_CHANGED',
                                  'WORLDBOOK_IDEMPOTENCY_MISMATCH',
                                  'WORLDBOOK_COMMAND_EXPIRED',
                                  'WORLDBOOK_CLOCK_SKEW',
                                  'WORLDBOOK_RUNTIME_EXPIRED',
                                  'WORLDBOOK_RUNTIME_UNAVAILABLE',
                                  'WORLDBOOK_SESSION_EXPIRED',
                                  'PROTOCOL_INCOMPATIBLE',
                                  'CONTEXT_CHANGED',
                              ].includes(code)
                            ? 409
                            : code === 'WORLDBOOK_MEDIA_UNAVAILABLE' ? 422 : 503;
            if (!res.destroyed)
                send(
                    res,
                    status,
                    failure(
                        code,
                        code === 'WORLDBOOK_CONFLICT'
                            ? '服务器上的资料已经发生变化，请重新核对后保存。'
                            : '世界书资料操作未完成。',
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
                moduleId: 'worldbook',
                operation,
                durationMs: now() - start,
                code,
                outcome: 'notApplicable',
            });
        }
    };
    router.get('/v1/worldbook/summary', route('summary'));
    router.get('/v1/worldbook/catalog', route('catalog'));
    router.get('/v1/worldbook/sources', route('sources'));
    router.get('/v1/worldbook/columns/:id/tree', route('tree'));
    router.get('/v1/worldbook/materials/:id', route('detail'));
    router.post('/v1/worldbook/runtime', route('runtime'));
    router.post('/v1/worldbook/features', route('features'));
    router.post('/v1/worldbook/commands', route('command'));
    router.post('/v1/worldbook/media/read', route('media-read'));
    router.post('/v1/worldbook/media/commands', route('media-command'));
}
