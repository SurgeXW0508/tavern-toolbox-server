import { fail, uuid } from './validation.js';

// Trusted composition adapters, not a browser-writable provider registry.
export function createVideoReferences() {
    const providers = new Map();
    return {
        register(provider) {
            if (!provider?.id || providers.has(provider.id) || typeof provider.enumerate !== 'function') throw new Error('INVALID_VIDEO_PROVIDER');
            providers.set(provider.id, provider);
        },
        async analyze(context, videoId) {
            const references = []; let complete = true;
            for (const provider of providers.values()) {
                let timer;
                try {
                    const rows = await Promise.race([provider.enumerate(context), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 1000); })]);
                    if (!Array.isArray(rows) || rows.length > 30000) throw new Error('invalid provider');
                    for (const row of rows) {
                        uuid(row.videoId);
                        if (typeof row.ownerId !== 'string' || !row.ownerId || row.ownerId.length > 128 || typeof row.label !== 'string' || row.label.length > 512) throw new Error('invalid provider');
                        if (row.videoId === videoId) references.push({ providerId: provider.id, ownerId: row.ownerId, label: row.label });
                    }
                } catch { complete = false; }
                finally { clearTimeout(timer); }
            }
            if (references.length > 100) return { complete, count: references.length, references: references.slice(0, 100) };
            return { complete, count: references.length, references };
        },
        async requireUnused(context, id) {
            const analysis = await this.analyze(context, id);
            if (!analysis.complete) fail('VIDEO_REFERENCES_INCOMPLETE');
            if (analysis.count) fail('VIDEO_REFERENCED');
        },
    };
}
