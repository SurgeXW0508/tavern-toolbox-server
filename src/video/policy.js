import path from 'node:path';
export const VIDEO_LIMITS = Object.freeze({ maxBytes: 8 * 1024 ** 3, maxVideos: 5000,
    pageSize: 24, maxPageSize: 48, directoryEntries: 1000, directoryDepth: 32,
    discoveryPerUser: 2, discoveryGlobal: 8, discoveryTtlMs: 300000,
    operationsPerUser: 8, operationsGlobal: 32, discoveryTasksPerUser: 2, discoveryTasksGlobal: 8,
    streamsPerUser: 4, streamsGlobal: 8, idleTimeoutMs: 30000 });
export const VIDEO_DEFAULTS = Object.freeze({ roots: Object.freeze([]), maxBytes: VIDEO_LIMITS.maxBytes });
export function validateVideo(value) {
    if (value === undefined) return VIDEO_DEFAULTS;
    const invalid = () => { throw new Error('INVALID_VIDEO_CONFIG'); };
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !['roots', 'maxBytes'].includes(key))) invalid();
    const maxBytes = value.maxBytes ?? VIDEO_LIMITS.maxBytes;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 ** 3) invalid();
    if (!Array.isArray(value.roots) || value.roots.length > 16) invalid();
    const roots = value.roots.map(root => {
        if (!root || typeof root !== 'object' || Array.isArray(root)
            || Object.keys(root).some(key => !['key', 'label', 'path', 'users'].includes(key))
            || typeof root.key !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(root.key)
            || typeof root.label !== 'string' || !root.label.trim() || root.label.length > 120 || /[\x00-\x1f\x7f]/.test(root.label)
            || typeof root.path !== 'string' || !path.isAbsolute(root.path) || root.path.length > 4096 || /[\x00-\x1f\x7f]/.test(root.path)
            || path.resolve(root.path) === path.parse(root.path).root
            || !Array.isArray(root.users) || root.users.length > 128
            || root.users.some(user => typeof user !== 'string' || !user.trim() || user.length > 128 || /[\x00-\x1f\x7f]/.test(user))
            || new Set(root.users).size !== root.users.length) invalid();
        return Object.freeze({ key: root.key, label: root.label.trim(), path: path.resolve(root.path), users: Object.freeze([...root.users]) });
    });
    if (new Set(roots.map(root => root.key)).size !== roots.length) invalid();
    return Object.freeze({ roots: Object.freeze(roots), maxBytes });
}
