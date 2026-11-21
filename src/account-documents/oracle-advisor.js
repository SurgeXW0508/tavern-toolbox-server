import {
    bad, obj, keys, str, int, bool, one, array, unique, nullable,
    validateCloudConnectionId, validateOracleIdentity, validateOracleRecipe,
    validatePromptProfiles, validateThreadIndexEntries,
} from './oracle-validation.js';

export const validateAdvisorIdentity = validateOracleIdentity;

export function validateAdvisorRecipe(v, arc = false) {
    const sources = ['persona', 'character-card', 'world-info', 'stat-data', 'story-summary', 'main-chat',
        ...(arc ? ['arc-beat-protocol', 'compile-task'] : ['active-guidance', 'advisor-history', 'story-plan-protocol', 'current-input'])];
    const protectedSources = arc ? ['arc-beat-protocol', 'compile-task'] : ['story-plan-protocol', 'current-input'];
    validateOracleRecipe(v, {
        sources,
        protectedSources,
        requiredSources: protectedSources,
        validateOptions(source, options) {
            if (source === 'world-info') {
                keys(options, 'mode');
                one(options.mode, arc ? ['st', 'all', 'char', 'off'] : ['st', 'all', 'char', 'selected', 'off']);
            } else if (['main-chat', 'advisor-history'].includes(source)) {
                const names = source === 'main-chat' ? 'depth,includeHidden' : 'depth';
                keys(options, names);
                int(options.depth, -1, 500);
                if (source === 'main-chat') bool(options.includeHidden);
            } else keys(options, '');
        },
    });
}
function settings(v, arc) {
    keys(v, arc ? 'settingsVersion,connectionId,tokenBudget,recipe,promptProfiles' : 'settingsVersion,connectionId,recipe,promptProfiles');
    if (v.settingsVersion !== (arc ? 3 : 4)) bad();
    validateCloudConnectionId(v.connectionId);
    if (arc) int(v.tokenBudget, 0, 1000000);
    validateAdvisorRecipe(v.recipe, arc);
    validatePromptProfiles(v.promptProfiles, {
        payloadKeys: arc ? 'recipe,tokenBudget' : 'recipe',
        validatePayload(payload) {
            validateAdvisorRecipe(payload.recipe, arc);
            if (arc) int(payload.tokenBudget, 0, 1000000);
        },
    });
}
export function validateAdvisorSettings(p) { keys(p, 'advisor,arc,guidanceDepth'); settings(p.advisor, false); settings(p.arc, true); int(p.guidanceDepth, 0, 10000); return p; }
export function validateOraclePersonas(p) {
    keys(p, 'personas'); array(p.personas, 50, v => {
        keys(v, 'id,label,description,voice,example,custom'); str(v.id, 90, false);
        if (!/^[A-Za-z0-9_-]+$/.test(v.id) || ['plain', 'konata', 'beatrice', 'shinobu'].includes(v.id) || v.custom !== true) bad();
        str(v.label, 60, false); str(v.description, 240); str(v.voice, 8000, false); str(v.example, 8000);
    }); unique(p.personas, 'id'); return p;
}
export const advisorSettingsConsumer = Object.freeze({ id: 'oracle-advisor-settings', schemaVersion: 1, maxBytes: 2 * 1024 * 1024,
    limits: { maxProfiles: 100, maxRecipeNodes: 128 }, validate: validateAdvisorSettings });
export const oraclePersonasConsumer = Object.freeze({ id: 'oracle-voice-personas', schemaVersion: 1, maxBytes: 2 * 1024 * 1024,
    limits: { maxPersonas: 50 }, validate: validateOraclePersonas });

