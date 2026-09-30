import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { loadPolicy } from '../src/config.js';
import { createNetwork } from '../src/network/index.js';
import { createNetworkPolicy } from '../src/network/policy.js';

const admin = { isAdmin: true }, user = { isAdmin: false };
const policy = { schemaVersion: 1, core: { allowedOrigins: ['https://example.invalid'] },
    network: { enabled: true, transport: 'direct', destinationPolicy: 'allowlist-only', allowlist: ['img.example.com'] } };
async function setup(t, options = {}) {
    const dataRoot = await mkdtemp(path.join(tmpdir(), 'ttb-policy-'));
    t.after(() => rm(dataRoot, { recursive: true, force: true }));
    const file = path.join(dataRoot, 'tavern-toolbox-server.config.json');
    await writeFile(file, JSON.stringify(policy));
    const config = await loadPolicy({ dataRoot });
    let opens = 0;
    const network = createNetwork(config, { resolver: { resolve4: async () => ['8.8.8.8'], resolve6: async () => [] },
        open: async () => { opens++; const response = Readable.from([Buffer.from('GIF89a123456789;')]);
            response.statusCode = 200; response.headers = { 'content-type': 'image/gif' };
            return { response, close() {} }; } });
    const manager = createNetworkPolicy(config, network, options);
    return { dataRoot, file, config, network, manager, opens: () => opens };
}

test('admin adds canonical hosts and wildcard, removes them, activates immediately and survives restart', async t => {
    const { file, dataRoot, manager, network, opens } = await setup(t);
    const first = await manager.read(admin);
    assert.equal(first.canManage, true);
    assert.equal((await manager.read(user)).hosts, undefined);
    await assert.rejects(manager.mutate(user, 'add', { host: 'new.example.com', includeSubdomains: false, revision: first.revision }),
        { code: 'ADMIN_REQUIRED' });
    const next = await manager.mutate(admin, 'add', { host: 'NEW.Example.COM.', includeSubdomains: true, revision: first.revision });
    assert.deepEqual(next.hosts, ['img.example.com', 'new.example.com', '*.new.example.com']);
    await network.fetchImage('https://sub.new.example.com/a.gif', 'one');
    await network.fetchImage('https://new.example.com/a.gif', 'one');
    assert.equal(opens(), 2);
    await assert.rejects(manager.mutate(admin, 'remove', { host: 'img.example.com', revision: first.revision }), { code: 'POLICY_CONFLICT' });
    await assert.rejects(manager.mutate(admin, 'add', { host: 'new.example.com', includeSubdomains: false, revision: next.revision }),
        { code: 'HOST_ALREADY_ALLOWED' });
    const removed = await manager.mutate(admin, 'remove', { host: 'new.example.com', revision: next.revision });
    await assert.rejects(network.fetchImage('https://new.example.com/a.gif', 'one'), { code: 'TARGET_NOT_ALLOWED' });
    await network.fetchImage('https://sub.new.example.com/a.gif', 'one');
    assert.deepEqual((await loadPolicy({ dataRoot })).policy.network.allowlist, removed.hosts);
    assert.equal(JSON.parse(await readFile(file)).network.transport, 'direct');
});

test('empty allowlist denies all; IDN canonicalization and concurrent edits never silently overwrite', async t => {
    const { manager, network } = await setup(t);
    const first = await manager.read(admin);
    const empty = await manager.mutate(admin, 'remove', { host: first.hosts[0], revision: first.revision });
    await assert.rejects(network.fetchImage('https://img.example.com/a.gif', 'one'), { code: 'TARGET_NOT_ALLOWED' });
    const results = await Promise.allSettled(['bücher.example', 'other.example'].map(host =>
        manager.mutate(admin, 'add', { host, includeSubdomains: false, revision: empty.revision })));
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(results.find(x => x.status === 'rejected').reason.code, 'POLICY_CONFLICT');
    assert.deepEqual((await manager.read(admin)).hosts, ['xn--bcher-kva.example']);
});

