import {
    bad, obj, keys, str, int, bool, one, array, unique, nullable,
    validateCloudConnectionId, validateOracleIdentity, validateOracleRecipe,
    validatePromptProfiles, validateThreadIndexEntries,
} from './oracle-validation.js';
import { fail as failRecord } from '../account-records/validation.js';

export const validateLorebookIdentity = validateOracleIdentity;
export const LOREBOOK_LOCK_STALE_AFTER_MS = 30000;
export const LOREBOOK_LOCK_MIGRATION_RECORD_ID = 'lorebook-lock-migration:v1';

const LOREBOOK_SOURCES = Object.freeze([
    'safety-contract',
    'macro-legend',
    'selected-lorebooks',
    'main-chat',
    'manager-history',
    'edit-protocol',
    'current-input',
]);

const LOREBOOK_PROTECTED_SOURCES = Object.freeze([
    'safety-contract',
    'macro-legend',
    'selected-lorebooks',
    'edit-protocol',
    'current-input',
]);

const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const ACTIONS = ['create', 'edit', 'patch', 'append', 'prepend', 'delete'];
const STEP_STATES = [
    'pending',
    'writing',
    'verified',
    'notWritten',
    'unknown',
    'undoing',
    'undone',
    'undoBlocked',
    'undoUnknown',
    'conflict',
    'pruned',
];
const STEP_DISPATCH_PHASES = [
    'idle',
    'preparing',
    'in-flight',
    'settled',
];
const STEP_EXECUTION_STATES = ['preparing', 'in-flight', 'ended'];
const STEP_ENDED_BY = ['returned', 'threw', 'abandoned'];
const STEP_OBSERVATION_RESULTS = ['matchesAfter', 'matchesBefore', 'diverged', 'unreadable'];
const CANONICAL_LOCK_HOLDER_PHASES = [
    'preparing',
    'in-flight',
    'ended',
    'conflict',
    'legacy-unresolved',
];
const LOCK_HOLDER_PHASES = [
    ...CANONICAL_LOCK_HOLDER_PHASES,
    'unknown',
    'undo-unknown',
    'reconcile',
];
const TERMINAL_OR_PRUNABLE_STEP_STATES = new Set([
    'verified',
    'notWritten',
    'undone',
    'undoBlocked',
    'conflict',
    'pruned',
]);
const EXEC_STAGES = [
    'frozen',
    'running',
    'settled',
    'undo-running',
    'undo-settled',
    'pruned',
];
const EXEC_STATUSES = [
    'applying',
    'applied',
    'partial',
    'failed',
    'unknown',
    'conflict',
    'undoing',
    'undone',
    'undo-partial',
    'undo-failed',
    'undo-unknown',
    'pruned',
];

function safeDict(v, maxKeys = 128) {
    if (!obj(v)) bad();
    const entries = Object.entries(v);
    if (entries.length > maxKeys) bad();
    for (const [k] of entries) {
        if (FORBIDDEN_KEYS.has(k) || !k || k.length > 512 || k.includes('\0')) bad();
    }
    return entries;
}

function validateSafeJsonValue(v, depth = 0) {
    if (depth > 8) bad();
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'number') {
        if (!Number.isFinite(v)) bad();
        return;
    }
    if (typeof v === 'string') {
        str(v, 250000);
        return;
    }
    if (Array.isArray(v)) {
        if (v.length > 1024) bad();
        for (const item of v) validateSafeJsonValue(item, depth + 1);
        return;
    }
    if (obj(v)) {
        const entries = safeDict(v, 256);
        for (const [, val] of entries) validateSafeJsonValue(val, depth + 1);
        return;
    }
    bad();
}

function numOrNull(v) {
    if (v === null) return;
    if (typeof v !== 'number' || !Number.isFinite(v)) bad();
}

export function validateLorebookRecipe(v) {
    validateOracleRecipe(v, {
        sources: LOREBOOK_SOURCES,
        protectedSources: LOREBOOK_PROTECTED_SOURCES,
        requiredSources: LOREBOOK_PROTECTED_SOURCES,
        validateOptions(source, options) {
            if (source === 'main-chat') {
                keys(options, 'depth,includeHidden');
                int(options.depth, -1, 500);
                bool(options.includeHidden);
            } else {
                keys(options, '');
            }
        },
    });
}

export function validateLorebookSettings(p) {
    keys(p, 'settingsVersion,connectionId,tokenBudget,recipe,promptProfiles');
    if (p.settingsVersion !== 4) bad();
    validateCloudConnectionId(p.connectionId);
    int(p.tokenBudget, 0, 1000000);
    validateLorebookRecipe(p.recipe);
    validatePromptProfiles(p.promptProfiles, {
        payloadKeys: 'recipe,tokenBudget',
        validatePayload(payload) {
            validateLorebookRecipe(payload.recipe);
            int(payload.tokenBudget, 0, 1000000);
        },
    });
    return p;
}

export const lorebookSettingsConsumer = Object.freeze({
    id: 'oracle-lorebook-settings',
    schemaVersion: 1,
    maxBytes: 2 * 1024 * 1024,
    limits: { maxProfiles: 100, maxRecipeNodes: 128 },
    validate: validateLorebookSettings,
});

function validatePreviewChange(change) {
    keys(change, 'label,before,after');
    str(change.label, 80, false);
    validateSafeJsonValue(change.before, 6);
    validateSafeJsonValue(change.after, 6);
}

function validateNormalizedEntry(e, allowNullUid = false) {
    if (!obj(e)) bad();
    const allowed = new Set([
        'book', 'uid', 'name', 'enabled', 'strategy', 'position',
        'content', 'probability', 'recursion', 'effect', 'extra',
        'rawFingerprint', 'sourceSchema',
    ]);
    for (const k of Object.keys(e)) {
        if (!allowed.has(k)) bad();
    }
    str(e.book, 512, false);
    if (allowNullUid && e.uid === null) {
        // create preview before-snapshot has uid: null
    } else {
        int(e.uid, 0, 10000000);
    }
    str(e.name, 512, false);
    bool(e.enabled);
    if (!obj(e.strategy)) bad();
    one(e.strategy.type, ['constant', 'selective', 'vectorized']);
    array(e.strategy.keys, 256, k => str(k, 512, false));
    if (!obj(e.strategy.keys_secondary)) bad();
    one(e.strategy.keys_secondary.logic, ['and_any', 'and_all', 'not_all', 'not_any']);
    array(e.strategy.keys_secondary.keys, 256, k => str(k, 512, false));
    if (e.strategy.scan_depth !== undefined && e.strategy.scan_depth !== null && e.strategy.scan_depth !== 'same_as_global') {
        int(e.strategy.scan_depth, 0, 10000);
    }
    if (!obj(e.position)) bad();
    nullable(e.position.type, t => str(t, 128, false));
    nullable(e.position.role, r => str(r, 64, false));
    numOrNull(e.position.depth);
    numOrNull(e.position.order);
    str(e.content, 250000);
    if (e.probability !== undefined) numOrNull(e.probability);
    if (!obj(e.recursion)) bad();
    bool(e.recursion.prevent_incoming);
    bool(e.recursion.prevent_outgoing);
    if (e.recursion.delay_until !== undefined) numOrNull(e.recursion.delay_until);
    if (e.effect !== undefined) {
        if (!obj(e.effect)) bad();
        numOrNull(e.effect.sticky ?? null);
        numOrNull(e.effect.cooldown ?? null);
        numOrNull(e.effect.delay ?? null);
    }
    if (e.extra !== undefined) validateSafeJsonValue(e.extra, 3);
    if (e.rawFingerprint !== undefined && e.rawFingerprint !== null) str(e.rawFingerprint, 128, false);
    if (e.sourceSchema !== undefined) one(e.sourceSchema, ['official', 'legacy']);
}

function validateOperation(op) {
    keys(op, 'index,action,book,uid,anchor,replace,fields');
    int(op.index, 1, 10000);
    one(op.action, ACTIONS);
    str(op.book, 512, false);
    nullable(op.uid, u => int(u, 0, 10000000));
    str(op.anchor, 100000);
    nullable(op.replace, r => str(r, 250000));
    if (!obj(op.fields)) bad();
    const allowedFields = new Set([
        'comment', 'key', 'keysecondary', 'constant', 'disable', 'selective',
        'excludeRecursion', 'preventRecursion', 'order', 'position', 'depth', 'content',
    ]);
    for (const [k, v] of Object.entries(op.fields)) {
        if (!allowedFields.has(k)) bad();
        if (['constant', 'disable', 'selective', 'excludeRecursion', 'preventRecursion'].includes(k)) {
            bool(v);
        } else if (['order', 'position', 'depth'].includes(k)) {
            if (typeof v !== 'number' || !Number.isFinite(v)) bad();
        } else if (['key', 'keysecondary'].includes(k)) {
            array(v, 256, item => str(item, 512, false));
        } else if (k === 'comment') {
            str(v, 512);
        } else if (k === 'content') {
            str(v, 250000);
        }
    }
}

function validateMutation(m) {
    if (!obj(m)) bad();
    one(m.kind, ['content-patch', 'content-append', 'content-prepend', 'delete-entry', 'create-entry', 'field-update']);
    if (m.kind === 'content-patch') {
        keys(m, 'kind,anchor,replacement');
        str(m.anchor, 100000, false);
        str(m.replacement, 250000);
    } else if (m.kind === 'content-append' || m.kind === 'content-prepend') {
        keys(m, 'kind,content');
        str(m.content, 250000, false);
    } else if (m.kind === 'delete-entry') {
        keys(m, 'kind');
    } else {
        keys(m, 'kind,fields');
        array(m.fields, 32, f => {
            keys(f, 'path,value');
            str(f.path, 128, false);
            validateSafeJsonValue(f.value, 5);
        });
    }
}

