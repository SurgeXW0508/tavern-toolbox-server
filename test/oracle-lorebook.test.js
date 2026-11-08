import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createAccountDocuments } from '../src/account-documents/store.js';
import { createAccountRecords } from '../src/account-records/store.js';
import { advisorRecordConsumers } from '../src/account-documents/oracle-advisor.js';
import { diagnosisRecordConsumers } from '../src/account-documents/oracle-diagnosis.js';
import { correctionRecordConsumers } from '../src/account-documents/oracle-correction.js';
import {
    lorebookRecordConsumers,
    validateLorebookSettings,
    validateLorebookRecord,
    transitionLorebookBatch,
    transitionLorebookExecution,
    transitionLorebookExecStep,
    transitionLorebookBookLock,
} from '../src/account-documents/oracle-lorebook.js';

const config = { policy: { core: { allowedOrigins: ['https://example.test'] } } };
const identity = { kind: 'character', owner: 'Alice.png', chat: 'chat-1' };

const protectedSources = [
    'safety-contract',
    'macro-legend',
    'selected-lorebooks',
    'edit-protocol',
    'current-input',
];

const recipe = () => ({
    version: 1,
    nodes: [
        { id: 'main-chat', type: 'source', title: '主聊天记录', role: 'system', enabled: true, source: 'main-chat', options: { depth: 20, includeHidden: false } },
        { id: 'manager-history', type: 'source', title: '本对话历史', role: 'preserve', enabled: true, source: 'manager-history', options: {} },
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
    tokenBudget: 0,
    recipe: recipe(),
    promptProfiles: { version: 1, activeId: 'official', items: [] },
});

const normalizedEntry = (uid = 1, name = '林夕') => ({
    book: '人物',
    uid,
    name,
    enabled: true,
    strategy: {
        type: 'selective',
        keys: ['林夕'],
        keys_secondary: { logic: 'and_any', keys: [] },
        scan_depth: 'same_as_global',
    },
    position: { type: 'before_character_definition', role: 'system', depth: 4, order: 100 },
    content: '年龄：18',
    probability: 100,
    recursion: { prevent_incoming: false, prevent_outgoing: false, delay_until: null },
    effect: { sticky: null, cooldown: null, delay: null },
    extra: {},
    rawFingerprint: '0123456789abcdef',
    sourceSchema: 'official',
});

const batchRecord = (id = 'lorebook-review-1') => ({
    identity: { ...identity },
    threadId: 'thread-1',
    batch: {
        schema: 1,
        id,
        messageId: 'msg-a1',
        createdAt: 1000,
        updatedAt: 1000,
        allowedBooks: ['人物'],
        bookFingerprints: { 人物: 'fp-book-1' },
        sourceEntries: [normalizedEntry(1, '林夕')],
        blockedErrors: [],
        items: [
            {
                id: `${id}-item-1`,
                index: 1,
                status: 'accepted',
                operation: {
                    index: 1,
                    action: 'patch',
                    book: '人物',
                    uid: 1,
                    anchor: '年龄：18',
                    replace: '年龄：19',
                    fields: {},
                },
                originalPreview: {
                    schema: 1,
                    index: 1,
                    action: 'patch',
                    book: '人物',
                    uid: 1,
                    kind: 'patch',
                    title: '林夕',
                    before: normalizedEntry(1, '林夕'),
                    after: { ...normalizedEntry(1, '林夕'), content: '年龄：19' },
                    sourceFingerprint: 'fp-src-1',
                    predecessorFingerprint: 'fp-src-1',
                    bookFingerprint: 'fp-book-1',
                    changes: [{ label: '正文', before: '年龄：18', after: '年龄：19' }],
                },
            },
        ],
        frozenBy: null,
        importedApplication: null,
    },
});

const stepBaseline = () => ({
    beforeBookFingerprint: 'fp-book-1',
    afterPlannedBookFingerprint: 'fp-book-2',
    targets: [
        {
            uid: 1,
            finalAction: 'patch',
            initialExists: true,
            initialIndex: 0,
            initialRaw: { uid: 1, name: '林夕', content: '年龄：18' },
            initialRawFingerprint: 'fp-raw-1',
            initialEntryFingerprint: 'fp-entry-1',
            finalExists: true,
            finalPlannedRawFingerprint: 'fp-raw-2',
            finalEntryFingerprint: 'fp-entry-2',
            plannedFields: [{ path: 'content', value: '年龄：19' }],
        },
    ],
    pendingReceipts: [
        {
            index: 1,
            action: 'patch',
            book: '人物',
            uid: 1,
            beforeIndex: 0,
            beforeRaw: { uid: 1, name: '林夕', content: '年龄：18' },
            beforeFingerprint: 'fp-entry-1',
            afterFingerprint: 'fp-entry-2',
            afterRawFingerprint: 'fp-raw-2',
            undoable: true,
        },
    ],
});

const execStepRecord = (overrides = {}) => ({
    schema: 1,
    identity: { ...identity },
    threadId: 'thread-1',
    batchId: 'lorebook-review-1',
    book: '人物',
    stepIndex: 0,
    state: 'pending',
    attemptId: null,
    holderDeviceId: null,
    allocatedUids: { '2': 520424 },
    baseline: null,
    verification: null,
    reconciliation: null,
    undo: null,
    conflictResolution: null,
    error: '',
    updatedAt: 1000,
    history: [],
    ...overrides,
});

const executionRecord = (overrides = {}) => ({
    schema: 1,
    identity: { ...identity },
    threadId: 'thread-1',
    batchId: 'lorebook-review-1',
    messageId: 'msg-a1',
    reviewFingerprint: 'fp-review-1',
    stage: 'frozen',
    status: 'applying',
    activeAttemptId: 'att-1',
    holderDeviceId: 'dev-1',
    books: [
        {
            book: '人物',
            stepRecordId: 'step-1',
            state: 'pending',
            operationCount: 1,
            updatedAt: 1000,
            error: '',
        },
    ],
    stepOrder: ['人物'],
    undoOrder: ['人物'],
    startedAt: 1000,
    updatedAt: 1000,
    finishedAt: null,
    error: '',
    history: [
        {
            attemptId: 'att-1',
            deviceId: 'dev-1',
            action: 'freeze',
            stage: 'frozen',
            status: 'applying',
            at: 1000,
            note: '',
        },
    ],
    ...overrides,
});

const bookLockRecord = (overrides = {}) => ({
    schema: 1,
    identity: { ...identity },
    book: '人物',
    holder: {
        batchId: 'lorebook-review-1',
        threadId: 'thread-1',
        attemptId: 'att-1',
        deviceId: 'dev-1',
        mode: 'apply',
        acquiredAt: 1000,
    },
    ledger: [],
    history: [
        {
            action: 'acquire',
            batchId: 'lorebook-review-1',
            attemptId: 'att-1',
            deviceId: 'dev-1',
            at: 1000,
            reason: '',
        },
    ],
    updatedAt: 1000,
    ...overrides,
});

test('Lorebook settings validator enforces v4 whitelist, protected sources, tokenBudget and profile payloads', () => {
    validateLorebookSettings(settings());
    const custom = settings();
    custom.connectionId = 'cloud:conn_lore';
    custom.tokenBudget = 16000;
    custom.promptProfiles = {
        version: 1,
        activeId: 'p1',
        items: [{
            id: 'p1',
            name: '精简配置',
            payload: { recipe: recipe(), tokenBudget: 8000 },
        }],
    };
    validateLorebookSettings(custom);

    const invalidCases = [
        p => { p.settingsVersion = 3; },
        p => { p.connectionId = 'local-conn'; },
        p => { p.tokenBudget = -1; },
        p => { p.tokenBudget = 1000001; },
        p => { p.recipe.nodes.find(n => n.source === 'safety-contract').enabled = false; },
        p => { p.recipe.nodes.find(n => n.source === 'edit-protocol').type = 'source'; },
        p => { p.recipe.nodes = p.recipe.nodes.filter(n => n.source !== 'selected-lorebooks'); },
        p => { p.recipe.nodes.find(n => n.source === 'manager-history').options = { depth: 10 }; },
        p => { p.promptProfiles.items = [{ id: 'p1', name: 'P', payload: { recipe: recipe() } }]; },
    ];
    for (const mutate of invalidCases) {
        const p = settings();
        mutate(p);
        assert.throws(() => validateLorebookSettings(p), { code: 'DOCUMENT_INVALID' });
    }
});

test('Lorebook batch, execution, step and book-lock state machines enforce freeze, CAS transitions, conflict protection and pruning', async t => {
    const root = await mkdtemp(path.join(tmpdir(), 'ttb-lorebook-records-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const user = { userRoot: path.join(root, 'user-1') };

    const docs = createAccountDocuments(config);
    await docs.definition.initialize();
    t.after(() => docs.definition.shutdown());
    await docs.commit(user, 'oracle-lorebook-settings', {
        schemaVersion: 1,
        expectedRevision: 0,
        payload: settings(),
    });
    assert.equal((await docs.read(user, 'oracle-lorebook-settings', 1)).revision, 1);

    const records = createAccountRecords(config, {
        consumers: [
            ...advisorRecordConsumers,
            ...diagnosisRecordConsumers,
            ...correctionRecordConsumers,
            ...lorebookRecordConsumers,
        ],
    });
    await records.definition.initialize();
    t.after(() => records.definition.shutdown());

    // 1. Batch freeze immutability
    const b0 = batchRecord();
    validateLorebookRecord('oracle-lorebook-batches', b0);
    const bFrozen = structuredClone(b0);
    bFrozen.batch.frozenBy = {
        executionId: 'lorebook-review-1',
        reviewFingerprint: 'fp-review-1',
        frozenAt: 1010,
        deviceId: 'dev-1',
    };
    assert.equal(transitionLorebookBatch(b0, bFrozen), true);
    const bMutatedAfterFreeze = structuredClone(bFrozen);
    bMutatedAfterFreeze.batch.items[0].status = 'rejected';
    assert.equal(transitionLorebookBatch(bFrozen, bMutatedAfterFreeze), false);

    // 2. Step state machine: pending -> writing -> unknown -> verified -> undoing -> undone -> pruned
    const sPending = execStepRecord();
    const sWriting = execStepRecord({
        state: 'writing',
        attemptId: 'att-1',
        holderDeviceId: 'dev-1',
        baseline: stepBaseline(),
    });
    assert.equal(transitionLorebookExecStep(sPending, sWriting), true);

    // Cannot alter pre-allocated create UID
    const sBadUid = structuredClone(sWriting);
    sBadUid.allocatedUids['2'] = 999;
    assert.equal(transitionLorebookExecStep(sPending, sBadUid), false);

    const sUnknown = structuredClone(sWriting);
    sUnknown.state = 'unknown';
    assert.equal(transitionLorebookExecStep(sWriting, sUnknown), true);

    // Unknown -> verified requires reconciliation evidence
    const sVerifiedNoEvidence = structuredClone(sUnknown);
    sVerifiedNoEvidence.state = 'verified';
    sVerifiedNoEvidence.verification = {
        afterBookFingerprint: 'fp-book-2',
        receipts: stepBaseline().pendingReceipts,
        verifiedAt: 1020,
        persistenceMode: 'worldinfo-updated',
    };
    assert.equal(transitionLorebookExecStep(sUnknown, sVerifiedNoEvidence), false);

    const sVerified = structuredClone(sVerifiedNoEvidence);
    sVerified.reconciliation = {
        outcome: 'verified',
        reason: '',
        evidenceDigest: 'ev-1',
        reconciledAt: 1020,
        deviceId: 'dev-2',
    };
    assert.equal(transitionLorebookExecStep(sUnknown, sVerified), true);

    // Verified -> undoing -> undone -> pruned (drops baseline)
    const sUndoing = structuredClone(sVerified);
    sUndoing.state = 'undoing';
    sUndoing.attemptId = 'att-undo-1';
    sUndoing.undo = {
        status: 'undoing',
        attemptId: 'att-undo-1',
        deviceId: 'dev-2',
        startedAt: 1030,
        finishedAt: null,
        afterBookFingerprint: null,
        error: '',
    };
    assert.equal(transitionLorebookExecStep(sVerified, sUndoing), true);

    const sUndone = structuredClone(sUndoing);
    sUndone.state = 'undone';
    sUndone.undo = {
        ...sUndoing.undo,
        status: 'undone',
        finishedAt: 1040,
        afterBookFingerprint: 'fp-book-1',
    };
    assert.equal(transitionLorebookExecStep(sUndoing, sUndone), true);

    const sPruned = structuredClone(sUndone);
    sPruned.state = 'pruned';
    sPruned.baseline = null;
    assert.equal(transitionLorebookExecStep(sUndone, sPruned), true);

    // Conflict protection: unresolved conflict cannot be overwritten back to verified or pruned without resolution
    const sConflict = structuredClone(sUnknown);
    sConflict.state = 'conflict';
    sConflict.reconciliation = {
        outcome: 'conflict',
        reason: '外部修改冲突',
        evidenceDigest: 'ev-conflict',
        reconciledAt: 1050,
        deviceId: 'dev-2',
    };
    assert.equal(transitionLorebookExecStep(sUnknown, sConflict), true);
    assert.equal(transitionLorebookExecStep(sConflict, sVerified), false);
    assert.equal(transitionLorebookExecStep(sConflict, sPruned), false);

    const sConflictResolved = structuredClone(sConflict);
    sConflictResolved.conflictResolution = {
        resolvedByDeviceId: 'dev-2',
        resolvedAt: 1060,
        resolution: 'manual-fixed',
        note: '已在酒馆世界书中人工核对修复',
    };
    assert.equal(transitionLorebookExecStep(sConflict, sConflictResolved), true);
    const sConflictPruned = structuredClone(sConflictResolved);
    sConflictPruned.state = 'pruned';
    sConflictPruned.baseline = null;
    assert.equal(transitionLorebookExecStep(sConflictResolved, sConflictPruned), true);

    // 3. Book lock transitions: acquire -> takeover requires reason -> release
    const lock1 = bookLockRecord();
    validateLorebookRecord('oracle-lorebook-book-locks', lock1);
    const lockTakeoverBad = structuredClone(lock1);
    lockTakeoverBad.holder.attemptId = 'att-2';
    lockTakeoverBad.holder.deviceId = 'dev-2';
    assert.equal(transitionLorebookBookLock(lock1, lockTakeoverBad), false);

    const lockTakeoverOk = structuredClone(lockTakeoverBad);
    lockTakeoverOk.history.push({
        action: 'takeover',
        batchId: 'lorebook-review-1',
        attemptId: 'att-2',
        deviceId: 'dev-2',
        at: 1020,
        reason: '原设备离线，接管单书执行锁',
    });
    assert.equal(transitionLorebookBookLock(lock1, lockTakeoverOk), true);

    const lockReleased = structuredClone(lockTakeoverOk);
    lockReleased.holder = null;
    lockReleased.history.push({
        action: 'release',
        batchId: 'lorebook-review-1',
        attemptId: 'att-2',
        deviceId: 'dev-2',
        at: 1030,
        reason: '',
    });
    assert.equal(transitionLorebookBookLock(lockTakeoverOk, lockReleased), true);

    // 4. Execution record stage transitions
    const execFrozen = executionRecord();
    const execRunning = executionRecord({ stage: 'running' });
    assert.equal(transitionLorebookExecution(execFrozen, execRunning), true);
    const execSettled = executionRecord({
        stage: 'settled',
        status: 'applied',
        books: [{ ...execFrozen.books[0], state: 'verified' }],
    });
    assert.equal(transitionLorebookExecution(execRunning, execSettled), true);
    const execUndoRunning = executionRecord({
        stage: 'undo-running',
        status: 'undoing',
        books: [{ ...execFrozen.books[0], state: 'verified' }],
    });
    assert.equal(transitionLorebookExecution(execSettled, execUndoRunning), true);
});
