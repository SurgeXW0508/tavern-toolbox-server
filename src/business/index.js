import { BusinessStore, BusinessFailure, MAX_BUSINESS_BYTES } from './store.js';
import { OUTFIT_NAMESPACE, OUTFIT_BUSINESS_SCHEMA, emptyOutfit, validateOutfit, addedMediaRefs, outfitReferenceGroups } from './outfit.js';

export { BusinessFailure } from './store.js';

export function createBusiness(config, media, coordinate = async (_context, work) => work()) {
    const stores = new Map();
    let DatabaseSync, initializationError = null, stopped = false;
    const failures = new Map();
    const consumers = new Map([[OUTFIT_NAMESPACE, {
        schemaVersion: OUTFIT_BUSINESS_SCHEMA, empty: emptyOutfit, validate: validateOutfit,
    }]]);

    async function store(context) {
        if (stopped || !DatabaseSync || !context?.userRoot)
            throw new BusinessFailure(initializationError || 'BUSINESS_UNAVAILABLE');
        if (!stores.has(context.userRoot)) {
            stores.set(context.userRoot, (async () => {
                const item = new BusinessStore(context.userRoot, DatabaseSync);
                await item.initialize();
                return item;
            })());
        }
        try { const item = await stores.get(context.userRoot); failures.delete(context.userRoot); return item; }
        catch (error) {
            stores.delete(context.userRoot);
            failures.set(context.userRoot, error instanceof BusinessFailure ? error.code : 'BUSINESS_STORE_UNAVAILABLE');
            throw error;
        }
    }

    function consumer(namespace, schemaVersion) {
        const contract = consumers.get(namespace);
        if (!contract) throw new BusinessFailure('BUSINESS_CONSUMER_UNAVAILABLE');
        if (schemaVersion !== contract.schemaVersion) throw new BusinessFailure('BUSINESS_SCHEMA_INCOMPATIBLE');
        return contract;
    }

    const api = {
        definition: { id: 'business', version: '0.1.0', dependsOn: ['core'],
            capabilities: [{ id: 'business.collections', contract: { major: 1, minMinor: 0, maxMinor: 0 },
                operations: ['read', 'commit'].map(id => ({ id, available: true })),
                operationAvailability: () => ({ commit: { available: config.policy.core.allowedOrigins.length > 0,
                    reasonCode: 'ORIGIN_POLICY_MISSING' } }),
                limits: { maxDocumentBytes: MAX_BUSINESS_BYTES },
                constraints: { consumers: [{ namespace: OUTFIT_NAMESPACE, schemaVersion: OUTFIT_BUSINESS_SCHEMA }],
                    revision: 'collection-cas', storage: 'sqlite', provider: 'server' } }],
            initialize: async () => {
                try {
                    const [major, minor] = process.versions.node.split('.').map(Number);
                    if (major < 22 || major === 22 && minor < 13) throw new Error('RUNTIME_UNSUPPORTED');
                    ({ DatabaseSync } = await import('node:sqlite'));
                } catch { initializationError = 'BUSINESS_RUNTIME_UNAVAILABLE'; throw new Error(initializationError); }
            },
            health: async context => {
                if (initializationError) return { state: 'unavailable', reasonCode: initializationError };
                try { await store(context); return { state: 'ready', reasonCode: null }; }
                catch { return { state: 'unavailable', reasonCode: failures.get(context?.userRoot) || 'BUSINESS_STORE_UNAVAILABLE' }; }
            },
            shutdown: async () => {
                stopped = true;
                for (const pending of stores.values()) { try { (await pending).close(); } catch {} }
                stores.clear();
            },
        },
        async read(context, namespace, schemaVersion) {
            const contract = consumer(namespace, schemaVersion);
            const result = (await store(context)).read(namespace, contract.empty(), schemaVersion);
            contract.validate(result.document);
            return result;
        },
        async commit(context, namespace, schemaVersion, revision, document) {
            return coordinate(context, async () => {
            const contract = consumer(namespace, schemaVersion);
            contract.validate(document);
            const target = await store(context);
            // Only newly introduced media must be present. An existing broken ref
            // after restore remains editable so the user can repair it.
            const current = target.read(namespace, contract.empty(), schemaVersion);
            if (current.revision !== revision) throw new BusinessFailure('BUSINESS_CONFLICT');
            const previous = current.document;
            for (const id of addedMediaRefs(document, previous)) {
                try { await media.metadata(context, id); }
                catch { throw new BusinessFailure('BUSINESS_MEDIA_UNAVAILABLE'); }
            }
            return target.commit(namespace, schemaVersion, revision, document, contract.validate);
            });
        },
    };
    api.referenceProvider = { id: 'outfit', consumer: 'outfit', label: '穿搭',
        enumerate: async context => outfitReferenceGroups(await api.read(context, OUTFIT_NAMESPACE, OUTFIT_BUSINESS_SCHEMA)),
        mutate: async (context, body) => {
            if (body.referenceId !== 'image' || !['replace', 'unlink'].includes(body.action)) throw new BusinessFailure('INVALID_REQUEST');
            const snapshot = await api.read(context, OUTFIT_NAMESPACE, OUTFIT_BUSINESS_SCHEMA);
            if (snapshot.revision !== body.revision) throw new BusinessFailure('BUSINESS_CONFLICT');
            const asset = snapshot.document.assets.find(item => item.id === body.groupId);
            if (!asset || !asset.mediaRef) throw new BusinessFailure('REFERENCE_NOT_FOUND');
            asset.mediaRef = body.action === 'unlink' ? null : body.mediaRef;
            if (body.action === 'replace' && !body.mediaRef) throw new BusinessFailure('INVALID_REQUEST');
            return api.commit(context, OUTFIT_NAMESPACE, OUTFIT_BUSINESS_SCHEMA, body.revision, snapshot.document);
        } };
    return api;
}
