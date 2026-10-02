import { MediaFailure } from '../media/validation.js';
const fail = code => { throw new MediaFailure(code); };
const ID = /^[0-9a-f-]{36}$/i;
const states = ['active', 'detached', 'unreferenced', 'unknown'];
function page(query) {
    const offset = Number(query.offset ?? 0), limit = Number(query.limit ?? 24);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 48
        || typeof (query.search ?? '') !== 'string' || (query.search || '').length > 160
        || query.state && !states.includes(query.state)
        || query.kind && query.kind !== 'image'
        || query.sort && !['newest', 'oldest', 'largest', 'smallest'].includes(query.sort)
        || query.broken && query.broken !== 'true') fail('INVALID_REQUEST');
    return { offset, limit, search: (query.search || '').toLocaleLowerCase() };
}
function slice(items, bounds) {
    return { items: items.slice(bounds.offset, bounds.offset + bounds.limit), total: items.length,
        offset: bounds.offset, limit: bounds.limit, hasMore: bounds.offset + bounds.limit < items.length };
}
function stateOf(references, complete) {
    if (references.some(ref => ref.lifecycle === 'active')) return 'active';
    if (references.some(ref => ref.lifecycle === 'detached')) return 'detached';
    return complete ? 'unreferenced' : 'unknown';
}

