import {
    bad, obj, keys, str, int, bool, one, array, unique, nullable,
    validateCloudConnectionId, validateOracleIdentity, validateOracleRecipe,
    validatePromptProfiles, validateThreadIndexEntries,
} from './oracle-validation.js';

export const validateAdvisorIdentity = validateOracleIdentity;

function keysWithOptional(v, requiredNames, optionalNames = '') {
    if (!obj(v)) bad();
    const required = requiredNames ? requiredNames.split(',') : [];
    const optional = optionalNames ? optionalNames.split(',') : [];
    const allowed = new Set([...required, ...optional]);
    const actual = Object.keys(v);
    if (actual.some(k => !allowed.has(k)) || required.some(k => !Object.hasOwn(v, k))) bad();
}

export function validateAdvisorRecipe(v, arc = false) {
    if (arc) {
        // LEGACY_ARC_COMPAT
        return validateLegacyArcRecipe(v);
    }
    const sources = ['persona', 'character-card', 'world-info', 'stat-data', 'story-summary', 'main-chat',
        'active-guidance', 'advisor-history', 'story-plan-protocol', 'current-input'];
    const protectedSources = ['story-plan-protocol', 'current-input'];
    validateOracleRecipe(v, {
        sources,
        protectedSources,
        requiredSources: protectedSources,
        validateOptions(source, options) {
            if (source === 'world-info') {
                keys(options, 'mode');
                one(options.mode, ['st', 'all', 'char', 'selected', 'off']);
            } else if (['main-chat', 'advisor-history'].includes(source)) {
                const names = source === 'main-chat' ? 'depth,includeHidden' : 'depth';
                keys(options, names);
                int(options.depth, -1, 500);
                if (source === 'main-chat') bool(options.includeHidden);
            } else keys(options, '');
        },
    });
}

function validateAdvisorSettingsBody(v) {
    keys(v, 'settingsVersion,connectionId,recipe,promptProfiles');
    if (v.settingsVersion !== 4 && v.settingsVersion !== 5) bad();
    validateCloudConnectionId(v.connectionId);
    validateAdvisorRecipe(v.recipe);
    validatePromptProfiles(v.promptProfiles, {
        payloadKeys: 'recipe',
        validatePayload(payload) {
            validateAdvisorRecipe(payload.recipe);
        },
    });
}

export function validateAdvisorSettings(p) {
    keysWithOptional(p, 'advisor,guidanceDepth', 'guidanceShouldScan,arc');
    validateAdvisorSettingsBody(p.advisor);
    int(p.guidanceDepth, 0, 10000);
    if (Object.hasOwn(p, 'guidanceShouldScan')) bool(p.guidanceShouldScan);
    // LEGACY_ARC_COMPAT
    if (Object.hasOwn(p, 'arc')) validateLegacyArcSettings(p.arc);
    return p;
}

export function validateOraclePersonas(p) {
    keys(p, 'personas');
    array(p.personas, 50, v => {
        keys(v, 'id,label,description,voice,example,custom');
        str(v.id, 90, false);
        if (!/^[A-Za-z0-9_-]+$/.test(v.id) || ['plain', 'konata', 'beatrice', 'shinobu'].includes(v.id) || v.custom !== true) bad();
        str(v.label, 60, false);
        str(v.description, 240);
        str(v.voice, 8000, false);
        str(v.example, 8000);
    });
    unique(p.personas, 'id');
    return p;
}

export const advisorSettingsConsumer = Object.freeze({
    id: 'oracle-advisor-settings',
    schemaVersion: 1,
    maxBytes: 2 * 1024 * 1024,
    limits: { maxProfiles: 100, maxRecipeNodes: 128 },
    validate: validateAdvisorSettings,
});
export const oraclePersonasConsumer = Object.freeze({
    id: 'oracle-voice-personas',
    schemaVersion: 1,
    maxBytes: 2 * 1024 * 1024,
    limits: { maxPersonas: 50 },
    validate: validateOraclePersonas,
});

function guidance(v, ended = false) {
    const names = 'id,title,goal,seed,why,intensity,sourceThreadId,sourceMessageId,adoptedAt,adoptedAtMessageCount,reminded,injectionOverride';
    const optional = ['remindedAt', ...(ended ? ['outcome', 'endedAt'] : [])];
    if (!obj(v) || Object.keys(v).some(k => !names.split(',').concat(optional).includes(k)) || names.split(',').some(k => !Object.hasOwn(v, k))) bad();
    for (const k of ['id', 'sourceThreadId', 'sourceMessageId']) str(v[k], 512);
    for (const k of ['title', 'goal', 'seed', 'why', 'injectionOverride']) str(v[k], 30000);
    if (!v.goal.trim()) bad();
    one(v.intensity, ['seed', 'normal', 'push']);
    str(v.adoptedAt, 64, false);
    int(v.adoptedAtMessageCount);
    bool(v.reminded);
    if (v.remindedAt !== undefined) str(v.remindedAt, 64);
    if (ended) {
        // LEGACY_ARC_COMPAT: preserve historical 'replaced-by-arc' outcome
        one(v.outcome, ['completed', 'abandoned', 'replaced', 'replaced-by-arc']);
        str(v.endedAt, 64, false);
    }
}