function validateOriginalPreview(pr) {
    if (!obj(pr)) bad();
    const allowed = new Set([
        'schema', 'index', 'action', 'target', 'mutation', 'book', 'uid',
        'kind', 'title', 'before', 'after', 'sourceFingerprint',
        'predecessorFingerprint', 'bookFingerprint', 'changes',
    ]);
    for (const k of Object.keys(pr)) {
        if (!allowed.has(k)) bad();
    }
    int(pr.index, 1, 10000);
    one(pr.action, ACTIONS);
    str(pr.book, 512, false);
    nullable(pr.uid ?? null, u => int(u, 0, 10000000));
    str(pr.title, 512);
    nullable(pr.sourceFingerprint ?? null, s => str(s, 128, false));
    if (pr.predecessorFingerprint !== undefined && pr.predecessorFingerprint !== null) {
        str(pr.predecessorFingerprint, 128, false);
    }
    str(pr.bookFingerprint, 128, false);
    if (pr.mutation !== undefined) validateMutation(pr.mutation);
    if (pr.before !== undefined && pr.before !== null) validateNormalizedEntry(pr.before, true);
    if (pr.after !== undefined && pr.after !== null) validateNormalizedEntry(pr.after, true);
    array(pr.changes, 32, validatePreviewChange);
}

function validateMessagePreview(lp) {
    if (!obj(lp)) bad();
    const allowed = new Set([
        'blockCount', 'safeCount', 'schema', 'previews',
        'errors', 'readonly', 'reviewBatchId',
    ]);
    for (const k of Object.keys(lp)) {
        if (!allowed.has(k)) bad();
    }
    int(lp.blockCount, 0, 1000);
    int(lp.safeCount, 0, 1000);
    if (lp.schema !== undefined) int(lp.schema, 1, 10);
    bool(lp.readonly);
    if (lp.reviewBatchId !== undefined && lp.reviewBatchId !== null) {
        str(lp.reviewBatchId, 128, false);
    }
    array(lp.previews, 256, item => {
        if (!obj(item)) bad();
        int(item.index, 1, 10000);
        one(item.action, ACTIONS);
        str(item.book, 512, false);
        nullable(item.uid ?? null, u => int(u, 0, 10000000));
        str(item.title, 512);
        nullable(item.sourceFingerprint ?? null, s => str(s, 128, false));
        if (item.predecessorFingerprint !== undefined && item.predecessorFingerprint !== null) {
            str(item.predecessorFingerprint, 128, false);
        }
        str(item.bookFingerprint, 128, false);
        array(item.changes, 32, validatePreviewChange);
    });
    array(lp.errors, 256, err => {
        if (!obj(err)) bad();
        int(err.index, 1, 10000);
        str(err.message, 2000, false);
    });
}

function validateMessageGeneration(gen) {
    keys(gen, 'state,reviewBatchId,deviceId,updatedAt,allowedBooks,bookFingerprints,sourceEntries');
    one(gen.state, ['pending-reply', 'batch-pending', 'batch-saved', 'interrupted']);
    str(gen.reviewBatchId, 128, false);
    str(gen.deviceId, 64, false);
    int(gen.updatedAt);
    array(gen.allowedBooks, 128, b => str(b, 512, false));
    unique(gen.allowedBooks);
    for (const [k, v] of safeDict(gen.bookFingerprints, 128)) {
        str(k, 512, false);
        str(v, 128, false);
    }
    array(gen.sourceEntries, 2048, e => validateNormalizedEntry(e));
}

function validateReceipt(r) {
    if (!obj(r)) bad();
    const allowed = new Set([
        'index', 'action', 'book', 'uid', 'beforeIndex',
        'beforeRaw', 'beforeFingerprint', 'afterFingerprint',
        'afterRawFingerprint', 'undoable',
    ]);
    for (const k of Object.keys(r)) {
        if (!allowed.has(k)) bad();
    }
    int(r.index, 1, 10000);
    one(r.action, ACTIONS);
    str(r.book, 512, false);
    nullable(r.uid ?? null, u => int(u, 0, 10000000));
    nullable(r.beforeIndex ?? null, idx => int(idx, 0, 100000));
    if (r.beforeRaw !== undefined && r.beforeRaw !== null) {
        if (!obj(r.beforeRaw)) bad();
        validateSafeJsonValue(r.beforeRaw, 2);
    }
    nullable(r.beforeFingerprint ?? null, s => str(s, 128, false));
    nullable(r.afterFingerprint ?? null, s => str(s, 128, false));
    if (r.afterRawFingerprint !== undefined && r.afterRawFingerprint !== null) {
        str(r.afterRawFingerprint, 128, false);
    }
    bool(r.undoable);
}

function validateImportedApplication(app) {
    if (!obj(app)) bad();
    one(app.status, ['applying', 'applied', 'partial', 'failed']);
    int(app.startedAt);
    if (app.finishedAt !== undefined && app.finishedAt !== null) int(app.finishedAt);
    if (app.reviewFingerprint !== undefined && app.reviewFingerprint !== null) str(app.reviewFingerprint, 128);
    if (app.requestedBooks !== undefined) array(app.requestedBooks, 128, b => str(b, 512, false));
    if (app.appliedBooks !== undefined) array(app.appliedBooks, 128, b => str(b, 512, false));
    if (app.skippedBooks !== undefined) array(app.skippedBooks, 128, b => str(b, 512, false));
    if (app.operationCount !== undefined) int(app.operationCount, 0, 10000);
    if (app.error !== undefined) str(app.error, 2000);
    if (app.receipts !== undefined) array(app.receipts, 256, validateReceipt);
    if (app.undo !== undefined && app.undo !== null) {
        if (!obj(app.undo)) bad();
        one(app.undo.status, ['undoing', 'undone', 'partial', 'failed']);
    }
}

function validateThreadRecord(p) {
    keys(p, 'identity,thread');
    validateLorebookIdentity(p.identity);
    keys(p.thread, 'id,title,autoTitle,createdAt,updatedAt,messages');
    str(p.thread.id, 128, false);
    str(p.thread.title, 60, false);
    bool(p.thread.autoTitle);
    int(p.thread.createdAt);
    int(p.thread.updatedAt);
    array(p.thread.messages, 80, m => {
        if (!obj(m)) bad();
        const allowed = new Set([
            'id', 'role', 'content', 'prompt', 'failed',
            'meta', 'lorebookPreview', 'lorebookGeneration',
        ]);
        for (const k of Object.keys(m)) {
            if (!allowed.has(k)) bad();
        }
        str(m.id, 256, false);
        one(m.role, ['user', 'assistant']);
        str(m.content, 400000);
        if (m.prompt !== undefined) bool(m.prompt);
        if (m.failed !== undefined) bool(m.failed);
        if (m.meta !== undefined) str(m.meta, 2000);
        if (m.lorebookPreview !== undefined) {
            if (m.role !== 'assistant') bad();
            validateMessagePreview(m.lorebookPreview);
        }
        if (m.lorebookGeneration !== undefined && m.lorebookGeneration !== null) {
            validateMessageGeneration(m.lorebookGeneration);
        }
    });
    unique(p.thread.messages, 'id');
}

function validateWorkspaceRecord(p) {
    keys(p, 'identity,threadId,workspace');
    validateLorebookIdentity(p.identity);
    str(p.threadId, 128, false);
    const w = p.workspace;
    keys(w, 'mode,selectedBooks,selectedEntries,wholeBooks,draft,reviewDrafts,updatedAt');
    one(w.mode, ['active', 'selected']);
    array(w.selectedBooks, 128, b => str(b, 512, false));
    unique(w.selectedBooks);
    const selectedEntries = safeDict(w.selectedEntries, 128);
    let totalSelected = 0;
    for (const [book, ids] of selectedEntries) {
        str(book, 512, false);
        array(ids, 4096, x => int(x, 0, 10000000));
        unique(ids);
        totalSelected += ids.length;
    }
    if (totalSelected > 8192) bad();
    array(w.wholeBooks, 128, b => str(b, 512, false));
    unique(w.wholeBooks);
    str(w.draft, 40000);
    for (const [itemId, draftText] of safeDict(w.reviewDrafts, 128)) {
        str(itemId, 256, false);
        str(draftText, 60000);
    }
    int(w.updatedAt);
}

function validateBatchRecord(p) {
    keys(p, 'identity,threadId,batch');
    validateLorebookIdentity(p.identity);
    str(p.threadId, 128, false);
    const b = p.batch;
    keys(
        b,
        'schema,id,messageId,createdAt,updatedAt,allowedBooks,bookFingerprints,sourceEntries,blockedErrors,items,frozenBy,importedApplication',
    );
    if (b.schema !== 1) bad();
    str(b.id, 128, false);
    str(b.messageId, 256, false);
    int(b.createdAt);
    int(b.updatedAt);
    array(b.allowedBooks, 128, book => str(book, 512, false));
    unique(b.allowedBooks);
    for (const [book, fp] of safeDict(b.bookFingerprints, 128)) {
        str(book, 512, false);
        str(fp, 128, false);
    }
    array(b.sourceEntries, 2048, e => validateNormalizedEntry(e));
    array(b.blockedErrors, 256, err => {
        if (!obj(err)) bad();
        int(err.index, 1, 10000);
        str(err.message, 2000, false);
    });
    array(b.items, 256, item => {
        keys(item, 'id,index,status,operation,originalPreview');
        str(item.id, 256, false);
        int(item.index, 1, 10000);
        one(item.status, ['pending', 'accepted', 'rejected']);
        validateOperation(item.operation);
        validateOriginalPreview(item.originalPreview);
    });
    unique(b.items, 'id');
    nullable(b.frozenBy, f => {
        keys(f, 'executionId,reviewFingerprint,frozenAt,deviceId');
        str(f.executionId, 128, false);
        str(f.reviewFingerprint, 128, false);
        int(f.frozenAt);
        str(f.deviceId, 64, false);
    });
    nullable(b.importedApplication, validateImportedApplication);
    if (b.frozenBy !== null && b.importedApplication !== null) bad();
}

