import { NetworkFailure } from './destination.js';

export const AUDIO_MIME = Object.freeze(['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg',
    'audio/webm', 'audio/wav', 'audio/wave', 'audio/x-wav']);
export const AUDIO_ACCEPT = AUDIO_MIME.join(',');
const fail = code => { throw new NetworkFailure(code); };
const number = value => /^\d+$/.test(value || '') && Number.isSafeInteger(Number(value)) ? Number(value) : null;

export function singleRange(value) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length > 128) fail('UNSUPPORTED_RANGE');
    const match = /^bytes=(\d*)-(\d*)$/.exec(value);
    if (!match || !(match[1] || match[2])) fail('UNSUPPORTED_RANGE');
    const start = match[1] ? number(match[1]) : null, end = match[2] ? number(match[2]) : null;
    if (match[1] && start === null || match[2] && end === null || start !== null && end !== null && end < start
        || start === null && !end) fail('UNSUPPORTED_RANGE');
    return value;
}

export function audioResponse(response, range, maxResourceBytes) {
    const headers = response.headers, status = response.statusCode;
    if (![200, 206, 416].includes(status)) fail('REMOTE_UNAVAILABLE');
    let total, length, contentRange;
    if (status === 200) {
        if (headers['content-range']) fail('INVALID_REMOTE_RESPONSE');
        total = length = number(headers['content-length']);
    } else if (status === 206) {
        const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers['content-range'] || '');
        if (!range || !match) fail('INVALID_REMOTE_RESPONSE');
        const [start, end, size] = match.slice(1).map(number);
        if ([start, end, size].some(n => n === null) || end < start || end >= size) fail('INVALID_REMOTE_RESPONSE');
        total = size; length = end - start + 1;
        if (number(headers['content-length']) !== length) fail('INVALID_REMOTE_RESPONSE');
        const request = /^bytes=(\d*)-(\d*)$/.exec(range);
        const expectedStart = request[1] ? Number(request[1]) : Math.max(0, total - Number(request[2]));
        const expectedEnd = request[1] && request[2] ? Math.min(Number(request[2]), total - 1) : total - 1;
        if (start !== expectedStart || end !== expectedEnd) fail('INVALID_REMOTE_RESPONSE');
        contentRange = headers['content-range'];
    } else {
        const match = /^bytes \*\/(\d+)$/.exec(headers['content-range'] || '');
        if (!range || !match) fail('INVALID_REMOTE_RESPONSE');
        total = number(match[1]); length = 0; contentRange = headers['content-range'];
    }
    // Unknown totals, including Content-Range */*, fail closed. Small ranges cannot hide huge files.
    if (total === null || total === undefined) fail('REMOTE_SIZE_UNKNOWN');
    if (total > maxResourceBytes) fail('REMOTE_RESOURCE_TOO_LARGE');
    if (status !== 416 && total < 1) fail('INVALID_REMOTE_RESPONSE');
    const mime = String(headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (status !== 416 && (!AUDIO_MIME.includes(mime)
        || headers['content-encoding'] && headers['content-encoding'] !== 'identity')) fail('UNSUPPORTED_MEDIA_TYPE');
    return { status, length, headers: { 'Content-Length': String(length),
        ...(status !== 416 ? { 'Content-Type': mime } : {}),
        ...(contentRange ? { 'Content-Range': contentRange } : {}),
        ...(['bytes', 'none'].includes(headers['accept-ranges']) ? { 'Accept-Ranges': headers['accept-ranges'] } : {}) } };
}
