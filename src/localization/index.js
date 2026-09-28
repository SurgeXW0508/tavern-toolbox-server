import { createHash, randomUUID } from 'node:crypto';
import { readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { BusinessStore, BusinessFailure } from '../business/store.js';

const NAMESPACE = 'character-localization';
const SCHEMA = 1;
const MAX_SCOPES = 2000;
const MAX_BINDINGS = 5000;
const HOST_ID = /^[^/\\\u0000-\u001f\u007f]{1,240}\.png$/i;
const KEY = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f-]{36}$/i;
const empty = () => ({ scopes: [] });
const fail = code => { throw new BusinessFailure(code); };

function validate(document) {
    if (!document || Object.keys(document).join(',') !== 'scopes'
        || !Array.isArray(document.scopes) || document.scopes.length > MAX_SCOPES)
        fail('LOCALIZATION_DATA_INVALID');
    const ids = new Set(), hosts = new Set(), proofs = new Set();
    let count = 0;
    for (const scope of document.scopes) {
        if (!scope || Object.keys(scope).sort().join(',') !== 'bindings,createdAt,detachedAt,displayName,hostId,id,proof'
            || !UUID.test(scope.id || '') || ids.has(scope.id)
            || typeof scope.displayName !== 'string' || scope.displayName.length > 160
            || typeof scope.createdAt !== 'string' || !scope.createdAt
            || typeof scope.detachedAt !== 'string' && scope.detachedAt !== null
            || !Array.isArray(scope.bindings)) fail('LOCALIZATION_DATA_INVALID');
        ids.add(scope.id);
        if (scope.hostId !== null || scope.proof !== null) {
            if (!HOST_ID.test(scope.hostId || '') || !KEY.test(scope.proof || '')
                || scope.detachedAt !== null || hosts.has(scope.hostId) || proofs.has(scope.proof))
                fail('LOCALIZATION_DATA_INVALID');
            hosts.add(scope.hostId); proofs.add(scope.proof);
        } else if (!scope.detachedAt) fail('LOCALIZATION_DATA_INVALID');
        const keys = new Set();
        for (const binding of scope.bindings) {
            if (!binding || Object.keys(binding).sort().join(',') !== 'locatorKey,mediaRef'
                || !binding.mediaRef || Object.keys(binding.mediaRef).sort().join(',') !== 'assetId,provider'
                || !KEY.test(binding.locatorKey || '') || keys.has(binding.locatorKey)
                || binding.mediaRef?.provider !== 'server' || !UUID.test(binding.mediaRef.assetId || ''))
                fail('LOCALIZATION_DATA_INVALID');
            keys.add(binding.locatorKey); count++;
        }
    }
    if (count > MAX_BINDINGS) fail('LOCALIZATION_DATA_INVALID');
}

// An avatar filename is reusable after deletion. Its filesystem incarnation is
// required for automatic continuity; uncertain identities become detached.
async function inventory(userRoot) {
    const characters = path.join(userRoot, 'characters');
    const result = new Map();
    for (const file of await readdir(characters)) {
        if (!HOST_ID.test(file)) continue;
        const info = await lstat(path.join(characters, file), { bigint: true });
        if (!info.isFile() || info.birthtimeNs <= 0n || info.ino <= 0n) continue;
        const proof = createHash('sha256').update(JSON.stringify([
            String(info.dev), String(info.ino), String(info.birthtimeNs)])).digest('hex');
        result.set(file, proof);
    }
    return result;
}

function reconcile(document, current) {
    let changed = false;
    const byProof = new Map([...current].map(([id, proof]) => [proof, id]));
    for (const scope of document.scopes) {
        if (!scope.proof) continue;
        const id = byProof.get(scope.proof);
        if (!id) {
            scope.hostId = null; scope.proof = null;
            scope.detachedAt = new Date().toISOString();
            changed = true;
        } else if (scope.hostId !== id) {
            scope.hostId = id;
            changed = true;
        }
    }
    return changed;
}

function safeView(snapshot, hostId) {
    const current = snapshot.document.scopes.find(scope => scope.hostId === hostId) || null;
    return { revision: snapshot.revision,
        current: current ? { id: current.id, displayName: current.displayName, bindings: current.bindings } : null,
        detached: snapshot.document.scopes.filter(scope => scope.detachedAt !== null)
            .map(scope => ({ id: scope.id, displayName: scope.displayName,
                detachedAt: scope.detachedAt, bindingCount: scope.bindings.length })) };
}