export function transitionLorebookBatch(prev, next) {
    if (!prev) return true;
    if (
        prev.identity.kind !== next.identity.kind
        || prev.identity.owner !== next.identity.owner
        || prev.identity.chat !== next.identity.chat
        || prev.threadId !== next.threadId
        || prev.batch.id !== next.batch.id
        || prev.batch.messageId !== next.batch.messageId
        || prev.batch.createdAt !== next.batch.createdAt
    ) {
        return false;
    }
    // Imported historical applications are read-only snapshots
    if (prev.batch.importedApplication !== null || next.batch.importedApplication !== null) {
        return false;
    }
    // Once frozenBy is set, the batch is completely immutable
    if (prev.batch.frozenBy !== null) {
        return false;
    }
    // Source snapshot & allowed books of a batch cannot be mutated after creation
    if (
        JSON.stringify(prev.batch.allowedBooks) !== JSON.stringify(next.batch.allowedBooks)
        || JSON.stringify(prev.batch.bookFingerprints) !== JSON.stringify(next.batch.bookFingerprints)
        || JSON.stringify(prev.batch.sourceEntries) !== JSON.stringify(next.batch.sourceEntries)
        || JSON.stringify(prev.batch.blockedErrors) !== JSON.stringify(next.batch.blockedErrors)
    ) {
        return false;
    }
    return true;
}

function validateExecutionRecord(p) {
    keys(
        p,
        'schema,identity,threadId,batchId,messageId,reviewFingerprint,stage,status,activeAttemptId,holderDeviceId,books,stepOrder,undoOrder,startedAt,updatedAt,finishedAt,error,history',
    );
    if (p.schema !== 1) bad();
    validateLorebookIdentity(p.identity);
    str(p.threadId, 128, false);
    str(p.batchId, 128, false);
    str(p.messageId, 256, false);
    str(p.reviewFingerprint, 128, false);
    one(p.stage, EXEC_STAGES);
    one(p.status, EXEC_STATUSES);
    nullable(p.activeAttemptId, v => str(v, 96, false));
    nullable(p.holderDeviceId, v => str(v, 64, false));
    array(p.books, 128, b => {
        keys(b, 'book,stepRecordId,state,operationCount,updatedAt,error');
        str(b.book, 512, false);
        str(b.stepRecordId, 128, false);
        one(b.state, STEP_STATES);
        int(b.operationCount, 1, 256);
        int(b.updatedAt);
        str(b.error, 2000);
    });
    if (p.books.length < 1) bad();
    unique(p.books, 'book');
    array(p.stepOrder, 128, b => str(b, 512, false));
    unique(p.stepOrder);
    array(p.undoOrder, 128, b => str(b, 512, false));
    unique(p.undoOrder);
    if (p.stepOrder.length !== p.books.length) bad();
    int(p.startedAt);
    int(p.updatedAt);
    nullable(p.finishedAt, v => int(v));
    str(p.error, 2000);
    array(p.history, 32, h => {
        keys(h, 'attemptId,deviceId,action,stage,status,at,note');
        str(h.attemptId, 96, false);
        str(h.deviceId, 64, false);
        str(h.action, 64, false);
        one(h.stage, EXEC_STAGES);
        one(h.status, EXEC_STATUSES);
        int(h.at);
        str(h.note, 500);
    });
}

export function transitionLorebookExecution(prev, next) {
    if (!prev) {
        return ['frozen', 'running'].includes(next.stage);
    }
    if (
        prev.identity.kind !== next.identity.kind
        || prev.identity.owner !== next.identity.owner
        || prev.identity.chat !== next.identity.chat
        || prev.threadId !== next.threadId
        || prev.batchId !== next.batchId
        || prev.messageId !== next.messageId
        || prev.reviewFingerprint !== next.reviewFingerprint
        || JSON.stringify(prev.stepOrder) !== JSON.stringify(next.stepOrder)
    ) {
        return false;
    }
    const from = prev.stage;
    const to = next.stage;
    if (from === 'pruned') {
        return to === 'pruned' && next.books.every(b => b.state === 'pruned');
    }
    if (to === 'pruned') {
        if (!['settled', 'undo-settled'].includes(from)) return false;
        return next.books.every(b => b.state === 'pruned');
    }
    if (from === 'frozen') {
        return ['frozen', 'running', 'settled'].includes(to);
    }
    if (from === 'running') {
        return ['running', 'settled'].includes(to);
    }
    if (from === 'settled') {
        if (to === 'settled' || to === 'running') return true;
        if (to === 'undo-running') {
            const hasVerified = prev.books.some(b => b.state === 'verified');
            const hasActiveOrUnknown = prev.books.some(b =>
                ['writing', 'undoing', 'unknown', 'undoUnknown', 'conflict'].includes(b.state),
            );
            return hasVerified && !hasActiveOrUnknown;
        }
        return false;
    }
    if (from === 'undo-running') {
        return ['undo-running', 'undo-settled'].includes(to);
    }
    if (from === 'undo-settled') {
        return ['undo-settled', 'undo-running'].includes(to);
    }
    return false;
}

function validateStepBaseline(b) {
    keys(b, 'beforeBookFingerprint,afterPlannedBookFingerprint,targets,pendingReceipts');
    str(b.beforeBookFingerprint, 128, false);
    str(b.afterPlannedBookFingerprint, 128, false);
    array(b.targets, 256, t => {
        keys(
            t,
            'uid,finalAction,initialExists,initialIndex,initialRaw,initialRawFingerprint,initialEntryFingerprint,finalExists,finalPlannedRawFingerprint,finalEntryFingerprint,plannedFields',
        );
        int(t.uid, 0, 10000000);
        one(t.finalAction, ACTIONS);
        bool(t.initialExists);
        nullable(t.initialIndex, idx => int(idx, 0, 100000));
        if (t.initialRaw !== null) {
            if (!obj(t.initialRaw)) bad();
            validateSafeJsonValue(t.initialRaw, 2);
        }
        nullable(t.initialRawFingerprint, s => str(s, 128, false));
        nullable(t.initialEntryFingerprint, s => str(s, 128, false));
        bool(t.finalExists);
        nullable(t.finalPlannedRawFingerprint, s => str(s, 128, false));
        nullable(t.finalEntryFingerprint, s => str(s, 128, false));
        array(t.plannedFields, 32, f => {
            keys(f, 'path,value');
            str(f.path, 128, false);
            validateSafeJsonValue(f.value, 5);
        });
    });
    if (b.targets.length < 1) bad();
    array(b.pendingReceipts, 256, validateReceipt);
}

function validateStepVerification(v) {
    keys(v, 'afterBookFingerprint,receipts,verifiedAt,persistenceMode');
    str(v.afterBookFingerprint, 128, false);
    array(v.receipts, 256, validateReceipt);
    int(v.verifiedAt);
    str(v.persistenceMode, 64, false);
}

function validateStepReconciliation(r) {
    keys(r, 'outcome,reason,evidenceDigest,reconciledAt,deviceId');
    one(r.outcome, ['verified', 'notWritten', 'undone', 'conflict']);
    str(r.reason, 1000);
    str(r.evidenceDigest, 128, false);
    int(r.reconciledAt);
    str(r.deviceId, 64, false);
}

function validateStepExecutionInfo(ex) {
    if (!obj(ex)) bad();
    const required = ['state', 'operationId', 'runtimeId', 'deviceId', 'epoch'];
    const allowed = new Set([...required, 'endedBy', 'endedAt']);
    for (const k of required) {
        if (!(k in ex)) bad();
    }
    for (const k of Object.keys(ex)) {
        if (!allowed.has(k)) bad();
    }
    one(ex.state, STEP_EXECUTION_STATES);
    str(ex.operationId, 96, false);
    nullable(ex.runtimeId, v => str(v, 96, false));
    str(ex.deviceId, 64, false);
    int(ex.epoch, 0, 1000000000);
    if (ex.endedBy !== undefined && ex.endedBy !== null) {
        one(ex.endedBy, STEP_ENDED_BY);
    }
    if (ex.endedAt !== undefined && ex.endedAt !== null) {
        int(ex.endedAt);
    }
    if (ex.state === 'ended' && !STEP_ENDED_BY.includes(ex.endedBy)) bad();
}

function validateStepObservationInfo(obs) {
    if (!obj(obs)) bad();
    keys(obs, 'result,fingerprint,observedAt,byOperationId');
    one(obs.result, STEP_OBSERVATION_RESULTS);
    nullable(obs.fingerprint, v => str(v, 128, false));
    int(obs.observedAt);
    str(obs.byOperationId, 96, false);
}

