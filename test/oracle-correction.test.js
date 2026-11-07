import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createAccountDocuments } from '../src/account-documents/store.js';
import { createAccountRecords } from '../src/account-records/store.js';
import { advisorRecordConsumers } from '../src/account-documents/oracle-advisor.js';
import { diagnosisRecordConsumers } from '../src/account-documents/oracle-diagnosis.js';
import {
    correctionRecordConsumers,
    validateCorrectionSettings,
    validateCorrectionRecord,
    transitionCorrectionApplication,
} from '../src/account-documents/oracle-correction.js';

const config = { policy: { core: { allowedOrigins: ['https://example.test'] } } };
const identity = { kind: 'character', owner: 'Alice.png', chat: 'chat-1' };
const hex = (ch = 'a') => ch.repeat(64);

const recipe = (mode = 'full') => {
    const protectedSources = mode === 'selection'
        ? ['selected-span', 'fixed-protocol', 'current-input']
        : ['current-target', 'fixed-protocol', 'current-input'];
    return {
        version: 1,
        nodes: [
            { id: 'persona', type: 'source', title: 'Persona', role: 'system', enabled: true, source: 'persona', options: {} },
            { id: 'world-info', type: 'source', title: '世界书', role: 'system', enabled: true, source: 'world-info', options: { mode: 'st' } },
            { id: 'main-chat', type: 'source', title: '主聊天', role: 'preserve', enabled: true, source: 'main-chat', options: { depth: 6 } },
            ...(mode === 'selection' ? [
                { id: 'span-before', type: 'source', title: '前衔接', role: 'system', enabled: true, source: 'span-before', options: {} },
                { id: 'span-after', type: 'source', title: '后衔接', role: 'system', enabled: true, source: 'span-after', options: {} },
                { id: 'full-target-background', type: 'source', title: '背景', role: 'system', enabled: false, source: 'full-target-background', options: {} },
            ] : []),
            ...protectedSources.map(source => ({
                id: source,
                type: 'protected',
                title: source,
                role: source === 'fixed-protocol' ? 'system' : 'user',
                enabled: true,
                source,
                options: {},
            })),
        ],
    };
};

const settings = () => ({
    settingsVersion: 4,
    connectionId: '',
    selectionContextChars: 400,
    includeFullTargetForSelection: false,
    quickCommands: [
        { id: 'correction-quick-1', name: '收紧描写', content: '减少拖沓描写', favorite: true },
    ],
    recipes: {
        full: recipe('full'),
        selection: recipe('selection'),
    },
    promptProfiles: { version: 1, activeId: 'official', items: [] },
});

const workspace = () => ({
    identity: { ...identity },
    mode: 'full',
    targetMessageId: 4,
    selection: { start: 0, end: 0 },
    selectionTargetKey: '',
    instruction: '修改第二段对白',
    activeCandidateId: 'correction-cand_1',
});

const candidateSummary = (id = 'correction-cand_1') => ({
    id,
    createdAt: 1000,
    messageId: 4,
    mode: 'full',
    lockDigest: hex('a'),
    versionKey: hex('b'),
    applicable: true,
    staleReason: '',
    manualRecovery: false,
    warningCounts: { blocked: 0, confirm: 1, notice: 0 },
    stats: { beforeChars: 120, afterChars: 118, changedChars: 12 },
    instructionPreview: '修改第二段对白',
    bodyBytes: 1024,
});