test('invalid host input and private DNS remain blocked after allowlist management', async t => {
    const { manager, config } = await setup(t);
    const first = await manager.read(admin);
    for (const host of ['https://example.com/a?token=x', 'user@example.invalid', 'example.com:443', 'localhost',
        '127.0.0.1', [10, 0, 0, 1].join('.'), '*.localhost', 'x.' + 'local', 'example.com/path', 'bad host.example'])
        await assert.rejects(manager.mutate(admin, 'add', { host, includeSubdomains: false, revision: first.revision }), { code: 'INVALID_HOST' });
    await manager.mutate(admin, 'add', { host: 'private.example', includeSubdomains: false, revision: first.revision });
    let opened = false;
    const unsafe = createNetwork(config, { resolver: { resolve4: async () => [[10, 0, 0, 1].join('.')], resolve6: async () => [] },
        open: async () => { opened = true; } });
    await assert.rejects(unsafe.fetchImage('https://private.example/a.gif', 'one'), { code: 'DNS_UNSAFE' });
    assert.equal(opened, false);
});

test('persistence and activation failures preserve disk, revision and effective old access', async t => {
    for (const kind of ['persist', 'activate']) {
        const { file, config, network } = await setup(t);
        const before = await readFile(file, 'utf8');
        if (kind === 'activate') network.preparePolicy = () => { throw new Error('fixture failure'); };
        const manager = createNetworkPolicy(config, network, kind === 'persist' ? { persist: async () => { throw new Error('disk failure'); } } : {});
        const original = await manager.read(admin);
        await assert.rejects(manager.mutate(admin, 'add', { host: 'new.example.com', includeSubdomains: false, revision: original.revision }),
            { code: kind === 'persist' ? 'POLICY_PERSISTENCE_FAILED' : 'POLICY_ACTIVATION_FAILED' });
        assert.equal(await readFile(file, 'utf8'), before);
        assert.equal((await manager.read(admin)).revision, original.revision);
        await network.fetchImage('https://img.example.com/a.gif', 'one');
        await assert.rejects(network.fetchImage('https://new.example.com/a.gif', 'one'), { code: 'TARGET_NOT_ALLOWED' });
    }
});

test('external, read-only, symlinked or externally changed configuration has no UI overlay writes', async t => {
    const { file, manager, dataRoot, network } = await setup(t);
    const original = await manager.read(admin);
    await chmod(file, 0o444);
    assert.equal((await manager.read(admin)).canManage, false);
    await assert.rejects(manager.mutate(admin, 'remove', { host: original.hosts[0], revision: original.revision }), { code: 'POLICY_READ_ONLY' });
    await chmod(file, 0o600);
    const external = await loadPolicy({ configPath: file });
    assert.equal((await createNetworkPolicy(external, network).read(admin)).readOnlyReason, 'POLICY_EXTERNALLY_MANAGED');
    await writeFile(file, JSON.stringify({ ...policy, network: { ...policy.network, allowlist: ['changed.example'] } }));
    assert.equal((await manager.read(admin)).readOnlyReason, 'POLICY_CHANGED_EXTERNALLY');
    await assert.rejects(manager.mutate(admin, 'remove', { host: original.hosts[0], revision: original.revision }), { code: 'POLICY_CHANGED_EXTERNALLY' });
    await rm(file);
    const other = path.join(dataRoot, 'other.json'); await writeFile(other, JSON.stringify(policy)); await symlink(other, file);
    const linkConfig = await loadPolicy({ dataRoot });
    assert.equal((await createNetworkPolicy(linkConfig, network).read(admin)).canManage, false);
    assert.deepEqual(JSON.parse(await readFile(other)).network.allowlist, ['img.example.com']);
});

test('bounded allowlist refuses overflow without changing disk or active policy', async t => {
    const { dataRoot, file } = await setup(t);
    const document = { ...policy, network: { ...policy.network,
        allowlist: Array.from({ length: 128 }, (_, i) => `img${i}.example.com`) } };
    await writeFile(file, JSON.stringify(document));
    const config = await loadPolicy({ dataRoot });
    const network = createNetwork(config);
    const manager = createNetworkPolicy(config, network);
    const original = await manager.read(admin), disk = await readFile(file, 'utf8');
    await assert.rejects(manager.mutate(admin, 'add', { host: 'new.example.com', includeSubdomains: false, revision: original.revision }),
        { code: 'ALLOWLIST_FULL' });
    assert.equal(await readFile(file, 'utf8'), disk);
    assert.equal((await manager.read(admin)).revision, original.revision);
});