function validateStepResolutionInfo(res) {
    if (!obj(res)) bad();
    const required = ['state'];
    const allowed = new Set(['state', 'choice', 'basedOnFingerprint', 'resolvedAt', 'resolvedBy', 'operationId', 'note']);
    for (const k of required) {
        if (!(k in res)) bad();
    }
    for (const k of Object.keys(res)) {
        if (!allowed.has(k)) bad();
    }
    one(res.state, ['none', 'resolved']);
    if (res.choice !== undefined && res.choice !== null) {
        one(res.choice, ['acknowledged', 'manual-fixed']);
    }
    if (res.basedOnFingerprint !== undefined && res.basedOnFingerprint !== null) {
        str(res.basedOnFingerprint, 128, false);
    }
    if (res.resolvedAt !== undefined && res.resolvedAt !== null) {
        int(res.resolvedAt);
    }
    if (res.resolvedBy !== undefined && res.resolvedBy !== null) {
        str(res.resolvedBy, 64, false);
    }
    if (res.operationId !== undefined && res.operationId !== null) {
        str(res.operationId, 96, false);
    }
    if (res.note !== undefined && res.note !== null) {
        str(res.note, 1000);
    }
}

function validateLateCompletionEntry(lc) {
    if (!obj(lc)) bad();
    keys(lc, 'operationId,endedBy,observedFingerprint,at');
    str(lc.operationId, 96, false);
    one(lc.endedBy, ['returned', 'threw']);
    nullable(lc.observedFingerprint, v => str(v, 128, false));
    int(lc.at);
}

function validateStepUndo(u) {
    if (!obj(u)) bad();
    const required = ['status', 'attemptId', 'deviceId', 'startedAt', 'finishedAt', 'afterBookFingerprint', 'error'];
    const allowed = new Set([...required, 'execution', 'observation', 'resolution', 'lateCompletions']);
    for (const k of required) {
        if (!(k in u)) bad();
    }
    for (const k of Object.keys(u)) {
        if (!allowed.has(k)) bad();
    }
    one(u.status, ['undoing', 'undone', 'undoBlocked', 'undoUnknown', 'conflict']);
    str(u.attemptId, 96, false);
    str(u.deviceId, 64, false);
    int(u.startedAt);
    nullable(u.finishedAt, t => int(t));
    nullable(u.afterBookFingerprint, s => str(s, 128, false));
    str(u.error, 2000);
    if (u.execution !== undefined && u.execution !== null) validateStepExecutionInfo(u.execution);
    if (u.observation !== undefined && u.observation !== null) validateStepObservationInfo(u.observation);
    if (u.resolution !== undefined && u.resolution !== null) validateStepResolutionInfo(u.resolution);
    if (u.lateCompletions !== undefined && u.lateCompletions !== null) {
        array(u.lateCompletions, 16, validateLateCompletionEntry);
    }
}

function validateConflictResolution(c) {
    if (!obj(c)) bad();
    const required = ['resolvedByDeviceId', 'resolvedAt', 'resolution', 'note'];
    const allowed = new Set([...required, 'basedOnFingerprint', 'operationId']);
    for (const k of required) {
        if (!(k in c)) bad();
    }
    for (const k of Object.keys(c)) {
        if (!allowed.has(k)) bad();
    }
    str(c.resolvedByDeviceId, 64, false);
    int(c.resolvedAt);
    one(c.resolution, ['acknowledged', 'manual-fixed']);
    str(c.note, 1000);
    if (c.basedOnFingerprint !== undefined && c.basedOnFingerprint !== null) {
        str(c.basedOnFingerprint, 128, false);
    }
    if (c.operationId !== undefined && c.operationId !== null) {
        str(c.operationId, 96, false);
    }
}

function validateExecStepRecord(p) {
    if (!obj(p)) bad();
    const required = [
        'schema', 'identity', 'threadId', 'batchId', 'book', 'stepIndex',
        'state', 'attemptId', 'holderDeviceId', 'allocatedUids', 'baseline',
        'verification', 'reconciliation', 'undo', 'conflictResolution',
        'error', 'updatedAt', 'history',
    ];
    const allowed = new Set([
        ...required,
        'dispatchPhase',
        'fence',
        'execution',
        'observation',
        'resolution',
        'lateCompletions',
    ]);
    for (const k of required) {
        if (!(k in p)) bad();
    }
    for (const k of Object.keys(p)) {
        if (!allowed.has(k)) bad();
    }
    if (p.schema !== 1) bad();
    validateLorebookIdentity(p.identity);
    str(p.threadId, 128, false);
    str(p.batchId, 128, false);
    str(p.book, 512, false);
    int(p.stepIndex, 0, 128);
    one(p.state, STEP_STATES);
    if (p.dispatchPhase !== undefined && p.dispatchPhase !== null) {
        one(p.dispatchPhase, STEP_DISPATCH_PHASES);
    }
    if (p.fence !== undefined && p.fence !== null) {
        int(p.fence, 0, 1000000000);
    }
    if (p.execution !== undefined && p.execution !== null) validateStepExecutionInfo(p.execution);
    if (p.observation !== undefined && p.observation !== null) validateStepObservationInfo(p.observation);
    if (p.resolution !== undefined && p.resolution !== null) validateStepResolutionInfo(p.resolution);
    if (p.lateCompletions !== undefined && p.lateCompletions !== null) {
        array(p.lateCompletions, 16, validateLateCompletionEntry);
    }
    nullable(p.attemptId, v => str(v, 96, false));
    nullable(p.holderDeviceId, v => str(v, 64, false));
    for (const [k, uidVal] of safeDict(p.allocatedUids, 256)) {
        if (!/^\d{1,5}$/.test(k)) bad();
        int(uidVal, 0, 1000000);
    }
    nullable(p.baseline, validateStepBaseline);
    nullable(p.verification, validateStepVerification);
    nullable(p.reconciliation, validateStepReconciliation);
    nullable(p.undo, validateStepUndo);
    nullable(p.conflictResolution, validateConflictResolution);
    str(p.error, 2000);
    int(p.updatedAt);
    array(p.history, 32, h => {
        keys(h, 'from,to,attemptId,deviceId,at,note');
        nullable(h.from, s => one(s, STEP_STATES));
        one(h.to, STEP_STATES);
        str(h.attemptId, 96, false);
        str(h.deviceId, 64, false);
        int(h.at);
        str(h.note, 500);
    });

    if (p.state === 'writing' && (p.baseline === null || p.attemptId === null || p.holderDeviceId === null)) {
        bad();
    }
    if (p.state === 'verified' && p.verification === null) {
        bad();
    }
    if (p.state === 'undoing' && (p.undo === null || p.undo.status !== 'undoing' || p.attemptId === null)) {
        bad();
    }
    if (p.state === 'pruned' && p.baseline !== null) {
        bad();
    }
}

function isAppendOnlyLateCompletions(prevList, nextList) {
    if (!Array.isArray(prevList) || prevList.length === 0) return true;
    if (!Array.isArray(nextList) || nextList.length < prevList.length) return false;
    for (let i = 0; i < prevList.length; i += 1) {
        if (JSON.stringify(prevList[i]) !== JSON.stringify(nextList[i])) return false;
    }
    return true;
}

function hasAddedLateCompletion(prev, next) {
    const prevCount = (prev?.lateCompletions?.length || 0) + (prev?.undo?.lateCompletions?.length || 0);
    const nextCount = (next?.lateCompletions?.length || 0) + (next?.undo?.lateCompletions?.length || 0);
    return nextCount > prevCount;
}

