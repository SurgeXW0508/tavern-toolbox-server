import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const DEFAULT_POLICY = Object.freeze({
    schemaVersion: 1,
    core: Object.freeze({ maxStatusResponseBytes: 256 * 1024, allowedOrigins: Object.freeze([]) }),
});

export function validatePolicy(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_CORE_CONFIG');
    if (Object.keys(value).some(key => !['schemaVersion', 'core'].includes(key)) || value.schemaVersion !== 1) throw new Error('INVALID_CORE_CONFIG');
    const core = value.core ?? {};
    if (!core || typeof core !== 'object' || Array.isArray(core)
        || Object.keys(core).some(key => !['maxStatusResponseBytes', 'allowedOrigins'].includes(key))) throw new Error('INVALID_CORE_CONFIG');
    const maxStatusResponseBytes = core.maxStatusResponseBytes ?? DEFAULT_POLICY.core.maxStatusResponseBytes;
    if (!Number.isInteger(maxStatusResponseBytes) || maxStatusResponseBytes < 4096 || maxStatusResponseBytes > 256 * 1024) throw new Error('INVALID_CORE_CONFIG');
    const allowedOrigins = core.allowedOrigins ?? [];
    if (!Array.isArray(allowedOrigins) || allowedOrigins.length > 8 || allowedOrigins.some(origin => {
        try {
            const url = new URL(origin);
            return !['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password;
        } catch { return true; }
    }) || new Set(allowedOrigins).size !== allowedOrigins.length) throw new Error('INVALID_CORE_CONFIG');
    return Object.freeze({ schemaVersion: 1, core: Object.freeze({ maxStatusResponseBytes, allowedOrigins: Object.freeze([...allowedOrigins]) }) });
}

export async function loadPolicy({ dataRoot = globalThis.DATA_ROOT, configPath = process.env.TAVERN_TOOLBOX_SERVER_CONFIG, read = readFile } = {}) {
    // Deployment policy belongs to ST data, never to the plugin's source directory.
    // SillyTavern commonly exposes its default data root as ./data, so normalize the trusted host root.
    if (configPath && !path.isAbsolute(configPath)) {
        return { policy: DEFAULT_POLICY, source: 'invalid', error: 'INVALID_CORE_CONFIG' };
    }
    const target = configPath || (typeof dataRoot === 'string' && dataRoot.trim()
        ? path.resolve(dataRoot, 'tavern-toolbox-server.config.json') : null);
    if (!target) return { policy: DEFAULT_POLICY, source: 'defaults', error: null };
    try {
        const raw = await read(target, 'utf8');
        const policy = validatePolicy(JSON.parse(raw));
        return { policy, source: 'administrator', error: null };
    } catch (error) {
        if (error?.code === 'ENOENT' && !configPath) return { policy: DEFAULT_POLICY, source: 'defaults', error: null };
        return { policy: DEFAULT_POLICY, source: 'invalid', error: 'INVALID_CORE_CONFIG' };
    }
}

export function policyRevision(config) {
    if (config.error) return 'invalid';
    return createHash('sha256').update(JSON.stringify(config.policy)).digest('hex').slice(0, 16);
}
