import {
    bad, obj, keys, str, int, bool, one, array, unique, nullable,
    validateCloudConnectionId, validateOracleIdentity, validateOracleRecipe,
    validatePromptProfiles, validateThreadIndexEntries,
} from './oracle-validation.js';

export const validateLorebookIdentity = validateOracleIdentity;

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
const LOCK_HOLDER_PHASES = [
    'preparing',
    'in-flight',
    'unknown',
    'undo-unknown',
    'conflict',
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

function validateStepUndo(u) {
    keys(u, 'status,attemptId,deviceId,startedAt,finishedAt,afterBookFingerprint,error');
    one(u.status, ['undoing', 'undone', 'undoBlocked', 'undoUnknown', 'conflict']);
    str(u.attemptId, 96, false);
    str(u.deviceId, 64, false);
    int(u.startedAt);
    nullable(u.finishedAt, t => int(t));
    nullable(u.afterBookFingerprint, s => str(s, 128, false));
    str(u.error, 2000);
}

function validateConflictResolution(c) {
    keys(c, 'resolvedByDeviceId,resolvedAt,resolution,note');
    str(c.resolvedByDeviceId, 64, false);
    int(c.resolvedAt);
    one(c.resolution, ['acknowledged', 'manual-fixed']);
    str(c.note, 1000);
}

function validateExecStepRecord(p) {
    if (!obj(p)) bad();
    const required = [
        'schema', 'identity', 'threadId', 'batchId', 'book', 'stepIndex',
        'state', 'attemptId', 'holderDeviceId', 'allocatedUids', 'baseline',
        'verification', 'reconciliation', 'undo', 'conflictResolution',
        'error', 'updatedAt', 'history',
    ];
    const allowed = new Set([...required, 'dispatchPhase', 'fence']);
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
        // Unresolved conflict cannot be silently overwritten back to verified/undone by a late writer
        return to === 'conflict' && next.conflictResolution !== null;
    }
    if (from === 'pending') {
        if (to === 'writing') return next.baseline !== null && next.attemptId !== null;
        if (to === 'notWritten') return true;
        return false;
    }
    if (from === 'writing') {
        // In-flight protection: while a host write is in-flight, another attempt cannot mark it notWritten or strip in-flight to unknown
        if (prev.dispatchPhase === 'in-flight' && next.attemptId !== prev.attemptId) {
            if (to === 'verified') {
                return next.verification !== null && next.reconciliation?.outcome === 'verified';
            }
            if (to === 'conflict') {
                return next.reconciliation?.outcome === 'conflict';
            }
            return false;
        }
        if (to === 'writing') {
            if (prev.dispatchPhase === 'in-flight') {
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
        if (to === 'conflict') return true;
        return false;
    }
    if (from === 'undoing') {
        if (prev.dispatchPhase === 'in-flight' && next.attemptId !== prev.attemptId) {
            if (to === 'undone') {
                return next.undo?.status === 'undone' && next.reconciliation?.outcome === 'undone';
            }
            if (to === 'conflict') {
                return next.reconciliation?.outcome === 'conflict';
            }
            return false;
        }
        if (to === 'undoing') {
            if (prev.dispatchPhase === 'in-flight') {
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

function validateBookLockRecord(p) {
    if (!obj(p)) bad();
    const required = ['schema', 'identity', 'book', 'holder', 'ledger', 'history', 'updatedAt'];
    const allowed = new Set([...required, 'fence']);
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
    nullable(p.holder, h => {
        if (!obj(h)) bad();
        const holderRequired = ['batchId', 'threadId', 'attemptId', 'deviceId', 'mode', 'acquiredAt'];
        const holderAllowed = new Set([...holderRequired, 'phase', 'fence', 'chat']);
        for (const k of holderRequired) {
            if (!(k in h)) bad();
        }
        for (const k of Object.keys(h)) {
            if (!holderAllowed.has(k)) bad();
        }
        str(h.batchId, 128, false);
        str(h.threadId, 128, false);
        str(h.attemptId, 96, false);
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
        int(h.acquiredAt);
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
        keys(h, 'action,batchId,attemptId,deviceId,at,reason');
        one(h.action, ['acquire', 'in-flight', 'hold-unresolved', 'release', 'takeover', 'abort', 'conflict']);
        str(h.batchId, 128, false);
        str(h.attemptId, 96, false);
        str(h.deviceId, 64, false);
        int(h.at);
        str(h.reason, 500);
    });
    int(p.updatedAt);
}

export function transitionLorebookBookLock(prev, next) {
    if (!prev) {
        return true;
    }
    if (
        prev.identity.kind !== next.identity.kind
        || prev.identity.owner !== next.identity.owner
        || prev.identity.chat !== next.identity.chat
        || prev.book !== next.book
    ) {
        return false;
    }
    if (prev.fence != null && next.fence != null && next.fence < prev.fence) {
        return false;
    }
    if (prev.holder === null && next.holder !== null) {
        return true;
    }
    if (prev.holder !== null && next.holder === null) {
        const last = next.history.at(-1);
        if (!last || !['release', 'abort'].includes(last.action)) return false;
        if (last.action === 'release' && last.attemptId !== prev.holder.attemptId) return false;
        if (prev.holder.phase === 'in-flight' && last.attemptId !== prev.holder.attemptId) {
            return false;
        }
        if (prev.holder.phase === 'conflict' && last.action !== 'release') {
            return false;
        }
        return true;
    }
    if (prev.holder !== null && next.holder !== null) {
        if (prev.holder.attemptId === next.holder.attemptId) return true;
        if (prev.holder.phase === 'in-flight') {
            // Cannot take over an in-flight lock for apply/undo or without positive ledger/conflict evidence
            if (next.holder.mode !== 'reconcile') return false;
            const hasLedgerEvidence = (next.ledger?.length || 0) > (prev.ledger?.length || 0);
            const isConflictLock = next.holder.phase === 'conflict';
            if (!hasLedgerEvidence && !isConflictLock) return false;
        }
        if (['unknown', 'undo-unknown', 'conflict'].includes(prev.holder.phase)) {
            if (['apply', 'undo'].includes(next.holder.mode)) return false;
            if (next.holder.batchId !== prev.holder.batchId) return false;
        }
        const last = next.history.at(-1);
        return Boolean(
            last
            && last.action === 'takeover'
            && last.attemptId === next.holder.attemptId
            && last.reason.trim().length > 0,
        );
    }
    return true;
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
    }),
]);
