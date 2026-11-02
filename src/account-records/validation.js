export class RecordFailure extends Error {
    constructor(code) { super(code); this.code = code; }
}
export const fail = code => { throw new RecordFailure(code); };
export const recordIdValid = id => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/.test(id);
export const integer = (n, min = 0) => Number.isSafeInteger(n) && n >= min;
export const exact = (v, keys) => v && typeof v === 'object' && !Array.isArray(v)
    && Object.keys(v).sort().join(',') === [...keys].sort().join(',');

// Only trusted composition may register consumers; production starts empty.
export function registerConsumers(consumers) {
    if (!Array.isArray(consumers) || consumers.length > 32) throw TypeError('Invalid record consumers');
    const registered = new Map();
    for (const c of consumers) {
        if (!c || !/^[a-z][a-z0-9-]{0,63}$/.test(c.id) || registered.has(c.id)
            || !integer(c.schemaVersion, 1) || typeof c.validate !== 'function'
            || !integer(c.maxBytes, 1) || c.maxBytes > 2 * 1024 * 1024
            || !integer(c.maxRecords, 1) || c.maxRecords > 100000
            || !integer(c.maxStorageBytes, 1) || c.maxStorageBytes > 512 * 1024 * 1024) throw TypeError('Invalid record consumer');
        registered.set(c.id, Object.freeze({ id: c.id, schemaVersion: c.schemaVersion, validate: c.validate,
            maxBytes: c.maxBytes, maxRecords: c.maxRecords, maxStorageBytes: c.maxStorageBytes }));
    }
    return registered;
}