function arcDraft(v) {
    keys(v, 'mode,throughline,span,waypoints,difficulty,direction,redlines'); one(v.mode, ['transparent', 'blind']); one(v.span, ['short', 'medium', 'long']);
    one(v.difficulty, ['gentle', 'normal', 'harsh']); str(v.throughline, 2000); str(v.direction, 1600);
    array(v.waypoints, 12, x => str(x, 800)); if (v.waypoints.length < 3) bad(); array(v.redlines, 20, x => str(x, 300, false));
}
function beat(v) { keys(v, 'title,goal,objective,seed,why,type'); str(v.title, 120); str(v.goal, 1200, false); str(v.objective, 800); str(v.seed, 1200); str(v.why, 1600); str(v.type, 80); }
function activeArc(v) {
    keys(v, 'id,mode,throughline,span,waypoints,difficulty,direction,redlines,waypointIndex,currentBeat,intensity,injectionOverride,status,history,startedAt,updatedAt,adoptedAtMessageCount,reminded,remindedAt');
    str(v.id, 200, false); one(v.mode, ['transparent', 'blind']); one(v.span, ['short', 'medium', 'long']); one(v.difficulty, ['gentle', 'normal', 'harsh']);
    str(v.throughline, 2000); str(v.direction, 1600); array(v.waypoints, 12, x => str(x, 800, false)); if (!v.waypoints.length) bad();
    array(v.redlines, 20, x => str(x, 300, false)); int(v.waypointIndex, 0, v.waypoints.length - 1); beat(v.currentBeat);
    one(v.intensity, ['seed', 'normal', 'push']); str(v.injectionOverride, 30000); one(v.status, ['active', 'awaiting_next']); bool(v.reminded);
    for (const k of ['startedAt', 'updatedAt', 'adoptedAtMessageCount', 'remindedAt']) int(v[k]);
    array(v.history, 1000, h => { keys(h, 'waypointIndex,beat,outcome,endedAt'); int(h.waypointIndex, 0, 11); beat(h.beat); one(h.outcome, ['completed', 'rerolled']); int(h.endedAt); });
}
function arcRecord(v) {
    keys(v, 'draft,compiled,lastAttempt,active,lastEnded'); arcDraft(v.draft);
    nullable(v.compiled, c => { keys(c, 'beat,raw,draftFingerprint,connectionId,createdAt,kind,waypointIndex,sourceActiveId,sourceActiveUpdatedAt,sourceActiveFingerprint');
        beat(c.beat); str(c.raw, 30000); str(c.draftFingerprint, 20000); str(c.connectionId, 300); int(c.createdAt); one(c.kind, ['initial', 'advance', 'reroll']);
        int(c.waypointIndex, 0, 11); str(c.sourceActiveId, 200); int(c.sourceActiveUpdatedAt); str(c.sourceActiveFingerprint, 30000); });
    nullable(v.lastAttempt, a => { keys(a, 'raw,issues,stopped,createdAt'); str(a.raw, 30000); array(a.issues, 20, x => str(x, 500)); bool(a.stopped); int(a.createdAt); });
    nullable(v.active, activeArc); nullable(v.lastEnded, e => { keys(e, 'arc,outcome,endedAt'); activeArc(e.arc); one(e.outcome, ['completed', 'exited', 'replaced']); int(e.endedAt); });
}
function guidance(v, ended = false) {
    const names = 'id,title,goal,seed,why,intensity,sourceThreadId,sourceMessageId,adoptedAt,adoptedAtMessageCount,reminded,injectionOverride';
    const optional = ['remindedAt', ...(ended ? ['outcome', 'endedAt'] : [])];
    if (!obj(v) || Object.keys(v).some(k => !names.split(',').concat(optional).includes(k)) || names.split(',').some(k => !Object.hasOwn(v, k))) bad();
    for (const k of ['id', 'sourceThreadId', 'sourceMessageId']) str(v[k], 512);
    for (const k of ['title', 'goal', 'seed', 'why', 'injectionOverride']) str(v[k], 30000);
    if (!v.goal.trim()) bad(); one(v.intensity, ['seed', 'normal', 'push']); str(v.adoptedAt, 64, false); int(v.adoptedAtMessageCount); bool(v.reminded);
    if (v.remindedAt !== undefined) str(v.remindedAt, 64); if (ended) { one(v.outcome, ['completed', 'abandoned', 'replaced', 'replaced-by-arc']); str(v.endedAt, 64, false); }
}
export function validateAdvisorRecord(consumer, p) {
    const root = consumer === 'oracle-advisor-thread-index' ? 'identity,threads' : consumer === 'oracle-advisor-threads' ? 'identity,thread'
        : consumer === 'oracle-advisor-workspace' ? 'identity,threadId,draft,loreSelection' : consumer === 'oracle-advisor-story' ? 'identity,guidance,arc' : 'identity,draft,draftDirty';
    keys(p, root); validateAdvisorIdentity(p.identity);
    if (consumer === 'oracle-advisor-thread-index') {
        validateThreadIndexEntries(p.threads, 50);
    } else if (consumer === 'oracle-advisor-threads') {
        keys(p.thread, 'id,title,autoTitle,createdAt,updatedAt,messages'); str(p.thread.id, 128, false); str(p.thread.title, 60, false); bool(p.thread.autoTitle); int(p.thread.createdAt); int(p.thread.updatedAt);
        array(p.thread.messages, 100000, m => {
            if (!obj(m) || Object.keys(m).some(k => !['id', 'role', 'content', 'prompt', 'failed', 'meta'].includes(k))) bad();
            str(m.id, 256, false); one(m.role, ['user', 'assistant']); str(m.content, 1000000);
            if (m.prompt !== undefined) bool(m.prompt); if (m.failed !== undefined) bool(m.failed); if (m.meta !== undefined) str(m.meta, 2000);
        }); unique(p.thread.messages, 'id');
    } else if (consumer === 'oracle-advisor-workspace') {
        str(p.threadId, 128, false); str(p.draft, 1000000); keys(p.loreSelection, 'selected,hybrid'); bool(p.loreSelection.hybrid);
        if (!obj(p.loreSelection.selected) || Object.keys(p.loreSelection.selected).length > 128) bad(); let count = 0;
        for (const [book, ids] of Object.entries(p.loreSelection.selected)) { str(book, 512, false); array(ids, 4096, x => int(x)); unique(ids); count += ids.length; } if (count > 8192) bad();
    } else if (consumer === 'oracle-advisor-story') {
        keys(p.guidance, 'active,lastEnded'); nullable(p.guidance.active, v => guidance(v)); nullable(p.guidance.lastEnded, v => guidance(v, true)); arcRecord(p.arc);
        if (p.guidance.active && p.arc.active) bad();
    } else { arcDraft(p.draft); bool(p.draftDirty); }
    return p;
}
export const advisorRecordConsumers = Object.freeze(['oracle-advisor-thread-index', 'oracle-advisor-threads', 'oracle-advisor-workspace', 'oracle-advisor-story', 'oracle-advisor-arc-workspace']
    .map(id => Object.freeze({ id, schemaVersion: 1, maxBytes: 2 * 1024 * 1024, maxRecords: id.endsWith('threads') ? 10000 : 4000,
        maxStorageBytes: 128 * 1024 * 1024, deletable: id.endsWith('threads'), validate: p => validateAdvisorRecord(id, p) })));
