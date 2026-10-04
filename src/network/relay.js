import { once } from 'node:events';
import { approveDestination, NetworkFailure } from './destination.js';
import { openApproved } from './transport.js';

const fail = code => { throw new NetworkFailure(code); };

// Bounded waits apply to establishing a hop and waiting for data, never the whole transfer.
export async function waitFor(promise, signal, milliseconds, code = 'REMOTE_TIMEOUT') {
    if (signal.aborted) fail('CLIENT_ABORTED');
    let timer, abort;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
            abort = () => reject(new NetworkFailure('CLIENT_ABORTED'));
            signal.addEventListener('abort', abort, { once: true });
            timer = setTimeout(() => reject(new NetworkFailure(code)), milliseconds);
        })]);
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

// Streaming-only foundation. Complete image fetch is deliberately left unchanged.
export async function openRelay(url, policy, profile, signal, { resolver, open = openApproved } = {}) {
    let current = url, previous, redirects = 0;
    const visited = new Set();
    for (;;) {
        let target;
        try { target = await waitFor(approveDestination(current, policy, previous, resolver), signal, policy.connectTimeoutMs); }
        catch (error) { if (error instanceof NetworkFailure) throw error; fail('DNS_UNRESOLVED'); }
        if (visited.has(target.url.href)) fail('REDIRECT_REJECTED');
        visited.add(target.url.href);
        let connection;
        try { connection = await open(target, policy, signal, {}, profile); }
        catch (error) {
            if (signal.aborted) fail('CLIENT_ABORTED');
            if (error?.message === 'REMOTE_TIMEOUT') fail('REMOTE_TIMEOUT');
            fail(policy.transport === 'http-proxy' ? 'TRANSPORT_UNAVAILABLE' : 'REMOTE_UNAVAILABLE');
        }
        const { response, close } = connection;
        if (!(response.statusCode >= 300 && response.statusCode < 400)) return connection;
        try {
            if (++redirects > policy.maxRedirects) fail('TOO_MANY_REDIRECTS');
            const location = response.headers.location;
            if (typeof location !== 'string' || /[\u0000-\u001f\u007f\\#]/.test(location)) fail('REDIRECT_REJECTED');
            previous = target.url;
            try { current = new URL(location, previous).href; } catch { fail('REDIRECT_REJECTED'); }
        } finally { close(); }
    }
}

export async function transferRelay(response, downstream, signal, { length, firstByteTimeoutMs, idleTimeoutMs }) {
    let bytes = 0, first = true;
    const iterator = response[Symbol.asyncIterator]();
    try {
        for (;;) {
            // No idle timer while downstream backpressure intentionally pauses reads.
            const item = await waitFor(iterator.next(), signal, first ? firstByteTimeoutMs : idleTimeoutMs);
            if (item.done) break;
            first = false;
            bytes += item.value.length;
            if (bytes > length) fail('REMOTE_RESOURCE_TOO_LARGE');
            if (!downstream.write(item.value)) await once(downstream, 'drain', { signal });
        }
        if (bytes !== length) fail('REMOTE_UNAVAILABLE');
        downstream.end();
    } catch (error) {
        if (signal.aborted) fail('CLIENT_ABORTED');
        if (error instanceof NetworkFailure) throw error;
        fail('REMOTE_UNAVAILABLE');
    }
}
