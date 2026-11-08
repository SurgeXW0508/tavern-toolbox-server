import { mutationGate } from '../security.js';
import { fail, RecordFailure } from './validation.js';

export function attachAccountRecordRoutes(router, { records, config, send, failure }) {
    const route = operation => async (req, res) => {
        const { context, requestId } = res.locals.ttbRequest;
        const mutation = operation === 'commit' || operation === 'delete';
        try {
            if (req.get('X-TTB-Protocol') !== '1.0') fail('PROTOCOL_INCOMPATIBLE');
            if (req.get('X-TTB-Context') !== context.contextId) fail('CONTEXT_CHANGED');
            const c = records.consumer(req.params.consumer);
            if (mutation && !mutationGate(req, config.policy.core.allowedOrigins)) fail('CSRF_REJECTED');
            let result;
            if (mutation) {
                if (Object.keys(req.query).length || !/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) fail('INVALID_REQUEST');
                const budget = operation === 'delete' ? 4096 : c.maxBytes + 4096;
                let body = req.body;
                if (body === undefined) {
                    const chunks = []; let bytes = 0;
                    for await (const chunk of req) {
                        bytes += chunk.length;
                        if (bytes > budget) fail('RECORD_TOO_LARGE');
                        chunks.push(chunk);
                    }
                    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('INVALID_REQUEST'); }
                }
                if (Buffer.byteLength(JSON.stringify(body) || '', 'utf8') > budget) fail('RECORD_TOO_LARGE');
                result = await records[operation](context, c.id, req.params.id, body);
            } else if (operation === 'read') {
                if (Object.keys(req.query).join(',') !== 'schemaVersion' || req.query.schemaVersion !== String(c.schemaVersion)) fail('RECORD_SCHEMA_INCOMPATIBLE');
                result = await records.read(context, c.id, req.params.id, c.schemaVersion);
            } else {
                if (Object.keys(req.query).some(k => !['limit', 'cursor'].includes(k))
                    || req.query.limit !== undefined && (typeof req.query.limit !== 'string' || !/^[1-9][0-9]{0,2}$/.test(req.query.limit))
                    || req.query.cursor !== undefined && typeof req.query.cursor !== 'string') fail('INVALID_REQUEST');
                result = await records.list(context, c.id, { limit: req.query.limit === undefined ? 50 : Number(req.query.limit), cursor: req.query.cursor ?? null });
            }
            return send(res, 200, { ...result, contextId: context.contextId }, requestId, true,
                operation === 'list' ? 65536 : c.maxBytes + 4096, true);
        } catch (error) {
            const code = error instanceof RecordFailure ? error.code : 'RECORD_STORE_UNAVAILABLE';
            const status = { INVALID_REQUEST: 400, RECORD_ID_INVALID: 400, RECORD_CURSOR_INVALID: 400,
                RECORD_INVALID: 422, RECORD_TOO_LARGE: 413, RECORD_COLLECTION_FULL: 409,
                RECORD_CONSUMER_NOT_REGISTERED: 404, RECORD_NOT_FOUND: 404,
                REVISION_CONFLICT: 409, RECORD_DELETED: 409, RECORD_DELETE_FORBIDDEN: 409,
                RECORD_TRANSITION_INVALID: 409, RECORD_SCHEMA_INCOMPATIBLE: 409,
                LOREBOOK_MIGRATION_REQUIRED: 409, LOREBOOK_LOCK_NOT_STALE: 409,
                LOREBOOK_TAKEOVER_CONFIRMATION_REQUIRED: 409, LEGACY_LOCK_WRITE_FORBIDDEN: 409,
                CONTEXT_CHANGED: 409, PROTOCOL_INCOMPATIBLE: 409, CSRF_REJECTED: 403 }[code] || 503;
            const errPayload = failure(code, '账户记录操作未完成；请重新读取核对，未自动重试', mutation && status >= 500 ? 'unknown' : 'notApplicable');
            if (error instanceof RecordFailure && error.details && typeof error.details === 'object' && Object.keys(error.details).length > 0) {
                errPayload.details = error.details;
            }
            return send(res, status, errPayload, requestId, true, 4096, true);
        }
    };
    router.get('/v1/account/records/:consumer', route('list'));
    router.get('/v1/account/records/:consumer/:id', route('read'));
    router.post('/v1/account/records/:consumer/:id/commit', route('commit'));
    router.post('/v1/account/records/:consumer/:id/delete', route('delete'));
}