export function createLocalization(media) {
    let DatabaseSync, unavailable = false, stopped = false;
    const stores = new Map();
    async function getStore(context) {
        if (stopped || unavailable || !context?.userRoot) fail('LOCALIZATION_UNAVAILABLE');
        if (!stores.has(context.userRoot)) {
            stores.set(context.userRoot, (async () => {
                const target = new BusinessStore(context.userRoot, DatabaseSync);
                await target.initialize();
                return target;
            })());
        }
        try { return await stores.get(context.userRoot); }
        catch { stores.delete(context.userRoot); fail('LOCALIZATION_UNAVAILABLE'); }
    }
    async function snapshot(context) {
        const target = await getStore(context);
        const current = await inventory(context.userRoot);
        let result = target.read(NAMESPACE, empty(), SCHEMA);
        validate(result.document);
        const document = structuredClone(result.document);
        if (reconcile(document, current)) {
            try { result = target.commit(NAMESPACE, SCHEMA, result.revision, document, validate); }
            catch (error) {
                if (!(error instanceof BusinessFailure) || error.code !== 'BUSINESS_CONFLICT') throw error;
                result = target.read(NAMESPACE, empty(), SCHEMA);
                validate(result.document);
            }
        }
        return { target, current, result };
    }
    function requireHost(current, hostId) {
        if (!HOST_ID.test(hostId || '') || !current.has(hostId)) fail('HOST_IDENTITY_UNAVAILABLE');
        return current.get(hostId);
    }
    return {
        definition: { id: 'localization', version: '0.1.0', dependsOn: ['core', 'media'],
            capabilities: [{ id: 'localization.characters', contract: { major: 1, minMinor: 0, maxMinor: 0 },
                operations: ['read', 'resolve', 'localize', 'unlocalize', 'rebind'].map(id => ({ id, available: true })),
                constraints: { schemaVersion: SCHEMA, mediaProvider: 'server', identity: 'host-incarnation' } }],
            initialize: async () => {
                try {
                    const [major, minor] = process.versions.node.split('.').map(Number);
                    if (major < 22 || major === 22 && minor < 13) throw new Error('RUNTIME_UNSUPPORTED');
                    ({ DatabaseSync } = await import('node:sqlite'));
                } catch { unavailable = true; throw new Error('LOCALIZATION_RUNTIME_UNAVAILABLE'); }
            },
            health: async context => {
                try { await getStore(context); return { state: 'ready' }; }
                catch { return { state: 'unavailable', reasonCode: 'LOCALIZATION_UNAVAILABLE' }; }
            },
            shutdown: async () => {
                stopped = true;
                for (const pending of stores.values()) { try { (await pending).close(); } catch {} }
                stores.clear();
            },
        },
        async read(context, hostId) {
            const { current, result } = await snapshot(context);
            requireHost(current, hostId);
            return safeView(result, hostId);
        },
        async resolve(context, hostId, url) {
            const { current, result } = await snapshot(context);
            requireHost(current, hostId);
            const key = locatorKey(url);
            const scope = result.document.scopes.find(item => item.hostId === hostId);
            return { scopeId: scope?.id || null,
                mediaRef: scope?.bindings.find(item => item.locatorKey === key)?.mediaRef || null };
        },
        async localize(context, { hostId, displayName, url, revision }, signal) {
            // Import first. A failed import or a later CAS conflict never changes a binding.
            const key = locatorKey(url);
            const before = await snapshot(context);
            const proof = requireHost(before.current, hostId);
            if (before.result.revision !== revision) fail('LOCALIZATION_CONFLICT');
            const imported = await media.remoteImport(context, url, signal);
            const after = await snapshot(context);
            if (after.result.revision !== revision || requireHost(after.current, hostId) !== proof)
                fail('LOCALIZATION_CONFLICT');
            const document = structuredClone(after.result.document);
            let scope = document.scopes.find(item => item.hostId === hostId);
            if (!scope) {
                scope = { id: randomUUID(), hostId, proof, displayName: String(displayName || '').slice(0, 160),
                    createdAt: new Date().toISOString(), detachedAt: null, bindings: [] };
                document.scopes.push(scope);
            }
            const mediaRef = imported.mediaRef;
            const prior = scope.bindings.find(item => item.locatorKey === key);
            if (prior) prior.mediaRef = mediaRef;
            else scope.bindings.push({ locatorKey: key, mediaRef });
            const committed = after.target.commit(NAMESPACE, SCHEMA, revision, document, validate);
            return { ...safeView(committed, hostId), mediaRef };
        },
        async unlocalize(context, { hostId, url, revision }) {
            const key = locatorKey(url);
            const { target, current, result } = await snapshot(context);
            requireHost(current, hostId);
            if (result.revision !== revision) fail('LOCALIZATION_CONFLICT');
            const document = structuredClone(result.document);
            const scope = document.scopes.find(item => item.hostId === hostId);
            if (!scope) fail('LOCALIZATION_NOT_FOUND');
            scope.bindings = scope.bindings.filter(item => item.locatorKey !== key);
            const committed = target.commit(NAMESPACE, SCHEMA, revision, document, validate);
            return safeView(committed, hostId);
        },
        async rebind(context, { hostId, displayName, scopeId, revision }) {
            const { target, current, result } = await snapshot(context);
            const proof = requireHost(current, hostId);
            if (result.revision !== revision) fail('LOCALIZATION_CONFLICT');
            const document = structuredClone(result.document);
            const existing = document.scopes.find(item => item.hostId === hostId);
            if (existing?.bindings.length) fail('LOCALIZATION_SCOPE_CONFLICT');
            const targetScope = document.scopes.find(item => item.id === scopeId && item.detachedAt !== null);
            if (!targetScope) fail('LOCALIZATION_NOT_FOUND');
            if (existing) document.scopes = document.scopes.filter(item => item !== existing);
            targetScope.hostId = hostId; targetScope.proof = proof; targetScope.detachedAt = null;
            targetScope.displayName = String(displayName || targetScope.displayName).slice(0, 160);
            const committed = target.commit(NAMESPACE, SCHEMA, revision, document, validate);
            return safeView(committed, hostId);
        },
    };
}

function locatorKey(url) {
    if (typeof url !== 'string' || url.length > 2048) fail('INVALID_REQUEST');
    let parsed;
    try { parsed = new URL(url); } catch { fail('INVALID_REQUEST'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
        || parsed.hash || parsed.href !== url) fail('INVALID_REQUEST');
    return createHash('sha256').update(url).digest('hex');
}