export function createGovernance(media, coordinate, { mutations = true } = {}) {
    const providers = new Map();
    function register(provider) {
        if (!provider?.id || providers.has(provider.id) || typeof provider.enumerate !== 'function')
            throw new Error('INVALID_REFERENCE_PROVIDER');
        providers.set(provider.id, provider);
    }
    async function analysis(context) {
        const health = [], groups = [], references = [];
        for (const provider of providers.values()) {
            try {
                let timer;
                const result = await Promise.race([Promise.resolve().then(() => provider.enumerate(context)),
                    new Promise((_, reject) => { timer = setTimeout(() => reject(new MediaFailure('REFERENCE_ANALYSIS_INCOMPLETE')), 10000); })])
                    .finally(() => clearTimeout(timer));
                if (!Array.isArray(result)) fail('REFERENCE_ANALYSIS_INCOMPLETE');
                // Providers own their schemas; this boundary validates the common contract.
                for (const group of result) {
                    if (typeof group.id !== 'string' || !group.id || typeof group.label !== 'string'
                        || !['active', 'detached'].includes(group.lifecycle) || !Number.isSafeInteger(group.revision)
                        || !Array.isArray(group.references) || group.references.some(ref => typeof ref.id !== 'string'
                            || ref.mediaRef?.provider !== 'server' || !ID.test(ref.mediaRef.assetId)))
                        fail('REFERENCE_ANALYSIS_INCOMPLETE');
                }
                for (const group of result) {
                    const common = { id: group.id, label: group.label, lifecycle: group.lifecycle, revision: group.revision,
                        description: group.description || '', detachedAt: group.detachedAt || null, hostId: group.hostId || null,
                        actions: group.actions || [], references: group.references.map(ref => ({ id: ref.id, label: ref.label || '媒体关联', mediaRef: ref.mediaRef, actions: ref.actions || [] })),
                        providerId: provider.id, consumer: provider.consumer,
                        consumerLabel: provider.label, referenceCount: group.references.length };
                    groups.push(common);
                    references.push(...common.references.map(ref => ({ ...ref, providerId: provider.id,
                        groupId: group.id, groupLabel: group.label, consumer: provider.consumer,
                        consumerLabel: provider.label, lifecycle: group.lifecycle, revision: group.revision, hostId: group.hostId || null })));
                }
                health.push({ id: provider.id, consumer: provider.consumer, label: provider.label, state: 'complete' });
            } catch { health.push({ id: provider.id, consumer: provider.consumer, label: provider.label, state: 'unavailable' }); }
        }
        const complete = providers.size > 0 && health.every(item => item.state === 'complete');
        return { complete, providers: health, groups, references };
    }
    async function catalog(context) {
        const [assets, refs, storage] = await Promise.all([media.catalog(context), analysis(context), media.storage(context)]);
        const byAsset = new Map();
        for (const ref of refs.references) {
            const list = byAsset.get(ref.mediaRef.assetId) || [];
            list.push(ref); byAsset.set(ref.mediaRef.assetId, list);
        }
        const ids = new Set(assets.map(item => item.mediaRef.assetId));
        const broken = refs.references.filter(ref => !ids.has(ref.mediaRef.assetId));
        const items = assets.map(asset => {
            const references = byAsset.get(asset.mediaRef.assetId) || [];
            return { ...asset, referenceState: stateOf(references, refs.complete), referenceCount: references.length,
                consumers: [...new Set(references.map(ref => ref.consumer))] };
        });
        return { items, refs, byAsset, ids, broken, storage };
    }
    const api = {
        register, analysis,
        definition: { id: 'governance', version: '0.1.0', dependsOn: ['core', 'media'],
            capabilities: [{ id: 'media.governance', contract: { major: 1, minMinor: 0, maxMinor: 0 },
                operations: ['summary', 'assets', 'groups', 'detail', 'group', 'action', 'deleteBatch'].map(id => ({ id, available: true })),
                operationAvailability: () => ({ action: { available: mutations, reasonCode: 'ORIGIN_POLICY_MISSING' },
                    deleteBatch: { available: mutations, reasonCode: 'ORIGIN_POLICY_MISSING' } }),
                limits: { maxPageSize: 48, maxDeleteBatch: 48 }, constraints: { referenceProviders: () => {} } }],
            health: () => ({ state: 'ready' }) },
        async summary(context) {
            const { items, refs, broken, storage } = await catalog(context);
            const free = items.filter(item => item.referenceState === 'unreferenced');
            return { storage, complete: refs.complete, providers: refs.providers, unreferencedCount: free.length,
                unreferencedBytes: free.reduce((sum, item) => sum + item.originalBytes + item.derivedBytes, 0), brokenCount: broken.length };
        },
        async assets(context, query = {}) {
            const bounds = page(query), { items, refs, byAsset } = await catalog(context);
            const selected = items.filter(item => (!query.state || query.state === item.referenceState)
                && (!query.consumer || item.consumers.includes(query.consumer)) && (!query.kind || query.kind === item.kind)
                && (!bounds.search || [item.mediaRef.assetId, ...(byAsset.get(item.mediaRef.assetId) || [])
                    .flatMap(ref => [ref.groupLabel, ref.consumerLabel])].some(value => value.toLocaleLowerCase().includes(bounds.search))));
            const order = query.sort || 'newest';
            selected.sort((a, b) => (order === 'largest' ? b.originalBytes - a.originalBytes
                : order === 'smallest' ? a.originalBytes - b.originalBytes
                    : order === 'oldest' ? a.createdAt.localeCompare(b.createdAt) : b.createdAt.localeCompare(a.createdAt))
                || a.mediaRef.assetId.localeCompare(b.mediaRef.assetId));
            return { ...slice(selected, bounds), complete: refs.complete, providers: refs.providers };
        },
        async groups(context, query = {}) {
            const bounds = page(query), { refs, ids } = await catalog(context);
            const groups = refs.groups.map(({ references, ...group }) => ({ ...group,
                brokenCount: references.filter(ref => !ids.has(ref.mediaRef.assetId)).length }));
            return { ...slice(groups.filter(group => (!query.consumer || group.consumer === query.consumer)
                && (!query.state || group.lifecycle === query.state)
                && (query.broken !== 'true' || group.brokenCount > 0)
                && (!bounds.search || [group.label, group.consumerLabel].some(value => value.toLocaleLowerCase().includes(bounds.search)))), bounds),
                complete: refs.complete, providers: refs.providers };
        },
        async detail(context, id, query = {}) {
            const bounds = page(query), { items, refs, byAsset } = await catalog(context);
            const asset = items.find(item => item.mediaRef.assetId === id);
            if (!asset) fail('MEDIA_NOT_FOUND');
            return { asset, health: await media.health(context, id), references: slice(byAsset.get(id) || [], bounds), complete: refs.complete };
        },
        async group(context, providerId, groupId, query = {}) {
            const bounds = page(query), { refs, ids } = await catalog(context);
            const group = refs.groups.find(item => item.providerId === providerId && item.id === groupId);
            if (!group) fail(refs.complete ? 'REFERENCE_NOT_FOUND' : 'REFERENCE_ANALYSIS_INCOMPLETE');
            const { references, ...info } = group;
            return { group: info, references: slice(references.map(ref => ({ ...ref, broken: !ids.has(ref.mediaRef.assetId) })), bounds), complete: refs.complete };
        },
        async action(context, body) {
            if (!body || Object.keys(body).some(key => !['providerId', 'groupId', 'referenceId', 'action', 'revision', 'hostId', 'displayName', 'mediaRef'].includes(key))
                || typeof body.groupId !== 'string' || !Number.isSafeInteger(body.revision) || body.revision < 0) fail('INVALID_REQUEST');
            const provider = providers.get(body.providerId);
            if (!provider?.mutate) fail('REFERENCE_ACTION_UNAVAILABLE');
            // Provider mutations themselves acquire the coordinator; avoid recursive locking.
            const result = await provider.mutate(context, body);
            return { revision: result.revision };
        },
        async delete(context, id) {
            return coordinate(context, async () => {
                await media.metadata(context, id);
                const refs = await analysis(context);
                if (!refs.complete) fail('REFERENCE_ANALYSIS_INCOMPLETE');
                if (refs.references.some(ref => ref.mediaRef.assetId === id)) fail('MEDIA_REFERENCED');
                return media.delete(context, id);
            });
        },
        async deleteBatch(context, assetIds) {
            if (!Array.isArray(assetIds) || !assetIds.length || assetIds.length > 48
                || new Set(assetIds).size !== assetIds.length || assetIds.some(id => !ID.test(id))) fail('INVALID_REQUEST');
            return coordinate(context, async () => {
                // No Consumer can introduce a reference between this fresh scan
                // and the final item. Re-entering api.delete would deadlock.
                const refs = await analysis(context);
                const protectedIds = new Set(refs.references.map(ref => ref.mediaRef.assetId));
                const items = [];
                for (const assetId of assetIds) {
                    try {
                        await media.metadata(context, assetId);
                        if (!refs.complete) fail('REFERENCE_ANALYSIS_INCOMPLETE');
                        if (protectedIds.has(assetId)) fail('MEDIA_REFERENCED');
                        await media.delete(context, assetId);
                        items.push({ assetId, deleted: true });
                    } catch (error) {
                        items.push({ assetId, deleted: false, code: error instanceof MediaFailure ? error.code : 'MEDIA_UNAVAILABLE' });
                    }
                }
                return { items, deletedCount: items.filter(item => item.deleted).length, retainedCount: items.filter(item => !item.deleted).length };
            });
        },
    };
    api.definition.capabilities[0].constraints = { referenceAnalysis: 'consumer-providers', deletion: 'reference-aware', automaticGc: false };
    return api;
}
