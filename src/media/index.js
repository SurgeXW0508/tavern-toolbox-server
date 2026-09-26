import { MediaStore } from './store.js';
import { MediaFailure, validateImage } from './validation.js';

export { MediaFailure } from './validation.js';

export function createMedia(config, network) {
    const policy = config.policy.media;
    const stores = new Map();
    let sharp, DatabaseSync, initializationError = null, imports = 0, stopped = false;
    const failures = new Map();

    async function store(context) {
        if (stopped || !sharp || !DatabaseSync) throw new MediaFailure(initializationError || 'MEDIA_UNAVAILABLE');
        if (!context?.userRoot) throw new MediaFailure('MEDIA_UNAVAILABLE');
        const key = context.userRoot;
        if (!stores.has(key)) {
            const pending = (async () => {
                const instance = new MediaStore(key, policy, DatabaseSync);
                await instance.initialize();
                return instance;
            })();
            stores.set(key, pending);
        }
        try { const result = await stores.get(key); failures.delete(key); return result; }
        catch (error) {
            stores.delete(key); failures.set(key, error instanceof MediaFailure ? error.code : 'MEDIA_STORE_UNAVAILABLE');
            throw error;
        }
    }

    function reserveImport() {
        if (imports >= policy.maxConcurrentImports) throw new MediaFailure('RESOURCE_BUSY');
        imports++;
        let released = false;
        return () => { if (!released) { released = true; imports--; } };
    }

    async function importBytes(context, bytes, declared, reserved = false) {
        const release = reserved ? () => {} : reserveImport();
        try {
            const target = await store(context);
            const validated = await validateImage(bytes, declared, policy, sharp);
            return await target.import(bytes, validated);
        } finally { release(); }
    }

    const definition = { id: 'media', version: '0.1.0', dependsOn: ['core'],
        capabilities: [{ id: 'media.assets', contract: { major: 1, minMinor: 0, maxMinor: 0 },
            operations: ['localImport', 'remoteImport', 'metadata', 'read', 'delete', 'storage',
                'rebuildThumbnail', 'cleanupTechnicalGarbage'].map(id => ({ id, available: true })),
            operationAvailability: () => {
                const mutations = config.policy.core.allowedOrigins.length > 0;
                const networkState = network.definition.health().state;
                return { localImport: { available: mutations, reasonCode: 'ORIGIN_POLICY_MISSING' },
                    remoteImport: { available: mutations && networkState === 'ready',
                        reasonCode: networkState !== 'ready' ? 'NETWORK_UNAVAILABLE' : 'ORIGIN_POLICY_MISSING' },
                    delete: { available: mutations, reasonCode: 'ORIGIN_POLICY_MISSING' },
                    rebuildThumbnail: { available: mutations, reasonCode: 'ORIGIN_POLICY_MISSING' },
                    cleanupTechnicalGarbage: { available: mutations, reasonCode: 'ORIGIN_POLICY_MISSING' } };
            },
            limits: { maxBytes: policy.maxBytes, quotaBytes: policy.quotaBytes, maxDimension: policy.maxDimension,
                maxPixels: policy.maxPixels, maxFrames: policy.maxFrames, maxFramePixels: policy.maxFramePixels,
                maxConcurrentImports: policy.maxConcurrentImports },
            constraints: { profiles: ['image'], mimeTypes: ['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
                supportedAnimation: ['gif'], storage: 'sqlite-filesystem', refProvider: 'server' } }],
        initialize: async () => {
            if (config.policy.mediaError) { initializationError = config.policy.mediaError; throw new Error(initializationError); }
            try {
                // Media stays unavailable on an older runtime, while Core and Network remain usable.
                const [major, minor] = process.versions.node.split('.').map(Number);
                if (major < 22 || major === 22 && minor < 13) throw new Error('RUNTIME_UNSUPPORTED');
                ({ DatabaseSync } = await import('node:sqlite'));
                ({ default: sharp } = await import('sharp'));
                sharp.cache(false);
                sharp.concurrency(1);
            } catch { initializationError = 'MEDIA_RUNTIME_UNAVAILABLE'; throw new Error(initializationError); }
        },
        health: async context => {
            if (initializationError) return { state: 'unavailable', reasonCode: initializationError };
            try { await store(context); return { state: 'ready', reasonCode: null }; }
            catch { return { state: 'unavailable', reasonCode: failures.get(context?.userRoot) || 'MEDIA_STORE_UNAVAILABLE' }; }
        },
        shutdown: async () => {
            stopped = true;
            for (const promise of stores.values()) { try { (await promise).close(); } catch {} }
            stores.clear();
        },
    };

    return { definition, importBytes, reserveImport,
        remoteImport: async (context, url, signal) => {
            const release = reserveImport();
            try {
                const state = network.definition.health().state;
                if (state !== 'ready') throw new MediaFailure('NETWORK_UNAVAILABLE');
                const result = await network.fetchImage(url, context.contextId, signal);
                return await importBytes(context, result.body, result.mime, true);
            } finally { release(); }
        },
        metadata: async (context, id) => (await store(context)).metadata(id),
        read: async (context, id, derived) => (await store(context)).read(id, derived),
        delete: async (context, id) => (await store(context)).delete(id),
        storage: async context => (await store(context)).usage(),
        rebuild: async (context, id) => (await store(context)).rebuild(id, sharp),
        cleanup: async context => (await store(context)).cleanupTechnicalGarbage(),
    };
}