const candidateBody = (id = 'correction-cand_1') => ({
    identity: { ...identity },
    candidate: {
        id,
        chatKey: 'chat-1',
        targetLock: {
            schema: 2,
            chatKey: 'chat-1',
            messageId: 4,
            role: 'assistant',
            name: 'Alice',
            swipeId: 0,
            swipeCount: 1,
            content: '原始第一段。\n\n原始第二段。',
            currentSwipeData: '{}',
            currentSwipeInfo: '{}',
        },
        mode: 'full',
        selection: null,
        instruction: '修改第二段对白',
        replacement: '原始第一段。\n\n修改后第二段。',
        fullText: '原始第一段。\n\n修改后第二段。',
        rawOutput: '<FixedReply>原始第一段。\n\n修改后第二段。</FixedReply>',
        protectedBlocks: 0,
        staleReason: '',
        manualRecovery: false,
        metrics: { streamRequested: true, resolvedMs: 420, completionSource: 'return' },
        createdAt: 1000,
        lockDigest: hex('a'),
        versionKey: hex('b'),
        basedOnCandidateId: '',
    },
});

const applicationClaim = (overrides = {}) => ({
    schema: 1,
    identity: { ...identity },
    version: {
        messageId: 4,
        swipeId: 0,
        swipeCount: 1,
        contentDigest: hex('c'),
    },
    state: 'claimed',
    cycle: 1,
    operationId: 'op-test_1',
    candidateId: 'correction-cand_1',
    fullTextDigest: hex('d'),
    holder: 'dev-1',
    updatedAt: 1000,
    result: null,
    releaseReason: null,
    recoveryReason: null,
    history: [],
    ...overrides,
});

test('Correction settings validator enforces v4 whitelist, full+selection recipes, quickCommands and profile payloads', () => {
    validateCorrectionSettings(settings());
    const custom = settings();
    custom.connectionId = 'cloud:conn_corr';
    custom.promptProfiles = {
        version: 1,
        activeId: 'p1',
        items: [{
            id: 'p1',
            name: '精校配置',
            payload: {
                recipes: { full: recipe('full'), selection: recipe('selection') },
                selectionContextChars: 800,
                includeFullTargetForSelection: true,
            },
        }],
    };
    validateCorrectionSettings(custom);

    const invalid = [
        p => { p.settingsVersion = 3; },
        p => { p.connectionId = 'local-id'; },
        p => { p.customFullPrompt = 'legacy'; },
        p => { p.includePersona = true; },
        p => { p.selectionContextChars = 4001; },
        p => { p.quickCommands.push(p.quickCommands[0]); },
        p => { p.recipes.full.nodes.find(n => n.source === 'current-target').enabled = false; },
        p => { p.recipes.selection.nodes.find(n => n.source === 'selected-span').type = 'source'; },
        p => { p.recipes.full.nodes.find(n => n.source === 'world-info').options.mode = 'all'; },
        p => { p.recipes.full.nodes.find(n => n.source === 'main-chat').options.depth = 101; },
        p => { p.promptProfiles.items = [{ id: 'p1', name: 'bad', payload: { recipe: recipe('full') } }]; },
    ];
    for (const mutate of invalid) {
        const p = settings();
        mutate(p);
        assert.throws(() => validateCorrectionSettings(p), { code: 'DOCUMENT_INVALID' });
    }
});

