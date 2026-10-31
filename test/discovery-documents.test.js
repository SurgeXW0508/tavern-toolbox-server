import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAccountDocuments } from '../src/account-documents/store.js';
import { validateDiscoverySettings, validateDiscoveryPrompts, DISCOVERY_LIMITS } from '../src/account-documents/worldbook-discovery.js';
const settings = () => ({ promptId: 'balanced', connectionId: '', count: 3, historyDepth: 6, contextBudget: 16384,
    extractRules: [], excludeRules: [], includeStorySummary: false, includeMvu: false, includeWorldbook: false, worldbookMode: 'matched', worldbookSelections: {} });
const scheme = (id = 'example') => ({ id, name: 'Synthetic', description: '', prompt: 'Synthetic principles', schemaVersion: 2, factory: false,
    createdAt: 1, updatedAt: 2, blocks: Object.entries({ principles: 'system', worldbook: 'system', summary: 'system', history: 'history', mvu: 'system', candidates: 'system', request: 'user_input' })
        .map(([type, role]) => ({ id: type, type, role, name: type, ...(type === 'principles' ? { content: 'Synthetic principles' } : {}) })) });
test('Discovery validators enforce exact settings, all range/selection bounds and no unknown fields', () => {
    assert.deepEqual(validateDiscoverySettings(settings()), settings());
    const cases = [p => p.extra = true, p => p.count = 101, p => p.historyDepth = 0, p => p.contextBudget = 4095,
        p => p.connectionId = '../connection', p => p.promptId = '', p => p.includeMvu = 1, p => p.worldbookMode = 'guess',
        p => p.extractRules = Array.from({ length: 41 }, () => ({ start: '<x>', end: '</x>' })),
        p => p.excludeRules = [{ start: 'x'.repeat(201), end: 'e' }], p => p.extractRules = [{ start: 's', end: 'e', extra: 1 }],
        p => p.worldbookSelections = { Example: ['1', '1'] }, p => p.worldbookSelections = { Example: [1] },
        p => p.worldbookSelections = { Example: Array.from({ length: 513 }, (_, i) => String(i)) },
        p => p.worldbookSelections = Object.fromEntries(Array.from({ length: 129 }, (_, i) => ['Book' + i, ['1']])),
        p => p.worldbookSelections = Object.fromEntries(Array.from({ length: 9 }, (_, i) => ['Book' + i, Array.from({ length: 512 }, (_, j) => String(j))]))];
    for (const mutate of cases) { const p = settings(); mutate(p); assert.throws(() => validateDiscoverySettings(p), { code: 'DOCUMENT_INVALID' }); }
    const p = settings(); p.worldbookSelections = Object.fromEntries(Array.from({ length: 8 }, (_, i) => ['Book' + i, Array.from({ length: 512 }, (_, j) => String(j).padStart(128, 'x'))]));
    assert.throws(() => validateDiscoverySettings(p), { code: 'DOCUMENT_TOO_LARGE' });
});
test('Prompt validator preserves 107 ordered blocks and rejects invalid IDs/roles/duplicates/factories', () => {
    const valid = { schemes: [scheme()] };
    for (let i = 0; i < 100; i++) valid.schemes[0].blocks.push({ id: 'custom-' + i, type: 'custom', name: '', role: 'assistant', content: 'synthetic' });
    assert.equal(validateDiscoveryPrompts(valid).schemes[0].blocks.length, 107);
    const cases = [p => p.extra = true, p => p.schemes.push(p.schemes[0]), p => p.schemes[0].id = 'balanced',
        p => p.schemes[0].factory = true, p => p.schemes[0].description = 'x'.repeat(181), p => p.schemes[0].name = 'x'.repeat(81),
        p => p.schemes[0].blocks[0].content = 'different', p => p.schemes[0].blocks[0].role = 'user',
        p => p.schemes[0].blocks.push(p.schemes[0].blocks[0]), p => p.schemes[0].blocks.pop(),
        p => p.schemes[0].blocks.push({ id: 'c', type: 'custom', role: 'tool', name: '', content: 'x' }),
        p => p.schemes[0].blocks.push({ id: 'c', type: 'custom', role: 'system', name: '', content: 'x'.repeat(30001) })];
    for (const mutate of cases) { const p = { schemes: [scheme()] }; mutate(p); assert.throws(() => validateDiscoveryPrompts(p), { code: 'DOCUMENT_INVALID' }); }
    const large = scheme(); for (let i = 0; i < 20; i++) large.blocks.push({ id: 'c' + i, type: 'custom', name: '', role: 'user', content: 'x'.repeat(30000) });
    assert.throws(() => validateDiscoveryPrompts({ schemes: [large] }), { code: 'DOCUMENT_TOO_LARGE' });
    const many = Array.from({ length: 80 }, (_, i) => ({ ...scheme('s' + i), prompt: 'x'.repeat(30000), blocks: scheme().blocks.map((b, j) => j ? b : { ...b, content: 'x'.repeat(30000) }) }));
    assert.throws(() => validateDiscoveryPrompts({ schemes: many }), { code: 'DOCUMENT_TOO_LARGE' });
    assert.equal(DISCOVERY_LIMITS.maxLibraryBytes, 2 * 1024 * 1024);
});
test('two registered Discovery documents keep independent CAS, coexist with Outfit and survive stopped restore', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'ttb-discovery-docs-')); t.after(() => rm(root, { recursive: true, force: true }));
    const config = { policy: { core: { allowedOrigins: [] } } }, user = { userRoot: path.join(root, 'synthetic-user') };
    let store = createAccountDocuments(config); await store.definition.initialize(); t.after(() => store.definition.shutdown());
    const write = (id, payload, revision = 0) => store.commit(user, id, { schemaVersion: 1, expectedRevision: revision, payload });
    assert.equal(store.definition.capabilities[0].operationAvailability().commit.available, false);
    assert.deepEqual([...store.consumers.keys()], ['outfit-settings', 'worldbook-discovery-settings', 'worldbook-discovery-prompts']);
    await write('worldbook-discovery-prompts', { schemes: [scheme()] });
    await write('worldbook-discovery-settings', { ...settings(), promptId: 'example' });
    await write('worldbook-discovery-settings', { ...settings(), historyDepth: 20 }, 1);
    await assert.rejects(write('worldbook-discovery-settings', settings(), 1), { code: 'REVISION_CONFLICT' });
    assert.equal((await store.read(user, 'worldbook-discovery-prompts', 1)).revision, 1);
    assert.equal((await store.read(user, 'outfit-settings', 1)).revision, 0);
    const file = path.join(user.userRoot, 'tavern-toolbox-server/account-documents-v1/documents.sqlite');
    store.definition.shutdown(); await copyFile(file, path.join(root, 'backup.sqlite'));
    store = createAccountDocuments(config); await store.definition.initialize();
    await write('worldbook-discovery-prompts', { schemes: [] }, 1); store.definition.shutdown();
    await copyFile(path.join(root, 'backup.sqlite'), file); store = createAccountDocuments(config); await store.definition.initialize();
    assert.equal((await store.read(user, 'worldbook-discovery-settings', 1)).payload.historyDepth, 20);
    assert.equal((await store.read(user, 'worldbook-discovery-prompts', 1)).payload.schemes[0].id, 'example');
});
