import { randomBytes, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { coordinateAudio } from './coordination.js';
import { AudioAssetFailure } from './errors.js';

export const BROWSE_TTL_MS = 60_000;
export const validBrowseCursor = value => typeof value === 'string' && /^[1-9]\d{0,3}~[a-f0-9]{16}$/.test(value);
const fail = code => { throw new AudioAssetFailure(code); };
const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// Audio-only transient reads. Snapshots are presentation data, never authority
// for stream opening, reference writes or deletion. One owner for both domains.
export class AudioReadSessions {
    constructor({ now = () => performance.now() } = {}) {
        this.now = now; this.sessions = new Map(); this.active = new Set(); this.closed = false;
        this.timer = setInterval(() => this.sweep(), BROWSE_TTL_MS); this.timer.unref();
    }
    sweep() {
        for (const [id, entry] of this.sessions) if (this.now() >= entry.expires) this.sessions.delete(id);
    }
    async read(context, { key, cursor, capture, build, checkPage, view, signal, complete = false }) {
        if (this.closed) fail('AUDIO_ASSET_UNAVAILABLE');
        if (signal?.aborted) fail('CLIENT_ABORTED');
        if (cursor != null && !validBrowseCursor(cursor)) fail('INVALID_REQUEST');
        if (this.active.size >= 4 || [...this.active].some(entry => entry.root === context.userRoot)) fail('RESOURCE_BUSY');
        const controller = new AbortController(), abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(abort, 30_000); timer.unref();
        let release;
        const active = { root: context.userRoot, key, controller, done: new Promise(resolve => { release = resolve; }) };
        this.active.add(active);
        const alive = () => { if (controller.signal.aborted || this.closed) fail('CLIENT_ABORTED'); };
        const captureNow = () => coordinateAudio(context.userRoot, () => { alive(); return capture(); });
        try {
            this.sweep();
            let entry, offset = 0, token;
            if (cursor) {
                const [position, id] = cursor.split('~'); offset = Number(position); token = id;
                entry = this.sessions.get(token);
                if (!entry || entry.root !== context.userRoot || entry.contextId !== context.contextId || entry.key !== key)
                    fail('AUDIO_BROWSE_EXPIRED');
                if (offset % 50 || offset >= entry.rows.length) fail('INVALID_REQUEST');
                const current = await captureNow();
                if (fingerprint(current) !== entry.fingerprint) { this.sessions.delete(token); fail('AUDIO_BROWSE_EXPIRED'); }
                // External filesystem changes cannot be observed by SQLite revisions.
                // Recheck this page; off-page membership/summary is as of the scan.
                if (!await checkPage(entry.rows.slice(offset, offset + 50), controller.signal, current)) {
                    this.sessions.delete(token); fail('AUDIO_BROWSE_EXPIRED');
                }
            } else {
                const captured = await captureNow(), stamp = fingerprint(captured);
                const result = await build(captured, controller.signal);
                alive();
                if (result.rows.length > 4096) fail('AUDIO_ASSET_DATA_INVALID');
                token = randomBytes(8).toString('hex');
                entry = { ...result, root: context.userRoot, contextId: context.contextId, key,
                    fingerprint: stamp, expires: this.now() + BROWSE_TTL_MS };
            }
            // Re-enter the same coordinator to reject writes/deletion during I/O.
            // There is no automatic retry and no cached authority at mutation time.
            if (fingerprint(await captureNow()) !== entry.fingerprint) { this.sessions.delete(token); fail('AUDIO_BROWSE_EXPIRED'); }
            alive();
            if (this.now() >= entry.expires) { this.sessions.delete(token); fail('AUDIO_BROWSE_EXPIRED'); }
            if (!cursor && !complete && entry.rows.length > 50) {
                const owned = [...this.sessions].filter(([, value]) => value.root === context.userRoot);
                while (owned.length >= 2) this.sessions.delete(owned.shift()[0]);
                while (this.sessions.size >= 8) this.sessions.delete(this.sessions.keys().next().value);
                this.sessions.set(token, entry);
            }
            return structuredClone(view(entry, offset, complete ? null : offset + 50 < entry.rows.length ? `${offset + 50}~${token}` : null, token, complete));
        } finally {
            clearTimeout(timer); signal?.removeEventListener('abort', abort); this.active.delete(active); release();
        }
    }
    async drain(prefix) {
        for (const [id, entry] of this.sessions) if (entry.key.startsWith(prefix)) this.sessions.delete(id);
        const pending = [...this.active].filter(entry => entry.key.startsWith(prefix));
        for (const entry of pending) entry.controller.abort();
        await Promise.all(pending.map(entry => entry.done));
    }
    async close() {
        this.closed = true; clearInterval(this.timer); this.sessions.clear();
        for (const entry of this.active) entry.controller.abort();
        await Promise.all([...this.active].map(entry => entry.done));
    }
}