export function validateAdvisorRecord(consumer, p) {
    if (consumer === 'oracle-advisor-thread-index') {
        keys(p, 'identity,threads');
        validateAdvisorIdentity(p.identity);
        validateThreadIndexEntries(p.threads, 50);
    } else if (consumer === 'oracle-advisor-threads') {
        keys(p, 'identity,thread');
        validateAdvisorIdentity(p.identity);
        keys(p.thread, 'id,title,autoTitle,createdAt,updatedAt,messages');
        str(p.thread.id, 128, false);
        str(p.thread.title, 60, false);
        bool(p.thread.autoTitle);
        int(p.thread.createdAt);
        int(p.thread.updatedAt);
        array(p.thread.messages, 100000, m => {
            if (!obj(m) || Object.keys(m).some(k => !['id', 'role', 'content', 'prompt', 'failed', 'meta', 'stopped', 'unconfirmed'].includes(k))) bad();
            str(m.id, 256, false);
            one(m.role, ['user', 'assistant']);
            str(m.content, 1000000);
            if (Object.hasOwn(m, 'prompt')) bool(m.prompt);
            if (Object.hasOwn(m, 'failed')) bool(m.failed);
            if (Object.hasOwn(m, 'meta')) str(m.meta, 2000);
            if (Object.hasOwn(m, 'stopped')) {
                if (m.role !== 'assistant') bad();
                bool(m.stopped);
            }
            if (Object.hasOwn(m, 'unconfirmed')) {
                if (m.role !== 'assistant') bad();
                bool(m.unconfirmed);
            }
        });
        unique(p.thread.messages, 'id');
    } else if (consumer === 'oracle-advisor-workspace') {
        keys(p, 'identity,threadId,draft,loreSelection');
        validateAdvisorIdentity(p.identity);
        str(p.threadId, 128, false);
        str(p.draft, 1000000);
        keys(p.loreSelection, 'selected,hybrid');
        bool(p.loreSelection.hybrid);
        if (!obj(p.loreSelection.selected) || Object.keys(p.loreSelection.selected).length > 128) bad();
        let count = 0;
        for (const [book, ids] of Object.entries(p.loreSelection.selected)) {
            str(book, 512, false);
            array(ids, 4096, x => int(x));
            unique(ids);
            count += ids.length;
        }
        if (count > 8192) bad();
    } else if (consumer === 'oracle-advisor-story') {
        keysWithOptional(p, 'identity,guidance', 'arc');
        validateAdvisorIdentity(p.identity);
        keys(p.guidance, 'active,lastEnded');
        nullable(p.guidance.active, v => guidance(v));
        nullable(p.guidance.lastEnded, v => guidance(v, true));
        // LEGACY_ARC_COMPAT
        if (Object.hasOwn(p, 'arc')) {
            validateLegacyArcRecord(p.arc);
            if (p.guidance.active && p.arc.active) bad();
        }
    } else if (consumer === 'oracle-advisor-arc-workspace') {
        // LEGACY_ARC_COMPAT: dormant read-only consumer for existing SQLite records
        keys(p, 'identity,draft,draftDirty');
        validateAdvisorIdentity(p.identity);
        validateLegacyArcWorkspace(p);
    } else {
        bad();
    }
    return p;
}

const DELETABLE_ADVISOR_RECORDS = new Set(['oracle-advisor-threads', 'oracle-advisor-workspace']);

export const advisorRecordConsumers = Object.freeze([
    'oracle-advisor-thread-index',
    'oracle-advisor-threads',
    'oracle-advisor-workspace',
    'oracle-advisor-story',
    // LEGACY_ARC_COMPAT: retained dormant so existing SQLite records stay readable/valid
    'oracle-advisor-arc-workspace',
].map(id => Object.freeze({
    id,
    schemaVersion: 1,
    maxBytes: 2 * 1024 * 1024,
    maxRecords: DELETABLE_ADVISOR_RECORDS.has(id) ? 10000 : 4000,
    maxStorageBytes: 128 * 1024 * 1024,
    deletable: DELETABLE_ADVISOR_RECORDS.has(id),
    validate: p => validateAdvisorRecord(id, p),
})));

// LEGACY_ARC_COMPAT: isolated validators retained only for reading/accepting pre-Stage-2 records.
function validateLegacyArcRecipe(v) {
    const sources = ['persona', 'character-card', 'world-info', 'stat-data', 'story-summary', 'main-chat', 'arc-beat-protocol', 'compile-task'];
    const protectedSources = ['arc-beat-protocol', 'compile-task'];
    validateOracleRecipe(v, {
        sources,
        protectedSources,
        requiredSources: protectedSources,
        validateOptions(source, options) {
            if (source === 'world-info') {
                keys(options, 'mode');
                one(options.mode, ['st', 'all', 'char', 'off']);
            } else if (source === 'main-chat') {
                keys(options, 'depth,includeHidden');
                int(options.depth, -1, 500);
                bool(options.includeHidden);
            } else keys(options, '');
        },
    });
}

