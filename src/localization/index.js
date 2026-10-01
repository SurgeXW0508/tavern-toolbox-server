import { createHash, randomUUID } from 'node:crypto';
import { readdir, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { BusinessStore, BusinessFailure } from '../business/store.js';

const NAMESPACE = 'character-localization-v2';
const LEGACY_NAMESPACE = 'character-localization';
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
    const ids = new Set(), hosts = new Set();
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
                || scope.detachedAt !== null || hosts.has(scope.hostId))
                fail('LOCALIZATION_DATA_INVALID');
            hosts.add(scope.hostId);
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

// SillyTavern 1.19.0 atomically replaces PNGs on an ordinary edit, and copies
// PNGs for Duplicate. Its tEXt chara/ccv3 metadata retains create_date on edit
// and assigns a new value on import. The host filename deliberately participates
// in the proof: rename requires explicit rebind rather than a guessed match.
async function hostProof(userRoot, hostId) {
    if (!HOST_ID.test(hostId || '')) return null;
    let file;
    try {
        file = await open(path.join(userRoot, 'characters', hostId), constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > 128 * 1024 * 1024) return null;
        const header = Buffer.alloc(8);
        if ((await file.read(header, 0, 8, 0)).bytesRead !== 8
            || !header.equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return null;
        let offset = 8, metadata = null;
        const chunk = Buffer.alloc(8);
        while (offset + 12 <= stat.size) {
            if ((await file.read(chunk, 0, 8, offset)).bytesRead !== 8) return null;
            const length = chunk.readUInt32BE(0), type = chunk.toString('ascii', 4, 8);
            if (offset + 12 + length > stat.size) return null;
            if (type === 'tEXt' && length <= 2 * 1024 * 1024) {
                const data = Buffer.alloc(length);
                if ((await file.read(data, 0, length, offset + 8)).bytesRead !== length) return null;
                const separator = data.indexOf(0);
                const name = data.toString('latin1', 0, separator).toLowerCase();
                if (separator > 0 && (name === 'chara' || name === 'ccv3')) {
                    const encoded = data.toString('latin1', separator + 1);
                    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) return null;
                    const parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
                    if (name === 'ccv3' || metadata === null) metadata = parsed;
                }
            }
            offset += length + 12;
            if (type === 'IEND') break;
        }
        const date = metadata?.create_date;
        if (typeof date !== 'string' || !date || date.length > 128) return null;
        return createHash('sha256').update(JSON.stringify([hostId, date])).digest('hex');
    } catch { return null; }
    finally { await file?.close(); }
}

async function inventory(userRoot) {
    const result = new Map();
    for (const file of await readdir(path.join(userRoot, 'characters'))) {
        if (!HOST_ID.test(file)) continue;
        const proof = await hostProof(userRoot, file);
        if (proof) result.set(file, proof);
    }
    return result;
}

function reconcile(document, current) {
    let changed = false;
    for (const scope of document.scopes) {
        if (!scope.proof) continue;
        if (current.get(scope.hostId) !== scope.proof) {
            scope.hostId = null; scope.proof = null;
            scope.detachedAt = new Date().toISOString();
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
    const migrations = new Map();
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
    async function migrate(context, target) {
        if (migrations.has(context.userRoot)) return migrations.get(context.userRoot);
        const pending = (async () => {
        // The old inode-based proof is incompatible with atomic host rewrites.
        // Preserve its bindings as detached scopes, requiring a conscious rebind.
        const fresh = target.read(NAMESPACE, empty(), SCHEMA);
        if (fresh.revision === 0) {
            const legacy = target.read(LEGACY_NAMESPACE, empty(), SCHEMA);
            if (legacy.revision) {
                validate(legacy.document);
                const document = structuredClone(legacy.document);
                for (const scope of document.scopes) {
                    scope.hostId = null; scope.proof = null;
                    scope.detachedAt ||= new Date().toISOString();
                }
                try { target.commit(NAMESPACE, SCHEMA, 0, document, validate); }
                catch (error) {
                    if (!(error instanceof BusinessFailure) || error.code !== 'BUSINESS_CONFLICT') throw error;
                }
            }
        }
        })();
        migrations.set(context.userRoot, pending);
        try { await pending; }
        finally { migrations.delete(context.userRoot); }
    }
    async function snapshot(context) {
        const target = await getStore(context);
        await migrate(context, target);
        const current = await inventory(context.userRoot);
        for (let attempt = 0; attempt < 3; attempt++) {
            const result = target.read(NAMESPACE, empty(), SCHEMA);
            validate(result.document);
            const document = structuredClone(result.document);
            if (!reconcile(document, current)) return { target, current, result };
            try {
                const committed = target.commit(NAMESPACE, SCHEMA, result.revision, document, validate);
                return { target, current, result: committed };
            } catch (error) {
                if (!(error instanceof BusinessFailure) || error.code !== 'BUSINESS_CONFLICT') throw error;
            }
        }
        fail('LOCALIZATION_CONFLICT');
    }
    function requireHost(current, hostId) {
        if (!HOST_ID.test(hostId || '') || !current.has(hostId)) fail('HOST_IDENTITY_UNAVAILABLE');
        return current.get(hostId);
    }
    return {
        definition: { id: 'localization', version: '0.1.0', dependsOn: ['core', 'media'],
            capabilities: [{ id: 'localization.characters', contract: { major: 1, minMinor: 0, maxMinor: 0 },
                operations: ['read', 'resolve', 'localize', 'unlocalize', 'rebind', 'forget'].map(id => ({ id, available: true })),
                constraints: { schemaVersion: SCHEMA, mediaProvider: 'server', identity: 'host-filename-create-date' } }],
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
            const target = await getStore(context);
            await migrate(context, target);
            const result = target.read(NAMESPACE, empty(), SCHEMA);
            validate(result.document);
            const key = locatorKey(url);
            const proof = await hostProof(context.userRoot, hostId);
            // A missing host marker disables Character binding, not transient
            // Network access. The Catalog is still read first so an unavailable
            // Localization module cannot be mistaken for an unbound image.
            if (!proof) return { scopeId: null, mediaRef: null, identityAvailable: false };
            const scope = result.document.scopes.find(item => item.hostId === hostId && item.proof === proof);
            const mediaRef = scope?.bindings.find(item => item.locatorKey === key)?.mediaRef || null;
            return { scopeId: scope?.id || null, mediaRef, identityAvailable: true };
        },
        async localize(context, { hostId, displayName, url, revision }, signal) {
            // Import first. A failed import or a later CAS conflict never changes a binding.
            if (typeof displayName !== 'string' || displayName.length > 160) fail('INVALID_REQUEST');
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
                scope = { id: randomUUID(), hostId, proof, displayName,
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
        async forget(context, { hostId, scopeId, revision }) {
            if (!UUID.test(scopeId || '')) fail('INVALID_REQUEST');
            const { target, result } = await snapshot(context);
            if (result.revision !== revision) fail('LOCALIZATION_CONFLICT');
            const document = structuredClone(result.document);
            const scope = document.scopes.find(item => item.id === scopeId);
            if (!scope || scope.detachedAt === null) fail('LOCALIZATION_NOT_FOUND');
            document.scopes = document.scopes.filter(item => item !== scope);
            const committed = target.commit(NAMESPACE, SCHEMA, revision, document, validate);
            return safeView(committed, hostId);
        },
        async rebind(context, { hostId, displayName, scopeId, revision }) {
            if (typeof displayName !== 'string' || displayName.length > 160 || !UUID.test(scopeId || ''))
                fail('INVALID_REQUEST');
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
            targetScope.displayName = displayName || targetScope.displayName;
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