export function transitionLorebookExecStep(prev, next) {
    if (!prev) {
        return ['pending', 'writing'].includes(next.state);
    }
    if (
        prev.identity.kind !== next.identity.kind
        || prev.identity.owner !== next.identity.owner
        || prev.identity.chat !== next.identity.chat
        || prev.threadId !== next.threadId
        || prev.batchId !== next.batchId
        || prev.book !== next.book
        || prev.stepIndex !== next.stepIndex
    ) {
        return false;
    }
    if (prev.fence != null && next.fence != null && next.fence < prev.fence) {
        return false;
    }
    // Pre-allocated create UIDs cannot be altered once assigned
    for (const [k, uidVal] of Object.entries(prev.allocatedUids || {})) {
        if (next.allocatedUids?.[k] !== uidVal) return false;
    }

    // §3.3 Step invariants:
    // 1. lateCompletions is append-only
    if (!isAppendOnlyLateCompletions(prev.lateCompletions, next.lateCompletions)) {
        return false;
    }
    if (prev.undo?.lateCompletions && !isAppendOnlyLateCompletions(prev.undo.lateCompletions, next.undo?.lateCompletions)) {
        return false;
    }
    // 2. execution.ended can only be written by matching operationId (returned/threw) or abandoned takeover
    if (prev.execution && next.execution) {
        if (prev.execution.state !== 'ended' && next.execution.state === 'ended') {
            const isOwnerEnd = next.execution.operationId === prev.execution.operationId
                && ['returned', 'threw'].includes(next.execution.endedBy);
            const isAbandoned = next.execution.endedBy === 'abandoned';
            if (!isOwnerEnd && !isAbandoned) return false;
        }
        if (prev.execution.state === 'ended' && next.execution.state !== 'ended') {
            if (
                !(next.execution.epoch > prev.execution.epoch && next.execution.operationId !== prev.execution.operationId)
            ) {
                return false;
            }
        }
    }
    // 3. resolution can only be written after execution has ended
    const nextResolved = next.conflictResolution !== null || next.resolution?.state === 'resolved';
    if (nextResolved) {
        if (next.execution && next.execution.state !== 'ended') return false;
        if (!next.execution && prev.execution && prev.execution.state !== 'ended') return false;
        if (next.dispatchPhase === 'in-flight') return false;
    }

    const from = prev.state;
    const to = next.state;

    if (from === 'pruned') {
        return false;
    }
    if (to === 'pruned') {
        if (!TERMINAL_OR_PRUNABLE_STEP_STATES.has(from)) return false;
        if (from === 'conflict' && prev.conflictResolution === null && next.conflictResolution === null) {
            return false;
        }
        return next.baseline === null;
    }
    if (from === 'conflict') {
        const wasResolved = prev.conflictResolution !== null || prev.resolution?.state === 'resolved';
        if (to !== 'conflict') return false;
        if (wasResolved && !nextResolved) {
            // Reopening resolved conflict is allowed ONLY when lateCompletion is appended (L8 / S10)
            return hasAddedLateCompletion(prev, next);
        }
        // Unresolved conflict can either record a lateCompletion or be resolved
        if (!wasResolved && !nextResolved) {
            return hasAddedLateCompletion(prev, next);
        }
        return nextResolved;
    }
    if (from === 'pending') {
        if (to === 'writing') return next.baseline !== null && next.attemptId !== null;
        if (to === 'notWritten') return true;
        return false;
    }
    if (from === 'writing') {
        // In-flight protection: while a host write is in-flight, another attempt cannot mark it notWritten or strip in-flight to unknown
        const prevInFlight = prev.dispatchPhase === 'in-flight' || prev.execution?.state === 'in-flight';
        if (prevInFlight && next.attemptId !== prev.attemptId) {
            const abandonedTakeover = next.execution?.state === 'ended' && next.execution?.endedBy === 'abandoned';
            if (to === 'verified') {
                return next.verification !== null && (next.reconciliation?.outcome === 'verified' || abandonedTakeover);
            }
            if (to === 'notWritten') {
                return abandonedTakeover && next.observation?.result === 'matchesBefore';
            }
            if (to === 'conflict') {
                return next.reconciliation?.outcome === 'conflict' || abandonedTakeover || hasAddedLateCompletion(prev, next);
            }
            return false;
        }
        if (to === 'writing') {
            if (prevInFlight) {
                return next.attemptId === prev.attemptId && next.baseline !== null;
            }
            return next.attemptId !== null && next.baseline !== null;
        }
        if (to === 'verified') {
            if (next.verification === null) return false;
            return next.attemptId === prev.attemptId || next.reconciliation?.outcome === 'verified';
        }
        if (to === 'notWritten' || to === 'unknown' || to === 'conflict') {
            return true;
        }
        return false;
    }
    if (from === 'unknown') {
        if (to === 'unknown') return true;
        if (['verified', 'notWritten', 'conflict'].includes(to)) {
            if (next.reconciliation === null || next.reconciliation.outcome !== to) return false;
            if (to === 'verified' && next.verification === null) return false;
            return true;
        }
        return false;
    }
    if (from === 'notWritten') {
        if (to === 'notWritten') return true;
        if (to === 'writing') {
            return next.attemptId !== null && next.attemptId !== prev.attemptId && next.baseline !== null;
        }
        if (to === 'conflict') return true;
        return false;
    }
    if (from === 'verified') {
        if (to === 'verified') {
            return next.verification !== null;
        }
        if (to === 'undoing') {
            return next.attemptId !== null && next.undo !== null && next.undo.status === 'undoing';
        }
        if (to === 'undoBlocked') {
            return next.undo !== null && next.undo.status === 'undoBlocked';
        }
        if (to === 'conflict') return true;
        return false;
    }
    if (from === 'undoing') {
        const prevUndoInFlight = prev.dispatchPhase === 'in-flight' || prev.undo?.execution?.state === 'in-flight';
        if (prevUndoInFlight && next.attemptId !== prev.attemptId) {
            const abandonedUndoTakeover = next.undo?.execution?.state === 'ended' && next.undo?.execution?.endedBy === 'abandoned';
            if (to === 'undone') {
                return next.undo?.status === 'undone' && (next.reconciliation?.outcome === 'undone' || abandonedUndoTakeover);
            }
            if (to === 'verified' || to === 'undoBlocked') {
                return abandonedUndoTakeover && next.undo?.observation?.result === 'matchesBefore';
            }
            if (to === 'conflict') {
                return next.reconciliation?.outcome === 'conflict' || abandonedUndoTakeover || hasAddedLateCompletion(prev, next);
            }
            return false;
        }
        if (to === 'undoing') {
            if (prevUndoInFlight) {
                return next.attemptId === prev.attemptId && next.undo !== null && next.undo.status === 'undoing';
            }
            return next.attemptId !== null && next.undo !== null && next.undo.status === 'undoing';
        }
        if (to === 'undone') {
            return next.undo !== null && next.undo.status === 'undone';
        }
        if (to === 'undoBlocked') {
            return next.undo !== null && next.undo.status === 'undoBlocked';
        }
        if (to === 'undoUnknown') {
            return next.undo !== null && next.undo.status === 'undoUnknown';
        }
        if (to === 'conflict') return true;
        return false;
    }
    if (from === 'undoUnknown') {
        if (to === 'undoUnknown') {
            return next.undo !== null && next.undo.status === 'undoUnknown';
        }
        if (['undone', 'verified', 'conflict'].includes(to)) {
            return next.reconciliation !== null && next.reconciliation.outcome === to;
        }
        return false;
    }
    if (from === 'undoBlocked') {
        if (to === 'undoBlocked') return true;
        if (to === 'undoing') {
            return next.attemptId !== null && next.attemptId !== prev.attemptId && next.undo?.status === 'undoing';
        }
        if (to === 'conflict') return true;
        return false;
    }
    if (from === 'undone') {
        if (to === 'undone') {
            return next.undo !== null && next.undo.status === 'undone';
        }
        if (to === 'conflict') return true;
        return false;
    }
    return false;
}

function validateMigrationControlRecord(p) {
    const required = [
        'schema', 'identity', 'book', 'kind', 'status',
        'runtimeId', 'deviceId', 'epoch', 'acquiredAt',
        'heartbeatAt', 'completedAt', 'summary', 'updatedAt',
    ];
    const allowed = new Set([...required, 'serverNow']);
    for (const k of required) {
        if (!(k in p)) bad();
    }
    for (const k of Object.keys(p)) {
        if (!allowed.has(k)) bad();
    }
    if (p.schema !== 1 || p.kind !== 'migration' || p.book !== '__migration__') bad();
    validateLorebookIdentity(p.identity);
    one(p.status, ['in-progress', 'completed']);
    str(p.runtimeId, 96, false);
    str(p.deviceId, 64, false);
    int(p.epoch, 1, 1000000000);
    int(p.acquiredAt);
    int(p.heartbeatAt);
    nullable(p.completedAt, v => int(v));
    if (!obj(p.summary)) bad();
    keys(p.summary, 'scannedRecords,legacyLocksFound,booksMigrated,unresolvedBooks,clearedLegacyLocks');
    int(p.summary.scannedRecords, 0, 1000000);
    int(p.summary.legacyLocksFound, 0, 1000000);
    int(p.summary.booksMigrated, 0, 1000000);
    array(p.summary.unresolvedBooks, 512, b => str(b, 512, false));
    int(p.summary.clearedLegacyLocks, 0, 1000000);
    int(p.updatedAt);
    if (p.serverNow !== undefined && p.serverNow !== null) int(p.serverNow);
}

function validateLegacyHolderEntry(lh) {
    if (!obj(lh)) bad();
    const required = ['batchId', 'threadId', 'attemptId', 'deviceId', 'mode', 'acquiredAt'];
    const allowed = new Set([...required, 'phase', 'fence', 'chat', 'owner', 'kind', 'recordId']);
    for (const k of required) {
        if (!(k in lh)) bad();
    }
    for (const k of Object.keys(lh)) {
        if (!allowed.has(k)) bad();
    }
    str(lh.batchId, 128, false);
    str(lh.threadId, 128);
    str(lh.attemptId, 96, false);
    str(lh.deviceId, 64, false);
    one(lh.mode, ['apply', 'undo', 'reconcile']);
    if (lh.phase !== undefined && lh.phase !== null) {
        one(lh.phase, LOCK_HOLDER_PHASES);
    }
    if (lh.fence !== undefined && lh.fence !== null) int(lh.fence, 0, 1000000000);
    if (lh.chat !== undefined && lh.chat !== null) str(lh.chat, 512);
    if (lh.owner !== undefined && lh.owner !== null) str(lh.owner, 512);
    if (lh.kind !== undefined && lh.kind !== null) str(lh.kind, 32);
    if (lh.recordId !== undefined && lh.recordId !== null) str(lh.recordId, 128);
    int(lh.acquiredAt);
}

