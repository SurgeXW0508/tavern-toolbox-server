import {
    bad, obj, keys, str, int, bool, one, array, unique, nullable,
    validateCloudConnectionId, validateOracleIdentity, validateOracleRecipe,
    validatePromptProfiles,
} from './oracle-validation.js';

export const validateCorrectionIdentity = validateOracleIdentity;

const SHARED_SOURCES = Object.freeze([
    'persona',
    'character-card',
    'story-summary',
    'world-info',
    'main-chat',
]);

const FULL_SOURCES = Object.freeze([
    ...SHARED_SOURCES,
    'current-target',
    'fixed-protocol',
    'current-input',
]);

const FULL_PROTECTED_SOURCES = Object.freeze([
    'current-target',
    'fixed-protocol',
    'current-input',
]);

const SELECTION_SOURCES = Object.freeze([
    ...SHARED_SOURCES,
    'selected-span',
    'span-before',
    'span-after',
    'full-target-background',
    'fixed-protocol',
    'current-input',
]);

const SELECTION_PROTECTED_SOURCES = Object.freeze([
    'selected-span',
    'fixed-protocol',
    'current-input',
]);

const METRIC_BOOL_KEYS = new Set([
    'streamRequested', 'usedStreamFallback', 'lateStreamRecovered',
    'completionEventAvailable', 'lateStreamTimedOut', 'stopAccepted',
]);
const METRIC_INT_KEYS = new Set([
    'streamEvents', 'ignoredStreamEvents', 'requestSentMs', 'firstContentMs',
    'lastContentMs', 'resolvedMs', 'settleLagMs', 'lateStreamWaitMs', 'stopAttempts',
]);
const METRIC_STR_KEYS = new Set([
    'generationId', 'environment', 'completionSource', 'model', 'provider',
]);

const hex64 = v => {
    if (typeof v !== 'string' || !/^[0-9a-f]{64}$/.test(v)) bad();
};

const candidateId = v => {
    str(v, 96, false);
    if (!/^correction-[A-Za-z0-9_-]{1,80}$/.test(v)) bad();
};

export function validateCorrectionRecipe(v, mode = 'full') {
    const isSelection = mode === 'selection';
    const sources = isSelection ? SELECTION_SOURCES : FULL_SOURCES;
    const protectedSources = isSelection ? SELECTION_PROTECTED_SOURCES : FULL_PROTECTED_SOURCES;
    validateOracleRecipe(v, {
        sources,
        protectedSources,
        requiredSources: protectedSources,
        validateOptions(source, options) {
            if (source === 'world-info') {
                keys(options, 'mode');
                one(options.mode, ['st', 'off']);
            } else if (source === 'main-chat') {
                keys(options, 'depth');
                int(options.depth, 0, 100);
            } else {
                keys(options, '');
            }
        },
    });
}

function validateCorrectionRecipesPair(recipes) {
    keys(recipes, 'full,selection');
    validateCorrectionRecipe(recipes.full, 'full');
    validateCorrectionRecipe(recipes.selection, 'selection');
}

export function validateCorrectionSettings(p) {
    keys(
        p,
        'settingsVersion,connectionId,selectionContextChars,includeFullTargetForSelection,quickCommands,recipes,promptProfiles',
    );
    if (p.settingsVersion !== 4) bad();
    validateCloudConnectionId(p.connectionId);
    int(p.selectionContextChars, 0, 4000);
    bool(p.includeFullTargetForSelection);
    array(p.quickCommands, 50, q => {
        keys(q, 'id,name,content,favorite');
        str(q.id, 90, false);
        str(q.name, 60, false);
        str(q.content, 8000, false);
        bool(q.favorite);
    });
    unique(p.quickCommands, 'id');
    validateCorrectionRecipesPair(p.recipes);
    validatePromptProfiles(p.promptProfiles, {
        payloadKeys: 'recipes,selectionContextChars,includeFullTargetForSelection',
        validatePayload(payload) {
            validateCorrectionRecipesPair(payload.recipes);
            int(payload.selectionContextChars, 0, 4000);
            bool(payload.includeFullTargetForSelection);
        },
    });
    return p;
}

