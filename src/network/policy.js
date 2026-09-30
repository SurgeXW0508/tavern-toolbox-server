import { lstat, readFile, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isIP, createServer } from 'node:net';
import { validatePolicy, policyRevision } from '../config.js';
import { canonicalHost, NetworkFailure } from './destination.js';

const fail = code => { throw new NetworkFailure(code); };

const supportsProcessLock = () => process.platform === 'win32' || process.platform === 'linux'
    && (Number(process.versions.node.split('.')[0]) > 20 || Number(process.versions.node.split('.')[0]) === 20
        && Number(process.versions.node.split('.')[1]) >= 8);

// The kernel owns this mutex, so SIGKILL, container exit and reboot release it.
// No filesystem lease, age threshold or stale-path deletion can steal a live lock.
// A deployment still has one active ST instance; Linux abstract sockets are scoped
// to its network namespace, not a distributed lock across shared-volume containers.
async function acquireProcessLock(configPath) {
    if (!supportsProcessLock()) fail('POLICY_MANAGEMENT_UNAVAILABLE');
    const directory = await lstat(path.dirname(configPath), { bigint: true });
    // Directory identity is stable across atomic replacement of the config itself.
    const key = createHash('sha256').update(`${directory['dev']}:${directory.ino}:${path.basename(configPath)}`).digest('hex');
    const endpoint = process.platform === 'linux' ? `\0ttb-policy-${key}` : `\\\\.\\pipe\\ttb-policy-${key}`;
    const lock = createServer(socket => socket.destroy());
    await new Promise((resolve, reject) => {
        const failed = error => reject(new NetworkFailure(error.code === 'EADDRINUSE' ? 'POLICY_BUSY' : 'POLICY_READ_ONLY'));
        lock.once('error', failed);
        lock.listen({ path: endpoint, exclusive: true }, () => {
            lock.off('error', failed); lock.on('error', () => {}); resolve();
        });
    });
    return () => new Promise(resolve => lock.close(resolve));
}

