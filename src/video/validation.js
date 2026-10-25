export class VideoFailure extends Error { constructor(code) { super(code); this.code = code; } }
export const fail = code => { throw new VideoFailure(code); };
export function object(value, keys, required = []) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !keys.includes(key)) || required.some(key => !Object.hasOwn(value, key))) fail('INVALID_REQUEST');
    return value;
}
export function text(value, max = 120) {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) fail('INVALID_REQUEST');
    return value.trim();
}
export function integer(value, min = 1, max = Number.MAX_SAFE_INTEGER) {
    if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_REQUEST'); return value;
}
export function uuid(value) {
    if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) fail('INVALID_REQUEST'); return value;
}
export function aborted(signal) { if (signal?.aborted) fail('CLIENT_ABORTED'); }
