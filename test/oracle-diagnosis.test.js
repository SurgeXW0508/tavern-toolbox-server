import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createAccountDocuments } from '../src/account-documents/store.js';
import { createAccountRecords } from '../src/account-records/store.js';
import { advisorRecordConsumers } from '../src/account-documents/oracle-advisor.js';
import {
    diagnosisRecordConsumers,
    validateDiagnosisSettings,
    validateDiagnosisRecord,
} from '../src/account-documents/oracle-diagnosis.js';

const config = { policy: { core: { allowedOrigins: ['https://example.test'] } } };
const identity = { kind: 'character', owner: 'Alice.png', chat: 'chat-1' };
const protectedSources = ['diagnosis-rules', 'stat-data', 'latest-update', 'patch-protocol', 'current-input'];

const recipe = () => ({
    version: 1,
    nodes: [
        { id: 'character-card', type: 'source', title: '角色设定', role: 'system', enabled: true, source: 'character-card', options: {} },
        { id: 'main-chat', type: 'source', title: '主聊天记录', role: 'system', enabled: true, source: 'main-chat', options: { depth: 40, includeHidden: false } },
        { id: 'diagnosis-history', type: 'source', title: '本对话历史', role: 'preserve', enabled: true, source: 'diagnosis-history', options: {} },
        ...protectedSources.map(source => ({
            id: source,
            type: 'protected',
            title: source,
            role: source === 'current-input' ? 'user' : 'system',
            enabled: true,
            source,
            options: {},
        })),
    ],
});

const settings = () => ({
    settingsVersion: 4,
    connectionId: '',
    recipe: recipe(),
    promptProfiles: { version: 1, activeId: 'official', items: [] },
});

const thread = (id = 'diag-t-1') => ({
    identity: { ...identity },
    thread: {
        id,
        title: '诊断对话',
        autoTitle: true,
        createdAt: 1,
        updatedAt: 2,
        messages: [
            { id: 'u-1', role: 'user', content: '检查状态表' },
            { id: 'a-1', role: 'assistant', content: '诊断回复', diagnosis: { applyState: 'ready' } },
        ],
    },
});

const loreSelection = () => ({
    identity: { ...identity },
    selection: {
        use: true,
        hybrid: false,
        targetBook: 'WorldA',
        selected: { WorldA: [0, 1, 2] },
    },
});

test('Diagnosis settings validator enforces v4 contract, protected nodes, options and Cloud connection references', () => {
    validateDiagnosisSettings(settings());
    const withCloudAndProfile = settings();
    withCloudAndProfile.connectionId = 'cloud:conn_01';
    withCloudAndProfile.promptProfiles = {
        version: 1,
        activeId: 'custom-1',
        items: [{ id: 'custom-1', name: '严格模式', payload: { recipe: recipe() } }],
    };
    validateDiagnosisSettings(withCloudAndProfile);

    const invalidCases = [
        p => { p.tokenBudget = 12000; },
        p => { p.historyDepth = 20; },
        p => { p.promptPresetId = 'strict'; },
        p => { p.apiKey = 'secret'; },
        p => { p.settingsVersion = 3; },
        p => { p.connectionId = 'tavern-current'; },
        p => { p.connectionId = 'local-conn-1'; },
        p => { p.connectionId = 'cloud:bad/path'; },
        p => { p.recipe.nodes.find(n => n.source === 'patch-protocol').enabled = false; },
        p => { p.recipe.nodes.find(n => n.source === 'stat-data').type = 'source'; },
        p => { p.recipe.nodes = p.recipe.nodes.filter(n => n.source !== 'latest-update'); },
        p => { p.recipe.nodes.push({ ...p.recipe.nodes.find(n => n.source === 'current-input'), id: 'dup-input' }); },
        p => { p.recipe.nodes.find(n => n.source === 'diagnosis-history').options = { depth: 10 }; },
        p => { p.recipe.nodes.find(n => n.source === 'main-chat').options = { depth: 10 }; },
        p => { p.recipe.nodes.find(n => n.source === 'main-chat').options.depth = 501; },
        p => { p.recipe.nodes.push({ id: 'bad-src', type: 'source', title: 'Bad', role: 'system', enabled: true, source: 'world-info', options: {} }); },
        p => { p.promptProfiles.activeId = 'missing-profile'; },
        p => { p.promptProfiles.items = [{ id: 'official', name: '内置', payload: { recipe: recipe() } }]; },
        p => { p.promptProfiles.items = [{ id: 'c1', name: 'P', payload: { recipe: recipe(), tokenBudget: 0 } }]; },
    ];
    for (const mutate of invalidCases) {
        const p = settings();
        mutate(p);
        assert.throws(() => validateDiagnosisSettings(p), { code: 'DOCUMENT_INVALID' });
    }
});