function validateBookLockRecord(p) {
    if (!obj(p)) bad();
    if (p.kind === 'migration') {
        validateMigrationControlRecord(p);
        return;
    }
    const required = ['schema', 'identity', 'book', 'holder', 'ledger', 'history', 'updatedAt'];
    const allowed = new Set([...required, 'fence', 'epoch', 'legacyHolders', 'serverNow']);
    for (const k of required) {
        if (!(k in p)) bad();
    }
    for (const k of Object.keys(p)) {
        if (!allowed.has(k)) bad();
    }
    if (p.schema !== 1) bad();
    validateLorebookIdentity(p.identity);
    str(p.book, 512, false);
    if (p.fence !== undefined && p.fence !== null) {
        int(p.fence, 0, 1000000000);
    }
    if (p.epoch !== undefined && p.epoch !== null) {
        int(p.epoch, 0, 1000000000);
    }
    if (p.serverNow !== undefined && p.serverNow !== null) {
        int(p.serverNow);
    }
    if (p.legacyHolders !== undefined && p.legacyHolders !== null) {
        array(p.legacyHolders, 64, validateLegacyHolderEntry);
    }
    nullable(p.holder, h => {
        if (!obj(h)) bad();
        const holderRequired = ['batchId', 'threadId', 'deviceId', 'mode', 'acquiredAt'];
        const holderAllowed = new Set([
            ...holderRequired,
            'attemptId',
            'operationId',
            'runtimeId',
            'epoch',
            'phase',
            'fence',
            'chat',
            'chatKey',
            'heartbeatAt',
            'takeoverOf',
            'remainingStaleMs',
            'staleAfterMs',
        ]);
        for (const k of holderRequired) {
            if (!(k in h)) bad();
        }
        for (const k of Object.keys(h)) {
            if (!holderAllowed.has(k)) bad();
        }
        str(h.batchId, 128, false);
        str(h.threadId, 128);
        const opId = h.operationId ?? h.attemptId;
        str(opId, 96, false);
        if (h.attemptId !== undefined && h.attemptId !== null) str(h.attemptId, 96, false);
        if (h.operationId !== undefined && h.operationId !== null) str(h.operationId, 96, false);
        if (h.runtimeId !== undefined && h.runtimeId !== null) str(h.runtimeId, 96, false);
        if (h.epoch !== undefined && h.epoch !== null) int(h.epoch, 1, 1000000000);
        str(h.deviceId, 64, false);
        one(h.mode, ['apply', 'undo', 'reconcile']);
        if (h.phase !== undefined && h.phase !== null) {
            one(h.phase, LOCK_HOLDER_PHASES);
        }
        if (h.fence !== undefined && h.fence !== null) {
            int(h.fence, 0, 1000000000);
        }
        if (h.chat !== undefined && h.chat !== null) {
            str(h.chat, 512);
        }
        if (h.chatKey !== undefined && h.chatKey !== null) {
            str(h.chatKey, 512);
        }
        int(h.acquiredAt);
        if (h.heartbeatAt !== undefined && h.heartbeatAt !== null) int(h.heartbeatAt);
        if (h.remainingStaleMs !== undefined && h.remainingStaleMs !== null) int(h.remainingStaleMs, 0, 1000000000);
        if (h.staleAfterMs !== undefined && h.staleAfterMs !== null) int(h.staleAfterMs, 1, 1000000000);
        if (h.takeoverOf !== undefined && h.takeoverOf !== null) {
            if (!obj(h.takeoverOf)) bad();
            keys(h.takeoverOf, 'operationId,epoch');
            str(h.takeoverOf.operationId, 96, false);
            int(h.takeoverOf.epoch, 1, 1000000000);
        }
    });
    array(p.ledger, 16, l => {
        keys(
            l,
            'batchId,attemptId,deviceId,mode,beforeBookFingerprint,afterBookFingerprint,targets,committedAt',
        );
        str(l.batchId, 128, false);
        str(l.attemptId, 96, false);
        str(l.deviceId, 64, false);
        one(l.mode, ['apply', 'undo', 'reconcile']);
        nullable(l.beforeBookFingerprint, v => str(v, 128, false));
        str(l.afterBookFingerprint, 128, false);
        array(l.targets, 256, t => {
            keys(t, 'uid,beforeRawFingerprint,afterRawFingerprint');
            int(t.uid, 0, 10000000);
            nullable(t.beforeRawFingerprint, v => str(v, 128, false));
            nullable(t.afterRawFingerprint, v => str(v, 128, false));
        });
        int(l.committedAt);
    });
    array(p.history, 24, h => {
        if (!obj(h)) bad();
        const histRequired = ['action', 'batchId', 'attemptId', 'deviceId', 'at', 'reason'];
        const histAllowed = new Set([
            ...histRequired,
            'operationId',
            'runtimeId',
            'epoch',
            'phase',
            'chatKey',
            'evidence',
            'userConfirmedRisk',
            'userConfirmedLegacyClosed',
            'observedFingerprint',
            'takeoverOf',
            'resolution',
            'lateCompletion',
        ]);
        for (const k of histRequired) {
            if (!(k in h)) bad();
        }
        for (const k of Object.keys(h)) {
            if (!histAllowed.has(k)) bad();
        }
        one(h.action, [
            'acquire',
            'in-flight',
            'heartbeat',
            'ended',
            'hold-unresolved',
            'release',
            'takeover',
            'abort',
            'conflict',
            'migrate-legacy',
            'resolve-legacy',
        ]);
        str(h.batchId, 128, false);
        str(h.attemptId, 96, false);
        str(h.deviceId, 64, false);
        int(h.at);
        str(h.reason, 500);
        if (h.operationId !== undefined && h.operationId !== null) str(h.operationId, 96, false);
        if (h.runtimeId !== undefined && h.runtimeId !== null) str(h.runtimeId, 96, false);
        if (h.epoch !== undefined && h.epoch !== null) int(h.epoch, 1, 1000000000);
        if (h.phase !== undefined && h.phase !== null) one(h.phase, LOCK_HOLDER_PHASES);
        if (h.chatKey !== undefined && h.chatKey !== null) str(h.chatKey, 512);
        if (h.evidence !== undefined && h.evidence !== null) one(h.evidence, ['webLockReleased', 'heartbeatStale']);
        if (h.userConfirmedRisk !== undefined && h.userConfirmedRisk !== null) bool(h.userConfirmedRisk);
        if (h.userConfirmedLegacyClosed !== undefined && h.userConfirmedLegacyClosed !== null) bool(h.userConfirmedLegacyClosed);
        if (h.observedFingerprint !== undefined && h.observedFingerprint !== null) str(h.observedFingerprint, 128, false);
        if (h.takeoverOf !== undefined && h.takeoverOf !== null) {
            if (!obj(h.takeoverOf)) bad();
            keys(h.takeoverOf, 'operationId,epoch');
            str(h.takeoverOf.operationId, 96, false);
            int(h.takeoverOf.epoch, 1, 1000000000);
        }
        if (h.resolution !== undefined && h.resolution !== null) {
            if (!obj(h.resolution)) bad();
            keys(h.resolution, 'operationId,basedOnFingerprint,choice,resolvedByDeviceId,resolvedAt');
            str(h.resolution.operationId, 96, false);
            str(h.resolution.basedOnFingerprint, 128, false);
            one(h.resolution.choice, ['acknowledged', 'manual-fixed']);
            str(h.resolution.resolvedByDeviceId, 64, false);
            int(h.resolution.resolvedAt);
        }
        if (h.lateCompletion !== undefined && h.lateCompletion !== null) {
            validateLateCompletionEntry(h.lateCompletion);
        }
    });
    int(p.updatedAt);
}

function isCanonicalBookResourceIdentity(identity) {
    if (!obj(identity)) return false;
    return (
        identity.owner === 'lorebook-resource'
        || identity.owner === '__account_worldbook__'
        || identity.kind === 'worldbook'
        || identity.kind === 'account'
    );
}

function hasCompleteCanonicalHolder(h) {
    if (!obj(h)) return false;
    if (h.phase === 'legacy-unresolved') {
        return Number.isSafeInteger(h.epoch) && h.epoch >= 1;
    }
    return (
        typeof h.runtimeId === 'string'
        && h.runtimeId.trim().length > 0
        && typeof h.operationId === 'string'
        && h.operationId.trim().length > 0
        && Number.isSafeInteger(h.epoch)
        && h.epoch >= 1
        && CANONICAL_LOCK_HOLDER_PHASES.includes(h.phase)
    );
}

function matchesHolderTriple(a, b) {
    if (!obj(a) || !obj(b)) return false;
    return (
        a.runtimeId === b.runtimeId
        && a.operationId === b.operationId
        && a.epoch === b.epoch
        && a.deviceId === b.deviceId
        && a.batchId === b.batchId
    );
}

export function projectLorebookBookLockRead(payload, { now = Date.now() } = {}) {
    if (!obj(payload)) return payload;
    if (payload.kind === 'migration') {
        return payload;
    }
    if (obj(payload.holder) && ['preparing', 'in-flight'].includes(payload.holder.phase)) {
        const lastBeat = Number(payload.holder.heartbeatAt ?? payload.holder.acquiredAt ?? 0);
        const elapsed = Math.max(0, now - lastBeat);
        const remainingStaleMs = Math.max(0, LOREBOOK_LOCK_STALE_AFTER_MS - elapsed);
        return {
            ...payload,
            holder: {
                ...payload.holder,
                remainingStaleMs,
                staleAfterMs: LOREBOOK_LOCK_STALE_AFTER_MS,
            },
        };
    }
    return payload;
}