test('Correction workspace, candidate index, candidate body and application validators enforce strict whitelists', () => {
    validateCorrectionRecord('oracle-correction-workspace', workspace());
    validateCorrectionRecord('oracle-correction-candidate-index', {
        identity,
        candidates: [candidateSummary()],
    });
    validateCorrectionRecord('oracle-correction-candidates', candidateBody());
    const selectionBody = candidateBody();
    selectionBody.candidate.mode = 'selection';
    selectionBody.candidate.selection = { start: 0, end: 5 };
    validateCorrectionRecord('oracle-correction-candidates', selectionBody);
    validateCorrectionRecord('oracle-correction-applications', applicationClaim());

    const invalidCases = [
        ['oracle-correction-workspace', () => ({ ...workspace(), view: 'workbench' })],
        ['oracle-correction-workspace', () => ({ ...workspace(), mode: 'preview' })],
        ['oracle-correction-workspace', () => ({ ...workspace(), selection: { start: 10, end: 5 } })],
        ['oracle-correction-candidate-index', () => ({
            identity,
            candidates: Array.from({ length: 31 }, (_, i) => candidateSummary(`correction-c_${i}`)),
        })],
        ['oracle-correction-candidates', () => {
            const b = candidateBody();
            b.candidate.application = { status: 'applied' };
            return b;
        }],
        ['oracle-correction-candidates', () => {
            const b = candidateBody();
            b.candidate.diff = [];
            return b;
        }],
        ['oracle-correction-candidates', () => {
            const b = candidateBody();
            b.candidate.mode = 'selection';
            b.candidate.selection = { start: 0, end: 999 };
            return b;
        }],
        ['oracle-correction-candidates', () => {
            const b = candidateBody();
            b.candidate.metrics = { apiKey: 'leak' };
            return b;
        }],
        ['oracle-correction-applications', () => applicationClaim({ state: 'applied', result: null })],
        ['oracle-correction-applications', () => applicationClaim({ state: 'recovery', recoveryReason: '' })],
        ['oracle-correction-applications', () => applicationClaim({ state: 'released', releaseReason: 'unknown' })],
    ];
    for (const [consumer, build] of invalidCases) {
        assert.throws(() => validateCorrectionRecord(consumer, build()), { code: 'DOCUMENT_INVALID' });
    }
});

test('Application state machine enforces legal transitions, operationId/cycle rules, and blocks illegal jumps', () => {
    const c1 = applicationClaim({ state: 'claimed', cycle: 1, operationId: 'op-1' });
    assert.equal(transitionCorrectionApplication(null, c1), true);
    assert.equal(transitionCorrectionApplication(null, applicationClaim({ state: 'applying', cycle: 1 })), false);
    assert.equal(transitionCorrectionApplication(null, applicationClaim({ state: 'claimed', cycle: 2 })), false);

    // Imported applied record is allowed on initial creation only.
    const imported = applicationClaim({
        state: 'applied',
        cycle: 1,
        result: { sourceSwipeId: 0, appendedSwipeId: 1, appliedAt: 1000, verification: 'imported' },
    });
    assert.equal(transitionCorrectionApplication(null, imported), true);
    assert.equal(
        transitionCorrectionApplication(null, {
            ...imported,
            result: { ...imported.result, verification: 'read-back' },
        }),
        false,
    );

    // Takeover on claimed requires new operationId and same cycle.
    const takeover = { ...c1, operationId: 'op-2', holder: 'dev-2' };
    assert.equal(transitionCorrectionApplication(c1, takeover), true);
    assert.equal(transitionCorrectionApplication(c1, { ...c1, holder: 'dev-2' }), false);

    // claimed -> applying -> applied -> released(reopened) -> claimed(cycle 2)
    const applying = { ...takeover, state: 'applying' };
    assert.equal(transitionCorrectionApplication(takeover, applying), true);
    assert.equal(transitionCorrectionApplication(takeover, { ...applying, operationId: 'op-3' }), false);

    const applied = {
        ...applying,
        state: 'applied',
        result: { sourceSwipeId: 0, appendedSwipeId: 1, appliedAt: 2000, verification: 'read-back' },
    };
    assert.equal(transitionCorrectionApplication(applying, applied), true);
    assert.equal(transitionCorrectionApplication(takeover, applied), false, 'cannot skip applying');

    // Late history-only append (applied-after-takeover) preserves state.
    const withAudit = {
        ...applied,
        history: [{ cycle: 1, operationId: 'op-1', candidateId: 'correction-cand_1', outcome: 'applied-after-takeover', at: 2100 }],
    };
    assert.equal(transitionCorrectionApplication(applied, withAudit), true);

    const reopened = { ...withAudit, state: 'released', result: null, releaseReason: 'reopened' };
    assert.equal(transitionCorrectionApplication(withAudit, reopened), true);
    assert.equal(transitionCorrectionApplication(withAudit, { ...reopened, releaseReason: 'forced' }), false);

    const reClaimed = { ...reopened, state: 'claimed', releaseReason: null, cycle: 2, operationId: 'op-3' };
    assert.equal(transitionCorrectionApplication(reopened, reClaimed), true);
    assert.equal(transitionCorrectionApplication(reopened, { ...reClaimed, cycle: 1 }), false);
    assert.equal(transitionCorrectionApplication(reopened, { ...reClaimed, operationId: 'op-2' }), false);

    // applying -> recovery -> applied or released(forced)
    const applying2 = { ...reClaimed, state: 'applying' };
    const recovery = { ...applying2, state: 'recovery', recoveryReason: 'timeout' };
    assert.equal(transitionCorrectionApplication(applying2, recovery), true);
    assert.equal(
        transitionCorrectionApplication(recovery, {
            ...recovery,
            state: 'applied',
            recoveryReason: null,
            result: { sourceSwipeId: 0, appendedSwipeId: 1, appliedAt: 3000, verification: 'marker' },
        }),
        true,
    );
    assert.equal(
        transitionCorrectionApplication(recovery, {
            ...recovery,
            state: 'released',
            recoveryReason: null,
            releaseReason: 'forced',
        }),
        true,
    );
    assert.equal(
        transitionCorrectionApplication(recovery, {
            ...recovery,
            state: 'released',
            recoveryReason: null,
            releaseReason: 'cancelled',
        }),
        false,
    );
});

