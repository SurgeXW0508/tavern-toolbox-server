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
    LOREBOOK_LOCK_STALE_AFTER_MS,
    LOREBOOK_LOCK_MIGRATION_RECORD_ID,
    lorebookRecordConsumers,
    validateLorebookSettings,
    validateLorebookRecord,
    transitionLorebookBatch,
    transitionLorebookExecution,
    transitionLorebookExecStep,
    transitionLorebookBookLock,
    projectLorebookBookLockRead,
} from '../src/account-documents/oracle-lorebook.js';

const config = { policy: { core: { allowedOrigins: ['https://example.test'] } } };
const identity = { kind: 'character', owner: 'Alice.png', chat: 'chat-1' };
const bookResourceIdentity = { kind: 'character', owner: 'lorebook-resource', chat: '人物' };

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
    identity: { ...bookResourceIdentity },
    book: '人物',
    epoch: 1,
    fence: 1,
    holder: {
        batchId: 'lorebook-review-1',
        threadId: 'thread-1',
        attemptId: 'att-1',
        operationId: 'att-1',
        runtimeId: 'rt-1',
        epoch: 1,
        fence: 1,
        deviceId: 'dev-1',
        mode: 'apply',
        phase: 'preparing',
        chat: 'chat-1',
        acquiredAt: 1000,
        heartbeatAt: 1000,
    },
    ledger: [],
    history: [
        {
            action: 'acquire',
            batchId: 'lorebook-review-1',
            attemptId: 'att-1',
            operationId: 'att-1',
            runtimeId: 'rt-1',
            epoch: 1,
            deviceId: 'dev-1',
            phase: 'preparing',
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

    let fakeNow = 1000;
    const records = createAccountRecords(config, {
        now: () => fakeNow,
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
        execution: {
            state: 'preparing',
            operationId: 'att-1',
            runtimeId: 'rt-1',
            deviceId: 'dev-1',
            epoch: 1,
        },
    });
    assert.equal(transitionLorebookExecStep(sPending, sWriting), true);

    // Cannot alter pre-allocated create UID
    const sBadUid = structuredClone(sWriting);
    sBadUid.allocatedUids['2'] = 999;
    assert.equal(transitionLorebookExecStep(sPending, sBadUid), false);

    const sUnknown = structuredClone(sWriting);
    sUnknown.state = 'unknown';
    sUnknown.execution = {
        ...sWriting.execution,
        state: 'ended',
        endedBy: 'threw',
        endedAt: 1015,
    };
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

    // Resolution while execution is still in-flight is rejected (§3.3)
    const sConflictInFlightResolved = structuredClone(sConflict);
    sConflictInFlightResolved.execution = {
        state: 'in-flight',
        operationId: 'att-1',
        runtimeId: 'rt-1',
        deviceId: 'dev-1',
        epoch: 1,
    };
    sConflictInFlightResolved.conflictResolution = {
        resolvedByDeviceId: 'dev-2',
        resolvedAt: 1060,
        resolution: 'manual-fixed',
        note: '尝试在途期间消解',
    };
    assert.equal(transitionLorebookExecStep(sConflict, sConflictInFlightResolved), false);

    const sConflictResolved = structuredClone(sConflict);
    sConflictResolved.conflictResolution = {
        resolvedByDeviceId: 'dev-2',
        resolvedAt: 1060,
        resolution: 'manual-fixed',
        basedOnFingerprint: 'fp-book-ext',
        operationId: 'att-1',
        note: '已在酒馆世界书中人工核对修复',
    };
    sConflictResolved.resolution = {
        state: 'resolved',
        choice: 'manual-fixed',
        basedOnFingerprint: 'fp-book-ext',
        resolvedAt: 1060,
        resolvedBy: 'dev-2',
        operationId: 'att-1',
        note: '已在酒馆世界书中人工核对修复',
    };
    assert.equal(transitionLorebookExecStep(sConflict, sConflictResolved), true);

    // Late completion reopens resolved conflict (S10) and enforces append-only lateCompletions
    const sConflictReopened = structuredClone(sConflictResolved);
    sConflictReopened.conflictResolution = null;
    sConflictReopened.resolution = { state: 'none' };
    sConflictReopened.lateCompletions = [
        {
            operationId: 'att-1',
            endedBy: 'returned',
            observedFingerprint: 'fp-book-late',
            at: 1070,
        },
    ];
    assert.equal(transitionLorebookExecStep(sConflictResolved, sConflictReopened), true);
    // Stripping lateCompletions is rejected
    const sConflictStripLate = structuredClone(sConflictReopened);
    sConflictStripLate.lateCompletions = [];
    assert.equal(transitionLorebookExecStep(sConflictReopened, sConflictStripLate), false);

    const sConflictPruned = structuredClone(sConflictResolved);
    sConflictPruned.state = 'pruned';
    sConflictPruned.baseline = null;
    assert.equal(transitionLorebookExecStep(sConflictResolved, sConflictPruned), true);

    // 3. Book lock transitions (L1–L10, D2/I9, migration marker)
    // D2/I9: Legacy chat-level lock write is rejected
    const legacyLock = bookLockRecord({
        identity: { ...identity },
    });
    assert.equal(transitionLorebookBookLock(null, legacyLock), false);
    assert.throws(
        () => transitionLorebookBookLock(null, legacyLock, { throwFailures: true }),
        { code: 'LEGACY_LOCK_WRITE_FORBIDDEN' },
    );
    // Existing legacy lock allows ONLY holder-CAS release (holder: null)
    const legacyReleaseOk = structuredClone(legacyLock);
    legacyReleaseOk.holder = null;
    legacyReleaseOk.history.push({
        action: 'release',
        batchId: 'lorebook-review-1',
        attemptId: 'att-1',
        deviceId: 'dev-1',
        at: 1020,
        reason: 'migrated',
    });
    assert.equal(transitionLorebookBookLock(legacyLock, legacyReleaseOk), true);
    const legacyReleaseWrongAttempt = structuredClone(legacyReleaseOk);
    legacyReleaseWrongAttempt.history.at(-1).attemptId = 'att-other';
    assert.equal(transitionLorebookBookLock(legacyLock, legacyReleaseWrongAttempt), false);

    // L1: Canonical lock requires migration marker when readRecord is present in store
    const lock1 = bookLockRecord();
    validateLorebookRecord('oracle-lorebook-book-locks', lock1);
    await assert.rejects(
        () => records.commit(user, 'oracle-lorebook-book-locks', 'lorebook-book-lock:0123456789abcdef01234567', {
            schemaVersion: 1,
            expectedRevision: 0,
            payload: lock1,
        }),
        { code: 'LOREBOOK_MIGRATION_REQUIRED' },
    );

    // Complete account-level migration control record
    const migInProgress = {
        schema: 1,
        identity: { ...bookResourceIdentity, chat: '__migration__' },
        book: '__migration__',
        kind: 'migration',
        status: 'in-progress',
        runtimeId: 'rt-mig-1',
        deviceId: 'dev-1',
        epoch: 1,
        acquiredAt: 1000,
        heartbeatAt: 1000,
        completedAt: null,
        summary: {
            scannedRecords: 0,
            legacyLocksFound: 0,
            booksMigrated: 0,
            unresolvedBooks: [],
            clearedLegacyLocks: 0,
        },
        updatedAt: 1000,
    };
    await records.commit(user, 'oracle-lorebook-book-locks', LOREBOOK_LOCK_MIGRATION_RECORD_ID, {
        schemaVersion: 1,
        expectedRevision: 0,
        payload: migInProgress,
    });
    // Another runtime cannot steal non-stale migration mutex
    await assert.rejects(
        () => records.commit(user, 'oracle-lorebook-book-locks', LOREBOOK_LOCK_MIGRATION_RECORD_ID, {
            schemaVersion: 1,
            expectedRevision: 1,
            payload: { ...migInProgress, runtimeId: 'rt-mig-2', epoch: 2 },
        }),
        { code: 'LOREBOOK_LOCK_NOT_STALE' },
    );
    await records.commit(user, 'oracle-lorebook-book-locks', LOREBOOK_LOCK_MIGRATION_RECORD_ID, {
        schemaVersion: 1,
        expectedRevision: 1,
        payload: { ...migInProgress, status: 'completed', completedAt: 1005 },
    });

    // L9: Reject canonical lock holder missing runtimeId/operationId/epoch/phase
    const lockMissingRuntime = bookLockRecord();
    delete lockMissingRuntime.holder.runtimeId;
    assert.equal(transitionLorebookBookLock(null, lockMissingRuntime), false);

    // L1: Acquire preparing lock succeeds once migration is completed
    const committedLock1 = await records.commit(user, 'oracle-lorebook-book-locks', 'lorebook-book-lock:0123456789abcdef01234567', {
        schemaVersion: 1,
        expectedRevision: 0,
        payload: lock1,
    });
    assert.equal(committedLock1.revision, 1);

    // L5: Preparing takeover without staleness or webLockReleased is rejected
    const lockTakeoverNotStale = structuredClone(lock1);
    lockTakeoverNotStale.epoch = 2;
    lockTakeoverNotStale.holder = {
        ...lock1.holder,
        attemptId: 'att-2',
        operationId: 'att-2',
        runtimeId: 'rt-2',
        epoch: 2,
        deviceId: 'dev-2',
        takeoverOf: { operationId: 'att-1', epoch: 1 },
    };
    lockTakeoverNotStale.history.push({
        action: 'takeover',
        batchId: 'lorebook-review-1',
        attemptId: 'att-2',
        operationId: 'att-2',
        runtimeId: 'rt-2',
        epoch: 2,
        deviceId: 'dev-2',
        at: 1020,
        takeoverOf: { operationId: 'att-1', epoch: 1 },
        reason: '跨设备抢锁但尚未超时',
    });
    assert.throws(
        () => transitionLorebookBookLock(lock1, lockTakeoverNotStale, { now: 1020, throwFailures: true }),
        { code: 'LOREBOOK_LOCK_NOT_STALE' },
    );

    // L5: Preparing takeover after STALE_AFTER succeeds with epoch + 1
    const lockTakeoverStaleOk = structuredClone(lockTakeoverNotStale);
    assert.equal(
        transitionLorebookBookLock(lock1, lockTakeoverStaleOk, {
            now: 1000 + LOREBOOK_LOCK_STALE_AFTER_MS + 10,
            throwFailures: true,
        }),
        true,
    );

    // L10: Same operationId with different runtimeId or epoch is rejected
    const lockSameOpSpoofedRuntime = structuredClone(lockTakeoverStaleOk);
    lockSameOpSpoofedRuntime.holder.runtimeId = 'rt-spoof';
    lockSameOpSpoofedRuntime.holder.phase = 'in-flight';
    lockSameOpSpoofedRuntime.history.push({
        action: 'in-flight',
        batchId: 'lorebook-review-1',
        attemptId: 'att-2',
        operationId: 'att-2',
        runtimeId: 'rt-spoof',
        epoch: 2,
        deviceId: 'dev-2',
        at: 32000,
        reason: '',
    });
    assert.equal(transitionLorebookBookLock(lockTakeoverStaleOk, lockSameOpSpoofedRuntime), false);

    // L2 -> L4 -> release
    const lockInFlightOk = structuredClone(lockTakeoverStaleOk);
    lockInFlightOk.holder.phase = 'in-flight';
    lockInFlightOk.history.push({
        action: 'in-flight',
        batchId: 'lorebook-review-1',
        attemptId: 'att-2',
        operationId: 'att-2',
        runtimeId: 'rt-2',
        epoch: 2,
        deviceId: 'dev-2',
        at: 32000,
        reason: '',
    });
    assert.equal(transitionLorebookBookLock(lockTakeoverStaleOk, lockInFlightOk, { now: 32000 }), true);

    const projected = projectLorebookBookLockRead(lockInFlightOk, { now: 37000 });
    assert.equal(projected.holder.remainingStaleMs, LOREBOOK_LOCK_STALE_AFTER_MS - 5000);

    // L6: Cross-device in-flight takeover requires BOTH staleness and userConfirmedRisk: true
    const lockInFlightTakeoverNoConfirm = structuredClone(lockInFlightOk);
    lockInFlightTakeoverNoConfirm.epoch = 3;
    lockInFlightTakeoverNoConfirm.holder = {
        ...lockInFlightOk.holder,
        attemptId: 'att-rec-3',
        operationId: 'att-rec-3',
        runtimeId: 'rt-3',
        epoch: 3,
        deviceId: 'dev-3',
        mode: 'reconcile',
        phase: 'ended',
        takeoverOf: { operationId: 'att-2', epoch: 2 },
    };
    lockInFlightTakeoverNoConfirm.history.push({
        action: 'takeover',
        batchId: 'lorebook-review-1',
        attemptId: 'att-rec-3',
        operationId: 'att-rec-3',
        runtimeId: 'rt-3',
        epoch: 3,
        deviceId: 'dev-3',
        evidence: 'heartbeatStale',
        takeoverOf: { operationId: 'att-2', epoch: 2 },
        at: 70000,
        reason: '跨设备超时接管',
    });
    assert.throws(
        () => transitionLorebookBookLock(lockInFlightOk, lockInFlightTakeoverNoConfirm, { now: 70000, throwFailures: true }),
        { code: 'LOREBOOK_TAKEOVER_CONFIRMATION_REQUIRED' },
    );

    const lockInFlightTakeoverConfirmed = structuredClone(lockInFlightTakeoverNoConfirm);
    lockInFlightTakeoverConfirmed.history.at(-1).userConfirmedRisk = true;
    assert.equal(
        transitionLorebookBookLock(lockInFlightOk, lockInFlightTakeoverConfirmed, { now: 70000, throwFailures: true }),
        true,
    );

    const lockReleased = structuredClone(lockInFlightTakeoverConfirmed);
    lockReleased.holder = null;
    lockReleased.history.push({
        action: 'release',
        batchId: 'lorebook-review-1',
        attemptId: 'att-rec-3',
        operationId: 'att-rec-3',
        runtimeId: 'rt-3',
        epoch: 3,
        deviceId: 'dev-3',
        at: 70010,
        reason: '',
    });
    assert.equal(transitionLorebookBookLock(lockInFlightTakeoverConfirmed, lockReleased), true);

    // L8: Late completion reopens conflict on released lock with epoch + 1
    const lockLateConflict = structuredClone(lockReleased);
    lockLateConflict.epoch = 4;
    lockLateConflict.holder = {
        batchId: 'lorebook-review-1',
        threadId: 'thread-1',
        attemptId: 'att-2',
        operationId: 'att-2',
        runtimeId: 'rt-2',
        epoch: 4,
        deviceId: 'dev-2',
        mode: 'apply',
        phase: 'conflict',
        acquiredAt: 70020,
    };
    lockLateConflict.history.push({
        action: 'conflict',
        batchId: 'lorebook-review-1',
        attemptId: 'att-2',
        operationId: 'att-2',
        runtimeId: 'rt-2',
        epoch: 4,
        deviceId: 'dev-2',
        at: 70020,
        reason: '旧在途写入迟到返回，重开冲突',
        lateCompletion: {
            operationId: 'att-2',
            endedBy: 'returned',
            observedFingerprint: 'fp-book-late',
            at: 70020,
        },
    });
    assert.equal(transitionLorebookBookLock(lockReleased, lockLateConflict), true);

    // L7: Conflict lock cannot be released without resolution matching operationId + basedOnFingerprint
    const lockConflictReleaseBad = structuredClone(lockLateConflict);
    lockConflictReleaseBad.holder = null;
    lockConflictReleaseBad.history.push({
        action: 'release',
        batchId: 'lorebook-review-1',
        attemptId: 'att-2',
        deviceId: 'dev-3',
        at: 70030,
        reason: '无证据释放',
    });
    assert.equal(transitionLorebookBookLock(lockLateConflict, lockConflictReleaseBad), false);

    const lockConflictReleaseOk = structuredClone(lockConflictReleaseBad);
    lockConflictReleaseOk.history.at(-1).resolution = {
        operationId: 'att-2',
        basedOnFingerprint: 'fp-book-late',
        choice: 'manual-fixed',
        resolvedByDeviceId: 'dev-3',
        resolvedAt: 70030,
    };
    assert.equal(transitionLorebookBookLock(lockLateConflict, lockConflictReleaseOk), true);

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

    // 5. In-flight step protection
    const sWritingInFlight = execStepRecord({
        state: 'writing',
        dispatchPhase: 'in-flight',
        fence: 2,
        attemptId: 'att-1',
        holderDeviceId: 'dev-1',
        baseline: stepBaseline(),
        execution: {
            state: 'in-flight',
            operationId: 'att-1',
            runtimeId: 'rt-1',
            deviceId: 'dev-1',
            epoch: 2,
        },
    });
    validateLorebookRecord('oracle-lorebook-exec-steps', sWritingInFlight);

    // Another attempt cannot mark an in-flight writing step as notWritten or unknown without abandoned takeover + observation
    const sInFlightTakeoverNotWritten = structuredClone(sWritingInFlight);
    sInFlightTakeoverNotWritten.state = 'notWritten';
    sInFlightTakeoverNotWritten.attemptId = 'att-rec-2';
    assert.equal(transitionLorebookExecStep(sWritingInFlight, sInFlightTakeoverNotWritten), false);

    const sInFlightTakeoverUnknown = structuredClone(sWritingInFlight);
    sInFlightTakeoverUnknown.state = 'unknown';
    sInFlightTakeoverUnknown.attemptId = 'att-rec-2';
    assert.equal(transitionLorebookExecStep(sWritingInFlight, sInFlightTakeoverUnknown), false);

    // Abandoned takeover with matchesBefore observation CAN settle to notWritten
    const sAbandonedMatchesBefore = structuredClone(sWritingInFlight);
    sAbandonedMatchesBefore.state = 'notWritten';
    sAbandonedMatchesBefore.dispatchPhase = 'settled';
    sAbandonedMatchesBefore.attemptId = 'att-rec-2';
    sAbandonedMatchesBefore.execution = {
        ...sWritingInFlight.execution,
        state: 'ended',
        endedBy: 'abandoned',
        endedAt: 1025,
    };
    sAbandonedMatchesBefore.observation = {
        result: 'matchesBefore',
        fingerprint: 'fp-book-1',
        observedAt: 1025,
        byOperationId: 'att-rec-2',
    };
    assert.equal(transitionLorebookExecStep(sWritingInFlight, sAbandonedMatchesBefore), true);
});