export function transitionLorebookBookLock(prev, next, meta = {}) {
    const reject = (code = 'RECORD_TRANSITION_INVALID', details = {}) => {
        if (meta?.throwFailures) failRecord(code, details);
        return false;
    };
    const serverNow = Number.isSafeInteger(meta?.now) ? meta.now : null;

    if (!obj(next)) return reject();

    // 1. Account-level legacy migration control record
    if (next.kind === 'migration' || prev?.kind === 'migration') {
        if (next.kind !== 'migration' || next.book !== '__migration__') return reject();
        if (prev && (prev.kind !== 'migration' || prev.book !== '__migration__')) return reject();
        if (serverNow !== null) {
            next.heartbeatAt = serverNow;
            next.updatedAt = serverNow;
        }
        if (!prev) {
            return next.epoch === 1 && ['in-progress', 'completed'].includes(next.status);
        }
        if (prev.status === 'completed') {
            if (next.status !== 'completed') return reject();
            return next.epoch >= prev.epoch;
        }
        // prev.status === 'in-progress'
        if (next.runtimeId === prev.runtimeId && next.epoch === prev.epoch) {
            return ['in-progress', 'completed'].includes(next.status);
        }
        // Takeover of stale in-progress migration mutex
        const lastBeat = Number(prev.heartbeatAt ?? prev.acquiredAt ?? 0);
        const nowForCheck = serverNow ?? Number(next.acquiredAt || 0);
        const elapsed = nowForCheck - lastBeat;
        if (elapsed < LOREBOOK_LOCK_STALE_AFTER_MS) {
            return reject('LOREBOOK_LOCK_NOT_STALE', {
                remainingStaleMs: Math.max(0, LOREBOOK_LOCK_STALE_AFTER_MS - Math.max(0, elapsed)),
                staleAfterMs: LOREBOOK_LOCK_STALE_AFTER_MS,
                serverNow: nowForCheck,
            });
        }
        if (next.epoch !== prev.epoch + 1) return reject();
        return ['in-progress', 'completed'].includes(next.status);
    }

    // 2. Identity & book immutability
    if (prev) {
        const prevBook = prev.book ?? prev.identity?.bookName;
        const nextBook = next.book ?? next.identity?.bookName;
        if (
            prev.identity?.kind !== next.identity?.kind
            || prev.identity?.owner !== next.identity?.owner
            || prev.identity?.chat !== next.identity?.chat
            || prevBook !== nextBook
        ) {
            return reject();
        }
        if (prev.fence != null && next.fence != null && next.fence < prev.fence) {
            return reject();
        }
    }

    const last = Array.isArray(next.history) ? next.history.at(-1) : null;

    // 3. D2 / I9: Legacy chat-level book locks only allow clearing holder with CAS match; new/changed holders are forbidden
    if (!isCanonicalBookResourceIdentity(next.identity)) {
        if (!prev) return reject('LEGACY_LOCK_WRITE_FORBIDDEN');
        if (next.holder !== null) return reject('LEGACY_LOCK_WRITE_FORBIDDEN');
        if (!prev.holder) return reject('LEGACY_LOCK_WRITE_FORBIDDEN');
        const prevOpId = prev.holder.operationId || prev.holder.attemptId;
        if (!last || last.action !== 'release' || last.attemptId !== prevOpId) {
            return reject('LEGACY_LOCK_WRITE_FORBIDDEN');
        }
        return true;
    }

    // 4. Canonical book resource lock (L1–L10)
    const prevEpoch = Number(prev?.epoch ?? prev?.holder?.epoch ?? prev?.fence ?? 0);

    // Preserve existing legacyHolders append-only
    if (Array.isArray(prev?.legacyHolders) && prev.legacyHolders.length > 0) {
        if (!Array.isArray(next.legacyHolders) || next.legacyHolders.length < prev.legacyHolders.length) {
            return reject();
        }
    }

    // Special transition: WP4 one-time legacy lock migration into canonical lock
    if (last?.action === 'migrate-legacy') {
        if (typeof meta?.readRecord === 'function') {
            const mig = meta.readRecord(LOREBOOK_LOCK_MIGRATION_RECORD_ID);
            if (!mig || mig.kind !== 'migration' || !['in-progress', 'completed'].includes(mig.status)) {
                return reject('LOREBOOK_MIGRATION_REQUIRED');
            }
        }
        if (next.holder !== null) {
            const keepingExistingHolder = prev?.holder && JSON.stringify(prev.holder) === JSON.stringify(next.holder);
            if (!keepingExistingHolder && next.holder.phase !== 'legacy-unresolved') {
                return reject();
            }
        }
        const nextEpoch = Math.max(prevEpoch + 1, Number(next.epoch ?? next.holder?.epoch ?? 1));
        next.epoch = nextEpoch;
        if (next.holder && !next.holder.epoch) next.holder.epoch = nextEpoch;
        return true;
    }

    // L9: Any non-null holder on canonical lock must have complete {runtimeId, operationId, epoch, phase}
    if (next.holder !== null && !hasCompleteCanonicalHolder(next.holder)) {
        return reject('LOREBOOK_LOCK_HOLDER_INVALID');
    }

    // Check migration marker requirement (L1) when acquiring/mutating canonical locks
    if (meta?.migrationCompleted === false) {
        return reject('LOREBOOK_MIGRATION_REQUIRED');
    }
    if (typeof meta?.readRecord === 'function') {
        const mig = meta.readRecord(LOREBOOK_LOCK_MIGRATION_RECORD_ID);
        if (!mig || mig.kind !== 'migration' || mig.status !== 'completed') {
            return reject('LOREBOOK_MIGRATION_REQUIRED');
        }
    }

    // Case A: Empty / released -> non-null holder (L1 preparing, or L8 reopen conflict on lateCompletion)
    if (!prev || prev.holder === null) {
        if (next.holder === null) {
            next.epoch = Math.max(prevEpoch, Number(next.epoch || 0));
            return true;
        }
        if (next.holder.epoch !== prevEpoch + 1) return reject();
        next.epoch = next.holder.epoch;
        if (next.holder.phase === 'preparing') {
            if (!last || last.action !== 'acquire') return reject();
            if (serverNow !== null) {
                next.holder.heartbeatAt = serverNow;
            } else if (next.holder.heartbeatAt == null) {
                next.holder.heartbeatAt = next.holder.acquiredAt;
            }
            return true;
        }
        if (next.holder.phase === 'conflict') {
            // L8: Reopen conflict from released state requires lateCompletion evidence in history
            if (!last || last.action !== 'conflict' || !obj(last.lateCompletion)) return reject();
            return true;
        }
        return reject();
    }

    // Case B: Non-null holder -> released (holder: null)
    if (prev.holder !== null && next.holder === null) {
        if (!last || !['release', 'abort', 'resolve-legacy'].includes(last.action)) return reject();
        const prevOpId = prev.holder.operationId || prev.holder.attemptId;
        const prevPhase = prev.holder.phase;

        if (prevPhase === 'legacy-unresolved') {
            // D6: Resolving legacy-unresolved requires user confirmation + fresh read-back fingerprint
            if (
                last.userConfirmedLegacyClosed !== true
                || typeof last.observedFingerprint !== 'string'
                || !last.observedFingerprint.trim()
            ) {
                return reject();
            }
            next.epoch = prevEpoch + 1;
            return true;
        }

        if (prevPhase === 'conflict') {
            // L7: Releasing conflict requires resolution referencing the ended operationId and basedOnFingerprint
            if (last.action !== 'release' || !obj(last.resolution)) return reject();
            if (
                last.resolution.operationId !== prevOpId
                || typeof last.resolution.basedOnFingerprint !== 'string'
                || !last.resolution.basedOnFingerprint.trim()
            ) {
                return reject();
            }
            next.epoch = prevEpoch;
            return true;
        }

        if (prevPhase === 'preparing') {
            const isOwnerAbortOrRelease = (
                last.runtimeId === prev.holder.runtimeId
                && (last.operationId || last.attemptId) === prevOpId
                && (last.epoch ?? prev.holder.epoch) === prev.holder.epoch
            );
            if (isOwnerAbortOrRelease) {
                next.epoch = prevEpoch;
                return true;
            }
            // S11 / L5: Dead preparing holder cleanup
            if (
                obj(last.takeoverOf)
                && last.takeoverOf.operationId === prevOpId
                && last.takeoverOf.epoch === prev.holder.epoch
            ) {
                const sameDeviceDead = last.deviceId === prev.holder.deviceId && last.evidence === 'webLockReleased';
                const lastBeat = Number(prev.holder.heartbeatAt ?? prev.holder.acquiredAt ?? 0);
                const nowForCheck = serverNow ?? Number(last.at || 0);
                const elapsed = nowForCheck - lastBeat;
                if (!sameDeviceDead && elapsed < LOREBOOK_LOCK_STALE_AFTER_MS) {
                    return reject('LOREBOOK_LOCK_NOT_STALE', {
                        remainingStaleMs: Math.max(0, LOREBOOK_LOCK_STALE_AFTER_MS - Math.max(0, elapsed)),
                        staleAfterMs: LOREBOOK_LOCK_STALE_AFTER_MS,
                        serverNow: nowForCheck,
                    });
                }
                next.epoch = prevEpoch + 1;
                return true;
            }
            return reject();
        }

        if (prevPhase === 'in-flight' || prevPhase === 'ended') {
            if (prevPhase === 'in-flight' && last.action !== 'release') return reject();
            const isOwnerRelease = (
                last.runtimeId === prev.holder.runtimeId
                && (last.operationId || last.attemptId) === prevOpId
                && (last.epoch ?? prev.holder.epoch) === prev.holder.epoch
            );
            if (!isOwnerRelease) return reject();
            next.epoch = prevEpoch;
            return true;
        }

        return reject();
    }

    // Case C: Non-null holder -> Non-null holder
    const prevOpId = prev.holder.operationId || prev.holder.attemptId;
    const nextOpId = next.holder.operationId || next.holder.attemptId;

    // L10: No same-attemptId/operationId shortcut! Same operationId MUST match full {runtimeId, operationId, epoch}
    if (nextOpId === prevOpId) {
        if (!matchesHolderTriple(prev.holder, next.holder)) {
            return reject();
        }
        next.epoch = prevEpoch;
        const fromPhase = prev.holder.phase;
        const toPhase = next.holder.phase;

        // L2: preparing -> in-flight
        if (fromPhase === 'preparing' && toPhase === 'in-flight') {
            if (!last || last.action !== 'in-flight') return reject();
            if (serverNow !== null) {
                next.holder.heartbeatAt = serverNow;
            } else if (next.holder.heartbeatAt == null) {
                next.holder.heartbeatAt = next.holder.acquiredAt;
            }
            return true;
        }
        // L3: in-flight -> in-flight (heartbeat)
        if (fromPhase === 'in-flight' && toPhase === 'in-flight') {
            if (
                next.holder.mode !== prev.holder.mode
                || next.holder.threadId !== prev.holder.threadId
                || next.holder.chat !== prev.holder.chat
            ) {
                return reject();
            }
            if (serverNow !== null) {
                next.holder.heartbeatAt = serverNow;
            }
            return true;
        }
        // L4: in-flight -> ended | conflict, or ended -> ended | conflict
        if (fromPhase === 'in-flight' && ['ended', 'conflict'].includes(toPhase)) {
            return true;
        }
        if (fromPhase === 'ended' && ['ended', 'conflict'].includes(toPhase)) {
            return true;
        }
        return reject();
    }

    // Different operationId: must increment epoch by +1 (I3 / L5 / L6 / L8 / D6)
    if (next.holder.epoch !== prevEpoch + 1) {
        return reject();
    }
    next.epoch = next.holder.epoch;

    const fromPhase = prev.holder.phase;
    const toPhase = next.holder.phase;

    // D6: legacy-unresolved -> conflict (when fresh read-back after user confirmation reveals divergence)
    if (fromPhase === 'legacy-unresolved') {
        if (
            toPhase === 'conflict'
            && last
            && ['resolve-legacy', 'conflict'].includes(last.action)
            && last.userConfirmedLegacyClosed === true
            && typeof last.observedFingerprint === 'string'
            && last.observedFingerprint.trim().length > 0
        ) {
            return true;
        }
        return reject();
    }

    // L8: lateCompletion arriving while in ended or conflict
    if (['ended', 'conflict'].includes(fromPhase) && toPhase === 'conflict' && last?.action === 'conflict' && obj(last.lateCompletion)) {
        return true;
    }

    // Conflict lock cannot be taken over by apply/undo/preparing/in-flight; must be resolved & released first
    if (fromPhase === 'conflict') {
        return reject();
    }

    // L5: preparing takeover
    if (fromPhase === 'preparing') {
        const tk = last?.takeoverOf || next.holder.takeoverOf;
        if (
            !last
            || last.action !== 'takeover'
            || !last.reason?.trim()
            || !obj(tk)
            || tk.operationId !== prevOpId
            || tk.epoch !== prev.holder.epoch
        ) {
            return reject();
        }
        const sameDeviceDead = prev.holder.deviceId === next.holder.deviceId && last.evidence === 'webLockReleased';
        if (!sameDeviceDead) {
            const lastBeat = Number(prev.holder.heartbeatAt ?? prev.holder.acquiredAt ?? 0);
            const nowForCheck = serverNow ?? Number(last.at || next.holder.acquiredAt || 0);
            const elapsed = nowForCheck - lastBeat;
            if (elapsed < LOREBOOK_LOCK_STALE_AFTER_MS) {
                return reject('LOREBOOK_LOCK_NOT_STALE', {
                    remainingStaleMs: Math.max(0, LOREBOOK_LOCK_STALE_AFTER_MS - Math.max(0, elapsed)),
                    staleAfterMs: LOREBOOK_LOCK_STALE_AFTER_MS,
                    serverNow: nowForCheck,
                });
            }
        }
        if (!['preparing', 'ended', 'conflict'].includes(toPhase)) return reject();
        if (serverNow !== null) {
            next.holder.heartbeatAt = serverNow;
        } else if (next.holder.heartbeatAt == null) {
            next.holder.heartbeatAt = next.holder.acquiredAt;
        }
        return true;
    }

    // L6: in-flight takeover
    if (fromPhase === 'in-flight') {
        const tk = last?.takeoverOf || next.holder.takeoverOf;
        if (
            !last
            || last.action !== 'takeover'
            || !last.reason?.trim()
            || !obj(tk)
            || tk.operationId !== prevOpId
            || tk.epoch !== prev.holder.epoch
        ) {
            return reject();
        }
        // Takeover of in-flight only settles old operation by observation (ended or conflict), never starts a new write directly
        if (!['ended', 'conflict'].includes(toPhase)) {
            return reject();
        }
        const sameDeviceDead = prev.holder.deviceId === next.holder.deviceId && last.evidence === 'webLockReleased';
        if (!sameDeviceDead) {
            const lastBeat = Number(prev.holder.heartbeatAt ?? prev.holder.acquiredAt ?? 0);
            const nowForCheck = serverNow ?? Number(last.at || next.holder.acquiredAt || 0);
            const elapsed = nowForCheck - lastBeat;
            if (elapsed < LOREBOOK_LOCK_STALE_AFTER_MS) {
                return reject('LOREBOOK_LOCK_NOT_STALE', {
                    remainingStaleMs: Math.max(0, LOREBOOK_LOCK_STALE_AFTER_MS - Math.max(0, elapsed)),
                    staleAfterMs: LOREBOOK_LOCK_STALE_AFTER_MS,
                    serverNow: nowForCheck,
                });
            }
            if (last.userConfirmedRisk !== true) {
                return reject('LOREBOOK_TAKEOVER_CONFIRMATION_REQUIRED');
            }
        }
        if (serverNow !== null) {
            next.holder.heartbeatAt = serverNow;
        } else if (next.holder.heartbeatAt == null) {
            next.holder.heartbeatAt = next.holder.acquiredAt;
        }
        return true;
    }

    // From ended: previous operation already ended; allow new acquire or reconcile takeover into preparing/ended/conflict with epoch + 1
    if (fromPhase === 'ended' && ['preparing', 'ended', 'conflict'].includes(toPhase) && ['acquire', 'takeover', 'conflict'].includes(last?.action)) {
        if (serverNow !== null) {
            next.holder.heartbeatAt = serverNow;
        } else if (next.holder.heartbeatAt == null) {
            next.holder.heartbeatAt = next.holder.acquiredAt;
        }
        return true;
    }

    return reject();
}

