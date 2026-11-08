export class RecordFailure extends Error {
    constructor(code, details = {}) {
        super(code);
        this.code = code;
        this.details = details && typeof details === 'object' ? details : {};
    }
}
export const fail = (code, details = {}) => { throw new RecordFailure(code, details); };
export const recordIdValid = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(id);
export const integer = (n, min = 0) => Number.isSafeInteger(n) && n >= min;
export const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).sort().join(',') === [...keys].sort().join(',');

export const MIN_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Only trusted composition may register consumers; production starts empty.
export function registerConsumers(consumers) {
    if (!Array.isArray(consumers) || consumers.length > 32) throw TypeError('Invalid record consumers');
    const registered = new Map();
    for (const c of consumers) {
        const deletable = c?.deletable === undefined ? true : c.deletable;
        const maxTombstones = c?.maxTombstones === undefined ? (deletable ? c?.maxRecords : 0) : c.maxTombstones;
        const tombstoneRetentionMs = c?.tombstoneRetentionMs === undefined ? DEFAULT_TOMBSTONE_RETENTION_MS : c.tombstoneRetentionMs;
        const transition = c?.transition === undefined ? null : c.transition;
        const projectRead = c?.projectRead === undefined ? null : c.projectRead;
        if (!c || typeof c.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(c.id) || registered.has(c.id)
            || !integer(c.schemaVersion, 1) || typeof c.validate !== 'function'
            || (transition !== null && typeof transition !== 'function')
            || (projectRead !== null && typeof projectRead !== 'function')
            || typeof deletable !== 'boolean'
            || !integer(c.maxBytes, 1) || c.maxBytes > 2 * 1024 * 1024
            || !integer(c.maxRecords, 1) || c.maxRecords > 100000
            || !integer(maxTombstones, deletable ? 1 : 0) || maxTombstones > 100000
            || (!deletable && maxTombstones !== 0)
            || !integer(tombstoneRetentionMs, MIN_TOMBSTONE_RETENTION_MS)
            || !integer(c.maxStorageBytes, 1) || c.maxStorageBytes > 512 * 1024 * 1024) throw TypeError('Invalid record consumer');
        registered.set(c.id, Object.freeze({
            id: c.id,
            schemaVersion: c.schemaVersion,
            validate: c.validate,
            transition,
            projectRead,
            maxBytes: c.maxBytes,
            maxRecords: c.maxRecords,
            maxStorageBytes: c.maxStorageBytes,
            deletable,
            maxTombstones,
            tombstoneRetentionMs,
        }));
    }
    return registered;
}