export function managedHost(value) {
    if (typeof value !== 'string' || value.length > 255 || /[\s/\\:@?#\[\]\u0000-\u001f\u007f]/.test(value))
        fail('INVALID_HOST');
    const wildcard = value.startsWith('*.');
    let host;
    try { host = canonicalHost(wildcard ? value.slice(2) : value); }
    catch { fail('INVALID_HOST'); }
    if (isIP(host) || !host.includes('.') || /(?:^|\.)(?:localhost|local|internal)$/.test(host)
        || host.endsWith('.home.arpa')) fail('INVALID_HOST');
    return wildcard ? `*.${host}` : host;
}

// Only the existing default deployment file is writable. Explicit external paths
// remain authoritative and read-only; there is no secondary allowlist overlay.
export function createNetworkPolicy(config, network, { persist } = {}) {
    const location = config.management;
    let raw = location?.raw;
    let queue = Promise.resolve();
    async function writableReason() {
        if (config.error || config.policy.networkError || !config.policy.network.enabled
            || config.policy.network.destinationPolicy !== 'allowlist-only') return 'POLICY_MANAGEMENT_UNAVAILABLE';
        if (!location || location.external) return 'POLICY_EXTERNALLY_MANAGED';
        if (!supportsProcessLock()) return 'POLICY_MANAGEMENT_UNAVAILABLE';
        try {
            const [file, directory, current] = await Promise.all([
                lstat(location.path), lstat(path.dirname(location.path)), readFile(location.path, 'utf8'),
            ]);
            if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1 || !(file.mode & 0o222)
                || !directory.isDirectory() || !(directory.mode & 0o222) || !(directory.mode & 0o111))
                return 'POLICY_READ_ONLY';
            if (current !== raw) return 'POLICY_CHANGED_EXTERNALLY';
            return null;
        } catch { return 'POLICY_READ_ONLY'; }
    }
    async function view(context) {
        const reason = await writableReason();
        return { revision: policyRevision(config), destinationPolicy: config.policy.network.destinationPolicy || 'allowlist-only',
            transport: config.policy.network.transport || 'none', allowlistEntryCount: config.policy.network.allowlist?.length || 0,
            administrator: context.isAdmin === true, canManage: context.isAdmin === true && !reason,
            readOnlyReason: reason || (context.isAdmin ? null : 'ADMIN_REQUIRED'),
            ...(context.isAdmin ? { hosts: [...(config.policy.network.allowlist || [])] } : {}) };
    }
    async function write(nextRaw, activate) {
        if (persist) return persist(nextRaw, activate);
        const parent = path.dirname(location.path), nonce = randomUUID();
        const nextPath = path.join(parent, `.ttb-policy-${nonce}.next`);
        const oldPath = path.join(parent, `.ttb-policy-${nonce}.previous`);
        let replaced = false;
        const stage = async (filePath, contents) => {
            const file = await open(filePath, 'wx', 0o600);
            try { await file.writeFile(contents, 'utf8'); await file.sync(); }
            finally { await file.close(); }
        };
        const syncDirectory = async () => {
            const directory = await open(parent, 'r');
            try { await directory.sync(); } finally { await directory.close(); }
        };
        try {
            await stage(nextPath, nextRaw);
            await stage(oldPath, raw);
            if (await writableReason()) fail('POLICY_CONFLICT');
            await rename(nextPath, location.path); replaced = true;
            await syncDirectory();
            activate();
        } catch (error) {
            if (replaced) { await rename(oldPath, location.path); await syncDirectory(); }
            throw error;
        } finally {
            await unlink(nextPath).catch(() => {});
            await unlink(oldPath).catch(() => {});
        }
    }
    async function mutate(context, operation, body) {
        if (!context.isAdmin) fail('ADMIN_REQUIRED');
        if (typeof body?.revision !== 'string' || body.revision.length > 128) fail('INVALID_REQUEST');
        if (body.revision !== policyRevision(config)) fail('POLICY_CONFLICT');
        const reason = await writableReason();
        if (reason) fail(reason);
        const host = managedHost(body.host);
        if (operation === 'add' && typeof body.includeSubdomains !== 'boolean') fail('INVALID_REQUEST');
        if (host.startsWith('*.') && body.includeSubdomains) fail('INVALID_HOST');
        const list = [...config.policy.network.allowlist];
        if (operation === 'add') {
            const additions = [host, ...(body.includeSubdomains ? [`*.${host}`] : [])].filter(item => !list.includes(item));
            if (!additions.length) fail('HOST_ALREADY_ALLOWED');
            list.push(...additions);
            if (list.length > 128) fail('ALLOWLIST_FULL');
        } else {
            const index = list.indexOf(host);
            if (index < 0) fail('HOST_NOT_FOUND');
            list.splice(index, 1);
        }
        const document = JSON.parse(raw);
        document.network.allowlist = list;
        const next = validatePolicy(document);
        if (next.networkError) fail('INVALID_REQUEST');
        let activate;
        try { activate = network.preparePolicy(next.network); }
        catch { fail('POLICY_ACTIVATION_FAILED'); }
        const nextRaw = JSON.stringify(document, null, 2) + '\n';
        let release;
        try { release = await acquireProcessLock(location.path); }
        catch (error) { if (error instanceof NetworkFailure) throw error; fail('POLICY_READ_ONLY'); }
        try {
            // A different instance may have committed while this one validated.
            // Even injected persistence paths must recheck under the mutex.
            if (await writableReason()) fail('POLICY_CONFLICT');
            await write(nextRaw, () => {
                activate();
                config.policy = next;
                raw = nextRaw;
            });
        } catch (error) {
            if (error instanceof NetworkFailure) throw error;
            fail('POLICY_PERSISTENCE_FAILED');
        } finally { await release(); }
        return view(context);
    }
    return { read: view,
        mutate(context, operation, body) {
            const pending = queue.then(() => mutate(context, operation, body));
            queue = pending.catch(() => {});
            return pending;
        },
        capability: { id: 'network.policy', contract: { major: 1, minMinor: 0, maxMinor: 0 },
            operations: ['read', 'add', 'remove'].map(id => ({ id, available: true })),
            operationAvailability: async context => {
                const reason = context?.isAdmin ? await writableReason() : 'ADMIN_REQUIRED';
                return { add: { available: !reason, reasonCode: reason }, remove: { available: !reason, reasonCode: reason } };
            }, limits: { maxHosts: 128 }, constraints: { authority: 'deployment', managedFields: ['allowlist'] } },
    };
}