export const correctionSettingsConsumer = Object.freeze({
    id: 'oracle-correction-settings',
    schemaVersion: 1,
    maxBytes: 2 * 1024 * 1024,
    limits: { maxProfiles: 100, maxRecipeNodes: 128, maxQuickCommands: 50 },
    validate: validateCorrectionSettings,
});

function validateCandidateMetrics(m) {
    if (!obj(m)) bad();
    for (const [k, v] of Object.entries(m)) {
        if (METRIC_BOOL_KEYS.has(k)) bool(v);
        else if (METRIC_INT_KEYS.has(k)) nullable(v, x => int(x, 0, 86400000));
        else if (METRIC_STR_KEYS.has(k)) nullable(v, x => str(x, 120));
        else bad();
    }
}

function validateWorkspaceRecord(p) {
    keys(p, 'identity,mode,targetMessageId,selection,selectionTargetKey,instruction,activeCandidateId');
    validateCorrectionIdentity(p.identity);
    one(p.mode, ['full', 'selection']);
    nullable(p.targetMessageId, v => int(v, 0, 1000000));
    keys(p.selection, 'start,end');
    int(p.selection.start, 0, 1000000);
    int(p.selection.end, p.selection.start, 1000000);
    str(p.selectionTargetKey, 700);
    str(p.instruction, 20000);
    str(p.activeCandidateId, 96);
    if (p.activeCandidateId) candidateId(p.activeCandidateId);
}

function validateCandidateIndexRecord(p) {
    keys(p, 'identity,candidates');
    validateCorrectionIdentity(p.identity);
    array(p.candidates, 30, c => {
        keys(
            c,
            'id,createdAt,messageId,mode,lockDigest,versionKey,applicable,staleReason,manualRecovery,warningCounts,stats,instructionPreview,bodyBytes',
        );
        candidateId(c.id);
        int(c.createdAt);
        int(c.messageId, 0, 1000000);
        one(c.mode, ['full', 'selection']);
        hex64(c.lockDigest);
        hex64(c.versionKey);
        bool(c.applicable);
        str(c.staleReason, 200);
        bool(c.manualRecovery);
        keys(c.warningCounts, 'blocked,confirm,notice');
        int(c.warningCounts.blocked, 0, 100);
        int(c.warningCounts.confirm, 0, 100);
        int(c.warningCounts.notice, 0, 100);
        keys(c.stats, 'beforeChars,afterChars,changedChars');
        int(c.stats.beforeChars, 0, 1000000);
        int(c.stats.afterChars, 0, 1000000);
        int(c.stats.changedChars, 0, 1000000);
        str(c.instructionPreview, 120);
        int(c.bodyBytes, 1, 1024 * 1024);
    });
    unique(p.candidates, 'id');
}

function validateCandidateBodyRecord(p) {
    keys(p, 'identity,candidate');
    validateCorrectionIdentity(p.identity);
    const c = p.candidate;
    keys(
        c,
        'id,chatKey,targetLock,mode,selection,instruction,replacement,fullText,rawOutput,protectedBlocks,staleReason,manualRecovery,metrics,createdAt,lockDigest,versionKey,basedOnCandidateId',
    );
    candidateId(c.id);
    str(c.chatKey, 512, false);
    if (c.chatKey !== p.identity.chat) bad();
    keys(
        c.targetLock,
        'schema,chatKey,messageId,role,name,swipeId,swipeCount,content,currentSwipeData,currentSwipeInfo',
    );
    if (c.targetLock.schema !== 2 || c.targetLock.chatKey !== p.identity.chat || c.targetLock.role !== 'assistant') {
        bad();
    }
    int(c.targetLock.messageId, 0, 1000000);
    str(c.targetLock.name, 512);
    int(c.targetLock.swipeId, 0, 100000);
    int(c.targetLock.swipeCount, c.targetLock.swipeId + 1, 100000);
    str(c.targetLock.content, 400000, false);
    str(c.targetLock.currentSwipeData, 200000, false);
    str(c.targetLock.currentSwipeInfo, 200000, false);
    one(c.mode, ['full', 'selection']);
    if (c.mode === 'selection') {
        keys(c.selection, 'start,end');
        int(c.selection.start, 0, c.targetLock.content.length);
        int(c.selection.end, c.selection.start, c.targetLock.content.length);
    } else if (c.selection !== null) {
        bad();
    }
    str(c.instruction, 20000);
    str(c.replacement, 400000);
    str(c.fullText, 400000, false);
    str(c.rawOutput, 450000);
    int(c.protectedBlocks, 0, 10000);
    str(c.staleReason, 200);
    bool(c.manualRecovery);
    nullable(c.metrics, validateCandidateMetrics);
    int(c.createdAt);
    hex64(c.lockDigest);
    hex64(c.versionKey);
    str(c.basedOnCandidateId, 96);
    if (c.basedOnCandidateId) candidateId(c.basedOnCandidateId);
}

