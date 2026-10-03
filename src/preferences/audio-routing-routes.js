import { mutationGate } from '../security.js';
import { PreferenceFailure } from './audio-routing.js';

export function attachAudioRoutingPreferenceRoutes(router, { preferences, registry, config, send, failure, logger, now }) {
    const fail = code => { throw new PreferenceFailure(code); };
    const route = operation => async (req, res) => {
        const { context, requestId, start } = res.locals.ttbRequest;
        let code = 'OK';
        try {
            if (req.get('X-TTB-Protocol') !== '1.0') fail('PROTOCOL_INCOMPATIBLE');
            // Bind the operation to the discovery snapshot. A stale tab must
            // not apply a previous user's edits after a session/user change.
            if (req.get('X-TTB-Context') !== context.contextId) fail('CONTEXT_CHANGED');
            let hosts;
            if (operation !== 'read') {
                if (!mutationGate(req, config.policy.core.allowedOrigins)) fail('CSRF_REJECTED');
                if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] || '')) fail('INVALID_REQUEST');
                let body = req.body;
                if (body === undefined) {
                    const chunks = []; let bytes = 0;
                    for await (const chunk of req) { bytes += chunk.length; if (bytes > 65536) fail('INVALID_REQUEST'); chunks.push(chunk); }
                    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('INVALID_REQUEST'); }
                }
                if (!body || Array.isArray(body) || Object.keys(body).join(',') !== 'hosts'
                    || Buffer.byteLength(JSON.stringify(body)) > 65536) fail('INVALID_REQUEST');
                hosts = body.hosts;
            }
            const capability = (await registry.snapshot(context)).capabilities.find(item => item.id === 'preferences.audioRouting');
            if (capability?.state !== 'ready' || capability.operations.find(item => item.id === operation)?.available !== true)
                fail(capability?.reasonCode || 'PREFERENCE_UNAVAILABLE');
            const result = operation === 'read' ? await preferences.read(context) : await preferences.mutate(context, operation, hosts);
            return send(res, 200, result, requestId, true, 65536);
        } catch (error) {
            code = error instanceof PreferenceFailure ? error.code : 'PREFERENCE_STORE_UNAVAILABLE';
            const status = { INVALID_REQUEST: 400, INVALID_HOST: 422, CSRF_REJECTED: 403,
                PROTOCOL_INCOMPATIBLE: 409, CONTEXT_CHANGED: 409, ROUTING_HOSTS_FULL: 409 }[code] || 503;
            return send(res, status, failure(code, '音频来源同步失败'), requestId, true, 4096);
        } finally {
            logger.info?.({ service: 'tavern-toolbox-server', time: new Date().toISOString(), severity: 'info',
                requestId, moduleId: 'preferences', operation: `audioRouting.${operation}`,
                durationMs: now() - start, code, outcome: 'notApplicable' });
        }
    };
    router.get('/v1/preferences/audio-routing', route('read'));
    router.post('/v1/preferences/audio-routing/add', route('add'));
    router.post('/v1/preferences/audio-routing/remove', route('remove'));
}
