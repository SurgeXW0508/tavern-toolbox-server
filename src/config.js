import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalHost } from './network/destination.js';

export const DEFAULT_POLICY = Object.freeze({
    schemaVersion: 1,
    core: Object.freeze({ maxStatusResponseBytes: 256 * 1024, allowedOrigins: Object.freeze([]) }),
    network: Object.freeze({ enabled: false }),
});

export const NETWORK_DEFAULTS = Object.freeze({ maxBytes: 16 * 1024 * 1024, maxRedirects: 3,
    connectTimeoutMs: 5000, firstByteTimeoutMs: 10000, idleTimeoutMs: 10000,
    totalTimeoutMs: 30000, perUserConcurrency: 2, globalConcurrency: 4, requestsPerMinute: 30 });

function validateNetwork(value) {
    if (value === undefined) return DEFAULT_POLICY.network;
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !['enabled', 'transport', 'proxyUrl', 'destinationPolicy', 'allowlist',
            'allowHttp', ...Object.keys(NETWORK_DEFAULTS)].includes(key))) throw new Error('INVALID_NETWORK_CONFIG');
    if (value.enabled !== true && value.enabled !== false) throw new Error('INVALID_NETWORK_CONFIG');
    if (!value.enabled) return Object.freeze({ enabled: false });
    const transport = value.transport;
    if (!['direct', 'http-proxy'].includes(transport)) throw new Error('INVALID_NETWORK_CONFIG');
    if (transport === 'http-proxy') {
        try {
            const proxy = new URL(value.proxyUrl);
            if (proxy.protocol !== 'http:' || !proxy.hostname || proxy.pathname !== '/' || proxy.search || proxy.hash
                || (proxy.port && (!Number.isInteger(Number(proxy.port)) || Number(proxy.port) < 1 || Number(proxy.port) > 65535)))
                throw new Error();
        } catch { throw new Error('INVALID_NETWORK_CONFIG'); }
    } else if (value.proxyUrl !== undefined) throw new Error('INVALID_NETWORK_CONFIG');
    if (!['allowlist-only', 'restricted-public'].includes(value.destinationPolicy)) throw new Error('INVALID_NETWORK_CONFIG');
    if (!Array.isArray(value.allowlist) || value.allowlist.length > 128) throw new Error('INVALID_NETWORK_CONFIG');
    const allowlist = value.allowlist.map(entry => {
        if (typeof entry !== 'string' || entry.length > 255) throw new Error('INVALID_NETWORK_CONFIG');
        const wildcard = entry.startsWith('*.');
        const host = canonicalHost(wildcard ? entry.slice(2) : entry);
        return wildcard ? `*.${host}` : host;
    });
    if (new Set(allowlist).size !== allowlist.length) throw new Error('INVALID_NETWORK_CONFIG');
    if (value.destinationPolicy === 'allowlist-only' && !allowlist.length) throw new Error('INVALID_NETWORK_CONFIG');
    if (value.allowHttp !== undefined && typeof value.allowHttp !== 'boolean') throw new Error('INVALID_NETWORK_CONFIG');
    const limits = {};
    for (const [key, fallback] of Object.entries(NETWORK_DEFAULTS)) {
        const supplied = value[key] ?? fallback;
        if (!Number.isSafeInteger(supplied) || supplied <= 0 || supplied > fallback) throw new Error('INVALID_NETWORK_CONFIG');
        limits[key] = supplied;
    }
    return Object.freeze({ enabled: true, transport, proxyUrl: value.proxyUrl,
        destinationPolicy: value.destinationPolicy, allowlist: Object.freeze(allowlist),
        allowHttp: value.allowHttp === true, ...limits });
}

export function validatePolicy(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_CORE_CONFIG');
    if (Object.keys(value).some(key => !['schemaVersion', 'core', 'network'].includes(key)) || value.schemaVersion !== 1) throw new Error('INVALID_CORE_CONFIG');
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
    let network, networkError = null;
    try { network = validateNetwork(value.network); }
    catch { network = DEFAULT_POLICY.network; networkError = 'INVALID_NETWORK_CONFIG'; }
    return Object.freeze({ schemaVersion: 1, core: Object.freeze({ maxStatusResponseBytes, allowedOrigins: Object.freeze([...allowedOrigins]) }),
        network, networkError });
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