function validateApplicationRecord(p) {
    keys(
        p,
        'schema,identity,version,state,cycle,operationId,candidateId,fullTextDigest,holder,updatedAt,result,releaseReason,recoveryReason,history',
    );
    if (p.schema !== 1) bad();
    validateCorrectionIdentity(p.identity);
    keys(p.version, 'messageId,swipeId,swipeCount,contentDigest');
    int(p.version.messageId, 0, 1000000);
    int(p.version.swipeId, 0, 100000);
    int(p.version.swipeCount, p.version.swipeId + 1, 100000);
    hex64(p.version.contentDigest);
    one(p.state, ['claimed', 'applying', 'applied', 'recovery', 'released']);
    int(p.cycle, 1, 1000000);
    str(p.operationId, 64, false);
    if (!/^op-[A-Za-z0-9_-]{1,60}$/.test(p.operationId)) bad();
    candidateId(p.candidateId);
    hex64(p.fullTextDigest);
    str(p.holder, 40, false);
    if (!/^[A-Za-z0-9:_-]{1,40}$/.test(p.holder)) bad();
    int(p.updatedAt);

    if (p.state === 'applied') {
        if (!obj(p.result) || p.releaseReason !== null || p.recoveryReason !== null) bad();
        keys(p.result, 'sourceSwipeId,appendedSwipeId,appliedAt,verification');
        int(p.result.sourceSwipeId, 0, 100000);
        int(p.result.appendedSwipeId, 0, 100000);
        int(p.result.appliedAt);
        one(p.result.verification, [
            'read-back',
            'marker',
            'marker-text-modified',
            'message-moved',
            'legacy',
            'imported',
        ]);
    } else if (p.state === 'recovery') {
        if (p.result !== null || p.releaseReason !== null) bad();
        str(p.recoveryReason, 500, false);
    } else if (p.state === 'released') {
        if (p.result !== null || p.recoveryReason !== null) bad();
        one(p.releaseReason, [
            'cancelled',
            'lock-mismatch',
            'write-failed-unchanged',
            'forced',
            'reopened',
            'takeover',
        ]);
    } else if (p.result !== null || p.releaseReason !== null || p.recoveryReason !== null) {
        bad();
    }

    array(p.history, 8, h => {
        keys(h, 'cycle,operationId,candidateId,outcome,at');
        int(h.cycle, 1, 1000000);
        str(h.operationId, 64, false);
        if (!/^op-[A-Za-z0-9_-]{1,60}$/.test(h.operationId)) bad();
        candidateId(h.candidateId);
        str(h.outcome, 80, false);
        int(h.at);
    });
}