export function validateLorebookRecord(consumer, p) {
    if (consumer === 'oracle-lorebook-thread-index') {
        keys(p, 'identity,threads');
        validateLorebookIdentity(p.identity);
        validateThreadIndexEntries(p.threads, 50);
    } else if (consumer === 'oracle-lorebook-threads') {
        validateThreadRecord(p);
    } else if (consumer === 'oracle-lorebook-workspace') {
        validateWorkspaceRecord(p);
    } else if (consumer === 'oracle-lorebook-batches') {
        validateBatchRecord(p);
    } else if (consumer === 'oracle-lorebook-executions') {
        validateExecutionRecord(p);
    } else if (consumer === 'oracle-lorebook-exec-steps') {
        validateExecStepRecord(p);
    } else if (consumer === 'oracle-lorebook-book-locks') {
        validateBookLockRecord(p);
    } else {
        bad();
    }
    return p;
}

export const lorebookRecordConsumers = Object.freeze([
    Object.freeze({
        id: 'oracle-lorebook-thread-index',
        schemaVersion: 1,
        maxBytes: 64 * 1024,
        maxRecords: 4000,
        maxStorageBytes: 32 * 1024 * 1024,
        deletable: false,
        validate: p => validateLorebookRecord('oracle-lorebook-thread-index', p),
    }),
    Object.freeze({
        id: 'oracle-lorebook-threads',
        schemaVersion: 1,
        maxBytes: 2 * 1024 * 1024,
        maxRecords: 10000,
        maxStorageBytes: 160 * 1024 * 1024,
        deletable: true,
        validate: p => validateLorebookRecord('oracle-lorebook-threads', p),
    }),
    Object.freeze({
        id: 'oracle-lorebook-workspace',
        schemaVersion: 1,
        maxBytes: 256 * 1024,
        maxRecords: 10000,
        maxStorageBytes: 64 * 1024 * 1024,
        deletable: true,
        validate: p => validateLorebookRecord('oracle-lorebook-workspace', p),
    }),
    Object.freeze({
        id: 'oracle-lorebook-batches',
        schemaVersion: 1,
        maxBytes: 2 * 1024 * 1024,
        maxRecords: 20000,
        maxStorageBytes: 256 * 1024 * 1024,
        deletable: true,
        validate: p => validateLorebookRecord('oracle-lorebook-batches', p),
        transition: transitionLorebookBatch,
    }),
    Object.freeze({
        id: 'oracle-lorebook-executions',
        schemaVersion: 1,
        maxBytes: 64 * 1024,
        maxRecords: 20000,
        maxStorageBytes: 64 * 1024 * 1024,
        deletable: false,
        validate: p => validateLorebookRecord('oracle-lorebook-executions', p),
        transition: transitionLorebookExecution,
    }),
    Object.freeze({
        id: 'oracle-lorebook-exec-steps',
        schemaVersion: 1,
        maxBytes: 2 * 1024 * 1024,
        maxRecords: 40000,
        maxStorageBytes: 256 * 1024 * 1024,
        deletable: false,
        validate: p => validateLorebookRecord('oracle-lorebook-exec-steps', p),
        transition: transitionLorebookExecStep,
    }),
    Object.freeze({
        id: 'oracle-lorebook-book-locks',
        schemaVersion: 1,
        maxBytes: 128 * 1024,
        maxRecords: 4000,
        maxStorageBytes: 32 * 1024 * 1024,
        deletable: false,
        validate: p => validateLorebookRecord('oracle-lorebook-book-locks', p),
        transition: transitionLorebookBookLock,
        projectRead: projectLorebookBookLockRead,
    }),
]);