test('Diagnosis record validators enforce 80-message cap, stripped runtime fields and lore selection bounds', () => {
    validateDiagnosisRecord('oracle-diagnosis-threads', thread());
    for (const state of ['ready', 'applied', 'nochange', 'undone']) {
        const p = thread();
        p.thread.messages[1].diagnosis = { applyState: state };
        validateDiagnosisRecord('oracle-diagnosis-threads', p);
    }

    const invalidThreads = [
        p => { p.identity.kind = 'invalid'; },
        p => { p.thread.messages = Array.from({ length: 81 }, (_, i) => ({ id: 'm' + i, role: 'user', content: 'x' })); },
        p => { p.thread.messages[0].content = 'x'.repeat(200001); },
        p => { p.thread.messages[0].diagnosis = { applyState: 'ready' }; },
        p => { p.thread.messages[1].diagnosis = { applyState: 'applying' }; },
        p => { p.thread.messages[1].diagnosis = { applyState: 'undoing' }; },
        p => { p.thread.messages[1].diagnosis = { applyState: 'ready', status: '已应用' }; },
        p => { p.thread.messages[1].diagnosis = { applyState: 'ready', mutationId: 'mut-1' }; },
        p => { p.thread.messages[1].liveText = 'streaming'; },
        p => { p.thread.messages[1].target = { scope: 'character' }; },
        p => { p.thread.messages[1].receipt = { before: {} }; },
        p => { p.thread.messages.push(p.thread.messages[0]); },
    ];
    for (const mutate of invalidThreads) {
        const p = thread();
        mutate(p);
        assert.throws(() => validateDiagnosisRecord('oracle-diagnosis-threads', p), { code: 'DOCUMENT_INVALID' });
    }

    validateDiagnosisRecord('oracle-diagnosis-thread-index', {
        identity,
        threads: [{ id: 't-1', title: '诊断 1', autoTitle: true, createdAt: 1, updatedAt: 2, messageCount: 2 }],
    });
    assert.throws(
        () => validateDiagnosisRecord('oracle-diagnosis-thread-index', {
            identity,
            threads: Array.from({ length: 51 }, (_, i) => ({ id: 't' + i, title: 'T', autoTitle: true, createdAt: 1, updatedAt: 1, messageCount: 0 })),
        }),
        { code: 'DOCUMENT_INVALID' },
    );

    validateDiagnosisRecord('oracle-diagnosis-lore-selection', loreSelection());
    const emptyTarget = loreSelection();
    emptyTarget.selection.targetBook = '';
    validateDiagnosisRecord('oracle-diagnosis-lore-selection', emptyTarget);

    const invalidLore = [
        p => { p.selection.activeTab = 'lore'; },
        p => { p.selection.selected.WorldA = [-1]; },
        p => { p.selection.selected.WorldA = ['1']; },
        p => { p.selection.selected.WorldA = [1, 1]; },
        p => { p.selection.selected = Object.fromEntries(Array.from({ length: 129 }, (_, i) => ['B' + i, [0]])); },
        p => { p.selection.selected = { WorldA: Array.from({ length: 4097 }, (_, i) => i) }; },
        p => {
            p.selection.selected = {
                B1: Array.from({ length: 4096 }, (_, i) => i),
                B2: Array.from({ length: 4096 }, (_, i) => i),
                B3: [0],
            };
        },
    ];
    for (const mutate of invalidLore) {
        const p = loreSelection();
        mutate(p);
        assert.throws(() => validateDiagnosisRecord('oracle-diagnosis-lore-selection', p), { code: 'DOCUMENT_INVALID' });
    }
});

test('Diagnosis production consumers use independent Document and Record CAS, isolate users and reject Tombstone reuse', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'ttb-diagnosis-server-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const documents = createAccountDocuments(config);
    const records = createAccountRecords(config, { consumers: [...advisorRecordConsumers, ...diagnosisRecordConsumers] });
    await documents.definition.initialize();
    await records.definition.initialize();
    t.after(() => {
        documents.definition.shutdown();
        records.definition.shutdown();
    });

    const alice = { userRoot: path.join(root, 'alice'), contextId: 'alice' };
    const bob = { userRoot: path.join(root, 'bob'), contextId: 'bob' };

    await documents.commit(alice, 'oracle-diagnosis-settings', { schemaVersion: 1, expectedRevision: 0, payload: settings() });
    assert.equal((await documents.read(alice, 'oracle-diagnosis-settings', 1)).revision, 1);
    assert.equal((await documents.read(bob, 'oracle-diagnosis-settings', 1)).revision, 0);
    assert.equal((await documents.read(alice, 'oracle-advisor-settings', 1)).revision, 0);

    await records.commit(alice, 'oracle-diagnosis-threads', 'thread-a', { schemaVersion: 1, expectedRevision: 0, payload: thread('a') });
    await records.commit(alice, 'oracle-diagnosis-threads', 'thread-b', { schemaVersion: 1, expectedRevision: 0, payload: thread('b') });
    await records.commit(alice, 'oracle-diagnosis-lore-selection', 'chat-1:lore', { schemaVersion: 1, expectedRevision: 0, payload: loreSelection() });

    await records.commit(alice, 'oracle-diagnosis-threads', 'thread-a', { schemaVersion: 1, expectedRevision: 1, payload: thread('a') });
    assert.equal((await records.read(alice, 'oracle-diagnosis-threads', 'thread-b', 1)).revision, 1);
    assert.equal((await records.read(alice, 'oracle-diagnosis-lore-selection', 'chat-1:lore', 1)).revision, 1);
    await assert.rejects(
        records.commit(alice, 'oracle-diagnosis-threads', 'thread-a', { schemaVersion: 1, expectedRevision: 1, payload: thread('a') }),
        { code: 'REVISION_CONFLICT' },
    );
    assert.equal((await records.read(bob, 'oracle-diagnosis-threads', 'thread-a', 1)).status, 'missing');

    const deleted = await records.delete(alice, 'oracle-diagnosis-threads', 'thread-b', { schemaVersion: 1, expectedRevision: 1 });
    assert.equal(deleted.status, 'deleted');
    assert.equal(deleted.revision, 2);
    await assert.rejects(
        records.commit(alice, 'oracle-diagnosis-threads', 'thread-b', { schemaVersion: 1, expectedRevision: 2, payload: thread('b') }),
        { code: 'RECORD_DELETED' },
    );

    for (const consumer of ['oracle-correction', 'oracle-lorebook-manager']) {
        assert.throws(() => records.consumer(consumer), { code: 'RECORD_CONSUMER_NOT_REGISTERED' });
    }
});
