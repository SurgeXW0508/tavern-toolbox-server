import { once } from 'node:events';

export class FileTransferFailure extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new FileTransferFailure(code); };
export function byteRange(value, size) {
    if (value === undefined) return { status: 200, start: 0, end: size - 1 };
    if (typeof value !== 'string' || value.length > 128) fail('UNSUPPORTED_RANGE');
    const match = /^bytes=(\d*)-(\d*)$/.exec(value);
    if (!match || !(match[1] || match[2])) fail('UNSUPPORTED_RANGE');
    const a = match[1] ? Number(match[1]) : null, b = match[2] ? Number(match[2]) : null;
    if (a !== null && !Number.isSafeInteger(a) || b !== null && !Number.isSafeInteger(b)
        || a !== null && b !== null && b < a || a === null && !b) fail('UNSUPPORTED_RANGE');
    const start = a ?? Math.max(0, size - b), end = a !== null && b !== null ? Math.min(b, size - 1) : size - 1;
    return { status: start >= size ? 416 : 206, start, end };
}
// Ownership of handle transfers to this call, including invalid range/HEAD/failure.
export async function streamLocalFile({ handle, size, mime, range, head = false, output, signal, idleTimeoutMs = 30000 }) {
    let timer;
    const controller = new AbortController();
    const abort = () => { controller.abort(); output.destroy?.(); };
    const touch = () => { if (!idleTimeoutMs) return; clearTimeout(timer); timer = setTimeout(abort, idleTimeoutMs); timer.unref?.(); };
    signal?.addEventListener('abort', abort, { once: true });
    output.once('close', abort); output.once('error', abort);
    try {
        if (signal?.aborted) abort();
        if (controller.signal.aborted) fail('CLIENT_ABORTED');
        const { status, start, end } = byteRange(range, size);
        output.statusCode = status; output.setHeader('Accept-Ranges', 'bytes');
        if (status === 416) {
            output.setHeader('Content-Range', `bytes */${size}`); output.setHeader('Content-Length', '0'); output.end(); return;
        }
        output.setHeader('Content-Type', mime); output.setHeader('Content-Length', String(end - start + 1));
        if (status === 206) output.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        if (head) { output.end(); return; }
        touch(); const chunk = Buffer.alloc(64 * 1024); let position = start;
        while (position <= end) {
            if (controller.signal.aborted) fail('CLIENT_ABORTED');
            const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, end - position + 1), position);
            if (!bytesRead) fail('FILE_CHANGED');
            if (controller.signal.aborted) fail('CLIENT_ABORTED');
            if (!output.write(Buffer.from(chunk.subarray(0, bytesRead)))) await once(output, 'drain', { signal: controller.signal });
            position += bytesRead; touch();
        }
        output.end();
    } finally {
        clearTimeout(timer); signal?.removeEventListener('abort', abort); output.off('close', abort); output.off('error', abort); await handle.close();
    }
}