test('Correction production consumers enforce CAS, transition hook, and non-deletable workspace/index/applications', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'ttb-correction-server-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const documents = createAccountDocuments(config);
    const records = createAccountRecords(config, {
        consumers: [...advisorRecordConsumers, ...diagnosisRecordConsumers, ...correctionRecordConsumers],
    });
    await documents.definition.initialize();
    await records.definition.initialize();
    t.after(() => {
        documents.definition.shutdown();
        records.definition.shutdown();
    });

    const alice = { userRoot: path.join(root, 'alice'), contextId: 'alice' };
    await documents.commit(alice, 'oracle-correction-settings', {
        schemaVersion: 1,
        expectedRevision: 0,
        payload: settings(),
    });
    assert.equal((await documents.read(alice, 'oracle-correction-settings', 1)).revision, 1);

    await records.commit(alice, 'oracle-correction-workspace', 'chat-1', {
        schemaVersion: 1,
        expectedRevision: 0,
        payload: workspace(),
    });
    await assert.rejects(
        records.delete(alice, 'oracle-correction-workspace', 'chat-1', { schemaVersion: 1, expectedRevision: 1 }),
        { code: 'RECORD_DELETE_FORBIDDEN' },
    );

    await records.commit(alice, 'oracle-correction-candidates', 'cand-1', {
        schemaVersion: 1,
        expectedRevision: 0,
        payload: candidateBody(),
    });
    const deletedCand = await records.delete(alice, 'oracle-correction-candidates', 'cand-1', {
        schemaVersion: 1,
        expectedRevision: 1,
    });
    assert.equal(deletedCand.status, 'deleted');

    const claim = applicationClaim();
    await records.commit(alice, 'oracle-correction-applications', 'apply-1', {
        schemaVersion: 1,
        expectedRevision: 0,
        payload: claim,
    });
    await assert.rejects(
        records.delete(alice, 'oracle-correction-applications', 'apply-1', { schemaVersion: 1, expectedRevision: 1 }),
        { code: 'RECORD_DELETE_FORBIDDEN' },
    );
    await assert.rejects(
        records.commit(alice, 'oracle-correction-applications', 'apply-1', {
            schemaVersion: 1,
            expectedRevision: 1,
            payload: {
                ...claim,
                state: 'applied',
                result: { sourceSwipeId: 0, appendedSwipeId: 1, appliedAt: 2000, verification: 'read-back' },
            },
        }),
        { code: 'RECORD_TRANSITION_INVALID' },
    );
});
