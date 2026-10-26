import { opendir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { safePath, rootFor, openVideo } from './roots.js';
import { fail, object, aborted, uuid } from './validation.js';
import { VIDEO_LIMITS as limits } from './policy.js';

// Bounded memory only. No timer, startup I/O, recursive scan or durable paths in DTOs.
export class VideoDiscovery {
    constructor(policy, now = Date.now) { this.policy = policy; this.now = now; this.sessions = new Map(); }
    prune() { for (const [id, value] of this.sessions) if (value.expiresAt <= this.now()) this.sessions.delete(id); }
    lookup(context, id) {
        uuid(id); this.prune();
        const session = [...this.sessions.values()].find(item => item.contextId === context.contextId && item.userRoot === context.userRoot && item.entries.has(id));
        if (!session) fail('VIDEO_CANDIDATE_EXPIRED');
        const entry = session.entries.get(id); rootFor(this.policy, context, session.rootKey);
        return { session, entry };
    }
    candidate(context, id) { const value = this.lookup(context, id); if (value.entry.kind !== 'file') fail('INVALID_REQUEST'); return value; }
    page(session, offset) {
        return { sessionId: session.id, breadcrumbs: session.breadcrumbs, rootKey: session.rootKey, directoryLabel: session.directoryLabel, entries: session.rows.slice(offset, offset + 50),
            nextCursor: offset + 50 < session.rows.length ? `${session.id}:${offset + 50}` : null, expiresAt: session.expiresAt };
    }
    async browse(context, input, signal) {
        object(input, ['rootKey', 'directoryId', 'cursor']); this.prune(); aborted(signal);
        if (input.cursor !== undefined) {
            if (Object.keys(input).length !== 1 || typeof input.cursor !== 'string') fail('INVALID_REQUEST');
            const [id, offset, extra] = input.cursor.split(':'); uuid(id);
            if (extra || !/^[1-9]\d{0,3}$/.test(offset)) fail('INVALID_REQUEST');
            const session = this.sessions.get(id);
            if (!session || session.contextId !== context.contextId || session.userRoot !== context.userRoot) fail('VIDEO_CANDIDATE_EXPIRED');
            rootFor(this.policy, context, session.rootKey);
            if (Number(offset) % 50 || Number(offset) >= session.rows.length) fail('INVALID_REQUEST');
            return this.page(session, Number(offset));
        }
        let rootKey = input.rootKey, relative = '', replacing;
        if (input.directoryId !== undefined) {
            if (Object.keys(input).length !== 1) fail('INVALID_REQUEST');
            const { session, entry } = this.lookup(context, input.directoryId);
            if (entry.kind !== 'directory') fail('INVALID_REQUEST'); replacing = session.id; rootKey = session.rootKey; relative = entry.relative;
        } else if (Object.keys(input).length !== 1 || typeof rootKey !== 'string') fail('INVALID_REQUEST');
        if ([...this.sessions.values()].filter(s => s.id !== replacing).length >= limits.discoveryGlobal || [...this.sessions.values()].filter(s => s.id !== replacing && s.userRoot === context.userRoot).length >= limits.discoveryPerUser) fail('RESOURCE_BUSY');
        const root = rootFor(this.policy, context, rootKey), rows = [], entries = new Map();
        let dir;
        try { dir = await opendir(await safePath(root, relative, true)); }
        catch { fail('VIDEO_SOURCE_UNAVAILABLE'); }
        try {
            let count = 0;
            for await (const entry of dir) {
                aborted(signal); if (++count > limits.directoryEntries) fail('VIDEO_DIRECTORY_LIMIT');
                if (entry.isSymbolicLink() || !entry.isDirectory() && !entry.isFile()) continue;
                const name = entry.name;
                if (/[\x00-\x1f\x7f\\]/.test(name) || name.length > 255) continue;
                const next = relative ? `${relative}/${name}` : name;
                if (next.split('/').length > limits.directoryDepth) continue;
                const id = randomUUID();
                if (entry.isDirectory()) {
                    entries.set(id, { kind: 'directory', relative: next }); rows.push({ id, kind: 'directory', name });
                } else if (/\.(mp4|m4v|webm)$/i.test(name)) {
                    let file;
                    try {
                        file = await openVideo(this.policy, context, rootKey, next, null, signal);
                        entries.set(id, { kind: 'file', relative: next, fingerprint: file.fingerprint });
                        rows.push({ id, kind: 'file', name, byteSize: file.byteSize, mime: file.mime });
                    } catch (error) {
                        if (error.code === 'CLIENT_ABORTED') throw error;
                        // An unsupported/damaged neighbour must not hide valid
                        // files. Unavailable rows are never selectable candidates.
                        rows.push({ id, kind: 'unavailable', name, reasonCode: error.code === 'VIDEO_FORMAT_UNSUPPORTED' ? error.code : 'VIDEO_SOURCE_UNAVAILABLE' });
                    } finally { await file?.handle.close(); }
                }
            }
        } catch (error) {
            if (error?.code?.startsWith('VIDEO_') || error?.code === 'CLIENT_ABORTED') throw error;
            fail('VIDEO_SOURCE_UNAVAILABLE');
        }
        aborted(signal); this.prune();
        // Never silently evict a user's pending selection to admit another scan.
        if ([...this.sessions.values()].filter(s => s.id !== replacing).length >= limits.discoveryGlobal || [...this.sessions.values()].filter(s => s.id !== replacing && s.userRoot === context.userRoot).length >= limits.discoveryPerUser) fail('RESOURCE_BUSY');
        rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
        const breadcrumbs = [];
        const parts = relative ? relative.split('/') : [];
        for (let n = 0; n <= parts.length; n++) {
            const id = randomUUID();
            entries.set(id, { kind: 'directory', relative: parts.slice(0, n).join('/') });
            breadcrumbs.push({ id, label: n ? parts[n - 1] : root.label });
        }
        const session = { id: randomUUID(), breadcrumbs, userRoot: context.userRoot, contextId: context.contextId, rootKey, directoryLabel: relative || root.label,
            entries, rows, expiresAt: this.now() + limits.discoveryTtlMs };
        if (replacing) this.sessions.delete(replacing);
        this.sessions.set(session.id, session); return this.page(session, 0);
    }
    cancel(context, id) { uuid(id); const session = this.sessions.get(id); if (session?.contextId === context.contextId && session.userRoot === context.userRoot) this.sessions.delete(id); return { cancelled: true }; }
    clear() { this.sessions.clear(); }
}
