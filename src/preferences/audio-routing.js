import path from 'node:path';
import { mkdir } from 'node:fs/promises';

export const MAX_AUDIO_HOSTS = 128;
export class PreferenceFailure extends Error {
    constructor(code) { super(code); this.code = code; }
}
const fail = code => { throw new PreferenceFailure(code); };

// Wire/storage accepts canonical hostnames only. URL paste normalization belongs
// to the client; a URL, credential, path or token can never enter this database.
export function validAudioHost(host) {
    const valid = typeof host === 'string' && host.length <= 253 && host.includes('.')
        && !/^[\d.]+$/.test(host) && !/(?:^|\.)(?:localhost|local|internal)$/.test(host)
        && !host.endsWith('.home.arpa') && host.split('.').every(label => label.length <= 63
            && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label));
    if (!valid) return false;
    try { return new URL('https://' + host).hostname === host; } catch { return false; }
}

class AudioRoutingStore {
    constructor(root, DatabaseSync) {
        this.root = path.join(root, 'tavern-toolbox-server', 'preferences-v1');
        this.DatabaseSync = DatabaseSync;
    }
    async initialize() {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const db = new this.DatabaseSync(path.join(this.root, 'audio-routing.sqlite'));
        try {
            db.exec('PRAGMA busy_timeout = 1000; PRAGMA synchronous = FULL;');
            const version = db.prepare('PRAGMA user_version').get().user_version;
            if (version > 1) fail('PREFERENCE_SCHEMA_INCOMPATIBLE');
            if (version === 0) {
                if (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n)
                    fail('PREFERENCE_DATA_INVALID');
                db.exec(`BEGIN IMMEDIATE;
                    CREATE TABLE hosts (hostname TEXT NOT NULL PRIMARY KEY);
                    CREATE TABLE state (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL);
                    INSERT INTO state VALUES (1, 0);
                    PRAGMA user_version = 1;
                    COMMIT;`);
            }
            this.db = db;
            this.read();
        } catch (error) { db.close(); throw error; }
    }
    read() {
        // Hosts and revision must describe the same committed state, even
        // when another connection is concurrently editing this user's file.
        this.db.exec('BEGIN');
        try { const result = this.snapshot(); this.db.exec('COMMIT'); return result; }
        catch (error) { this.db.exec('ROLLBACK'); throw error; }
    }
    snapshot() {
        const hosts = this.db.prepare('SELECT hostname FROM hosts ORDER BY hostname LIMIT 129').all().map(row => row.hostname);
        const revision = this.db.prepare('SELECT revision FROM state WHERE id = 1').get()?.revision;
        if (hosts.length > MAX_AUDIO_HOSTS || !hosts.every(validAudioHost) || !Number.isSafeInteger(revision) || revision < 0)
            fail('PREFERENCE_DATA_INVALID');
        return { schemaVersion: 1, revision, hosts };
    }
    mutate(operation, hosts) {
        let begun = false;
        try {
            this.db.exec('BEGIN IMMEDIATE'); begun = true;
            const current = this.snapshot();
            const next = new Set(current.hosts);
            for (const host of hosts) operation === 'add' ? next.add(host) : next.delete(host);
            if (next.size > MAX_AUDIO_HOSTS) fail('ROUTING_HOSTS_FULL');
            const changed = next.size !== current.hosts.length || current.hosts.some(host => !next.has(host));
            if (changed) {
                if (current.revision >= Number.MAX_SAFE_INTEGER) fail('PREFERENCE_DATA_INVALID');
                const statement = this.db.prepare(operation === 'add'
                    ? 'INSERT OR IGNORE INTO hosts (hostname) VALUES (?)' : 'DELETE FROM hosts WHERE hostname = ?');
                for (const host of hosts) statement.run(host);
                this.db.prepare('UPDATE state SET revision = ? WHERE id = 1').run(current.revision + 1);
            }
            const result = this.snapshot();
            this.db.exec('COMMIT'); begun = false;
            return result;
        } catch (error) {
            if (begun) this.db.exec('ROLLBACK');
            throw error;
        }
    }
    close() { this.db.close(); }
}

export function createAudioRoutingPreferences(config) {
    const stores = new Map(), failures = new Map();
    let DatabaseSync, runtimeError = null, stopped = false;
    async function store(context) {
        if (stopped || !DatabaseSync || !context?.userRoot) fail(runtimeError || 'PREFERENCE_UNAVAILABLE');
        if (!stores.has(context.userRoot)) stores.set(context.userRoot, (async () => {
            const item = new AudioRoutingStore(context.userRoot, DatabaseSync); await item.initialize(); return item;
        })());
        try { const item = await stores.get(context.userRoot); failures.delete(context.userRoot); return item; }
        catch (error) {
            stores.delete(context.userRoot);
            failures.set(context.userRoot, error instanceof PreferenceFailure ? error.code : 'PREFERENCE_STORE_UNAVAILABLE');
            throw error;
        }
    }
    return {
        definition: { id: 'preferences', version: '0.1.0', dependsOn: ['core'],
            capabilities: [{ id: 'preferences.audioRouting', contract: { major: 1, minMinor: 0, maxMinor: 0 },
                operations: ['read', 'add', 'remove'].map(id => ({ id, available: true })),
                operationAvailability: () => Object.fromEntries(['add', 'remove'].map(id => [id,
                    { available: config.policy.core.allowedOrigins.length > 0, reasonCode: 'ORIGIN_POLICY_MISSING' }])),
                limits: { maxHosts: MAX_AUDIO_HOSTS, maxHostnameLength: 253 },
                constraints: { scope: 'st-user', persistence: 'sqlite', hostnameOnly: true,
                    updates: 'atomic-add-remove', allowlist: 'independent' } }],
            initialize: async () => {
                try { ({ DatabaseSync } = await import('node:sqlite')); }
                catch { runtimeError = 'PREFERENCE_RUNTIME_UNAVAILABLE'; throw new Error(runtimeError); }
            },
            health: async context => {
                try { await store(context); return { state: 'ready', reasonCode: null }; }
                catch { return { state: 'unavailable', reasonCode: runtimeError || failures.get(context?.userRoot) || 'PREFERENCE_STORE_UNAVAILABLE' }; }
            },
            shutdown: async () => {
                stopped = true;
                for (const pending of stores.values()) { try { (await pending).close(); } catch {} }
                stores.clear();
            },
        },
        async read(context) { return (await store(context)).read(); },
        async mutate(context, operation, hosts) {
            if (!['add', 'remove'].includes(operation) || !Array.isArray(hosts) || hosts.length < 1
                || hosts.length > MAX_AUDIO_HOSTS || !hosts.every(validAudioHost)) fail('INVALID_HOST');
            return (await store(context)).mutate(operation, [...new Set(hosts)]);
        },
    };
}