function validateLegacyArcSettings(v) {
    keys(v, 'settingsVersion,connectionId,tokenBudget,recipe,promptProfiles');
    if (v.settingsVersion !== 3) bad();
    validateCloudConnectionId(v.connectionId);
    int(v.tokenBudget, 0, 1000000);
    validateLegacyArcRecipe(v.recipe);
    validatePromptProfiles(v.promptProfiles, {
        payloadKeys: 'recipe,tokenBudget',
        validatePayload(payload) {
            validateLegacyArcRecipe(payload.recipe);
            int(payload.tokenBudget, 0, 1000000);
        },
    });
}

function validateLegacyArcDraft(v) {
    keys(v, 'mode,throughline,span,waypoints,difficulty,direction,redlines');
    one(v.mode, ['transparent', 'blind']);
    one(v.span, ['short', 'medium', 'long']);
    one(v.difficulty, ['gentle', 'normal', 'harsh']);
    str(v.throughline, 2000);
    str(v.direction, 1600);
    array(v.waypoints, 12, x => str(x, 800));
    if (v.waypoints.length < 3) bad();
    array(v.redlines, 20, x => str(x, 300, false));
}

function validateLegacyArcBeat(v) {
    keys(v, 'title,goal,objective,seed,why,type');
    str(v.title, 120);
    str(v.goal, 1200, false);
    str(v.objective, 800);
    str(v.seed, 1200);
    str(v.why, 1600);
    str(v.type, 80);
}

function validateLegacyActiveArc(v) {
    keys(v, 'id,mode,throughline,span,waypoints,difficulty,direction,redlines,waypointIndex,currentBeat,intensity,injectionOverride,status,history,startedAt,updatedAt,adoptedAtMessageCount,reminded,remindedAt');
    str(v.id, 200, false);
    one(v.mode, ['transparent', 'blind']);
    one(v.span, ['short', 'medium', 'long']);
    one(v.difficulty, ['gentle', 'normal', 'harsh']);
    str(v.throughline, 2000);
    str(v.direction, 1600);
    array(v.waypoints, 12, x => str(x, 800, false));
    if (!v.waypoints.length) bad();
    array(v.redlines, 20, x => str(x, 300, false));
    int(v.waypointIndex, 0, v.waypoints.length - 1);
    validateLegacyArcBeat(v.currentBeat);
    one(v.intensity, ['seed', 'normal', 'push']);
    str(v.injectionOverride, 30000);
    one(v.status, ['active', 'awaiting_next']);
    bool(v.reminded);
    for (const k of ['startedAt', 'updatedAt', 'adoptedAtMessageCount', 'remindedAt']) int(v[k]);
    array(v.history, 1000, h => {
        keys(h, 'waypointIndex,beat,outcome,endedAt');
        int(h.waypointIndex, 0, 11);
        validateLegacyArcBeat(h.beat);
        one(h.outcome, ['completed', 'rerolled']);
        int(h.endedAt);
    });
}

function validateLegacyArcRecord(v) {
    keys(v, 'draft,compiled,lastAttempt,active,lastEnded');
    validateLegacyArcDraft(v.draft);
    nullable(v.compiled, c => {
        keys(c, 'beat,raw,draftFingerprint,connectionId,createdAt,kind,waypointIndex,sourceActiveId,sourceActiveUpdatedAt,sourceActiveFingerprint');
        validateLegacyArcBeat(c.beat);
        str(c.raw, 30000);
        str(c.draftFingerprint, 20000);
        str(c.connectionId, 300);
        int(c.createdAt);
        one(c.kind, ['initial', 'advance', 'reroll']);
        int(c.waypointIndex, 0, 11);
        str(c.sourceActiveId, 200);
        int(c.sourceActiveUpdatedAt);
        str(c.sourceActiveFingerprint, 30000);
    });
    nullable(v.lastAttempt, a => {
        keys(a, 'raw,issues,stopped,createdAt');
        str(a.raw, 30000);
        array(a.issues, 20, x => str(x, 500));
        bool(a.stopped);
        int(a.createdAt);
    });
    nullable(v.active, validateLegacyActiveArc);
    nullable(v.lastEnded, e => {
        keys(e, 'arc,outcome,endedAt');
        validateLegacyActiveArc(e.arc);
        one(e.outcome, ['completed', 'exited', 'replaced']);
        int(e.endedAt);
    });
}

function validateLegacyArcWorkspace(p) {
    validateLegacyArcDraft(p.draft);
    bool(p.draftDirty);
}

