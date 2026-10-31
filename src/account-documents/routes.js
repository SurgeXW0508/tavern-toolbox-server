import { mutationGate } from '../security.js';
import { DocumentFailure } from './validation.js';

export function attachAccountDocumentRoutes(router, { documents, registry, config, send, failure }) {
    const fail = code => { throw new DocumentFailure(code); };
    const route = operation => async (req, res) => {
        const { context, requestId } = res.locals.ttbRequest;
        try {
            if (req.get('X-TTB-Protocol') !== '1.0') fail('PROTOCOL_INCOMPATIBLE');
            if (req.get('X-TTB-Context') !== context.contextId) fail('CONTEXT_CHANGED');
            const consumer = documents.consumers.get(req.params.id);
            if (!consumer) fail('DOCUMENT_NOT_REGISTERED');
            if (operation === 'commit' && !mutationGate(req, config.policy.core.allowedOrigins)) fail('CSRF_REJECTED');
            const capability = (await registry.snapshot(context)).capabilities.find(c => c.id === 'account.documents');
            if (capability?.state !== 'ready' || !capability.operations.find(o => o.id === operation)?.available)
                fail('DOCUMENT_STORE_UNAVAILABLE');
            let body = req.body;
            if (operation === 'commit') {
                if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) fail('INVALID_REQUEST');
                if (body === undefined) {
                    const chunks = []; let bytes = 0;
                    for await (const chunk of req) {
                        bytes += chunk.length;
                        if (bytes > consumer.maxBytes + 4096) fail('DOCUMENT_TOO_LARGE');
                        chunks.push(chunk);
                    }
                    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('INVALID_REQUEST'); }
                }
                if (Buffer.byteLength(JSON.stringify(body) || '') > consumer.maxBytes + 4096) fail('DOCUMENT_TOO_LARGE');
            } else if (Object.keys(req.query).join(',') !== 'schemaVersion' || req.query.schemaVersion !== String(consumer.schemaVersion)) {
                fail('DOCUMENT_SCHEMA_INCOMPATIBLE');
            }
            const result = operation === 'read'
                ? await documents.read(context, consumer.id, consumer.schemaVersion)
                : await documents.commit(context, consumer.id, body);
            return send(res, 200, { ...result, contextId: context.contextId }, requestId, true, consumer.maxBytes + 4096, true);
        } catch (error) {
            const code = error instanceof DocumentFailure ? error.code : 'DOCUMENT_STORE_UNAVAILABLE';
            const status = { INVALID_REQUEST: 400, DOCUMENT_INVALID: 422, DOCUMENT_TOO_LARGE: 413,
                DOCUMENT_NOT_REGISTERED: 404, REVISION_CONFLICT: 409, DOCUMENT_SCHEMA_INCOMPATIBLE: 409,
                CONTEXT_CHANGED: 409, PROTOCOL_INCOMPATIBLE: 409, CSRF_REJECTED: 403 }[code] || 503;
            return send(res, status, failure(code, '账户设置操作未完成；请同步核对，未自动重试'), requestId, true, 4096, true);
        }
    };
    router.get('/v1/account/documents/:id', route('read'));
    router.post('/v1/account/documents/:id/commit', route('commit'));
}