export function transitionCorrectionApplication(prev, next) {
    if (!prev) {
        if (next.state === 'claimed' && next.cycle === 1) return true;
        if (next.state === 'applied' && next.cycle === 1 && next.result?.verification === 'imported') return true;
        return false;
    }
    if (
        prev.identity.kind !== next.identity.kind
        || prev.identity.owner !== next.identity.owner
        || prev.identity.chat !== next.identity.chat
        || prev.version.messageId !== next.version.messageId
        || prev.version.swipeId !== next.version.swipeId
        || prev.version.swipeCount !== next.version.swipeCount
        || prev.version.contentDigest !== next.version.contentDigest
    ) {
        return false;
    }

    // Late history-only audit append (e.g. applied-after-takeover) without altering current claim state.
    if (
        prev.state === next.state
        && prev.cycle === next.cycle
        && prev.operationId === next.operationId
        && prev.candidateId === next.candidateId
        && prev.fullTextDigest === next.fullTextDigest
        && prev.holder === next.holder
        && JSON.stringify(prev.result) === JSON.stringify(next.result)
        && prev.releaseReason === next.releaseReason
        && prev.recoveryReason === next.recoveryReason
    ) {
        return next.history.length >= 1 && next.history.at(-1)?.outcome === 'applied-after-takeover';
    }

    const from = prev.state;
    const to = next.state;
    const sameOp = next.cycle === prev.cycle && next.operationId === prev.operationId;
    const sameCandidate = sameOp
        && next.candidateId === prev.candidateId
        && next.fullTextDigest === prev.fullTextDigest;

    if (from === 'released' && to === 'claimed') {
        return next.cycle === prev.cycle + 1 && next.operationId !== prev.operationId;
    }
    if (from === 'claimed' && to === 'claimed') {
        return next.cycle === prev.cycle && next.operationId !== prev.operationId;
    }
    if (from === 'claimed' && to === 'applying') {
        return sameCandidate;
    }
    if (from === 'claimed' && to === 'released') {
        return sameOp && ['cancelled', 'lock-mismatch'].includes(next.releaseReason);
    }
    if (from === 'applying' && to === 'applied') {
        return sameCandidate && next.result !== null && next.result.verification !== 'imported';
    }
    if (from === 'applying' && to === 'recovery') {
        return sameCandidate && Boolean(next.recoveryReason);
    }
    if (from === 'applying' && to === 'released') {
        return sameOp && ['cancelled', 'write-failed-unchanged', 'forced'].includes(next.releaseReason);
    }
    if (from === 'recovery' && to === 'applied') {
        return sameCandidate && next.result !== null && next.result.verification !== 'imported';
    }
    if (from === 'recovery' && to === 'released') {
        return sameOp && next.releaseReason === 'forced';
    }
    if (from === 'applied' && to === 'released') {
        return sameOp && next.releaseReason === 'reopened';
    }
    return false;
}

export function validateCorrectionRecord(consumer, p) {
    if (consumer === 'oracle-correction-workspace') validateWorkspaceRecord(p);
    else if (consumer === 'oracle-correction-candidate-index') validateCandidateIndexRecord(p);
    else if (consumer === 'oracle-correction-candidates') validateCandidateBodyRecord(p);
    else if (consumer === 'oracle-correction-applications') validateApplicationRecord(p);
    else bad();
    return p;
}

export const correctionRecordConsumers = Object.freeze([
    Object.freeze({
        id: 'oracle-correction-workspace',
        schemaVersion: 1,
        maxBytes: 64 * 1024,
        maxRecords: 4000,
        maxStorageBytes: 64 * 1024 * 1024,
        deletable: false,
        validate: p => validateCorrectionRecord('oracle-correction-workspace', p),
    }),
    Object.freeze({
        id: 'oracle-correction-candidate-index',
        schemaVersion: 1,
        maxBytes: 64 * 1024,
        maxRecords: 4000,
        maxStorageBytes: 64 * 1024 * 1024,
        deletable: false,
        validate: p => validateCorrectionRecord('oracle-correction-candidate-index', p),
    }),
    Object.freeze({
        id: 'oracle-correction-candidates',
        schemaVersion: 1,
        maxBytes: 1024 * 1024,
        maxRecords: 10000,
        maxTombstones: 20000,
        maxStorageBytes: 256 * 1024 * 1024,
        deletable: true,
        validate: p => validateCorrectionRecord('oracle-correction-candidates', p),
    }),
    Object.freeze({
        id: 'oracle-correction-applications',
        schemaVersion: 1,
        maxBytes: 8 * 1024,
        maxRecords: 20000,
        maxStorageBytes: 32 * 1024 * 1024,
        deletable: false,
        validate: p => validateCorrectionRecord('oracle-correction-applications', p),
        transition: transitionCorrectionApplication,
    }),
]);
