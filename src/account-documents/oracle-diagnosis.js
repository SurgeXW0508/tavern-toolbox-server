import {
    bad, obj, keys, str, int, bool, one, array, unique,
    validateCloudConnectionId, validateOracleIdentity, validateOracleRecipe,
    validatePromptProfiles, validateThreadIndexEntries,
} from './oracle-validation.js';

export const validateDiagnosisIdentity = validateOracleIdentity;

const DIAGNOSIS_SOURCES = Object.freeze([
    'character-card',
    'diagnosis-rules',
    'stat-data',
    'latest-update',
    'main-chat',
    'diagnosis-history',
    'patch-protocol',
    'current-input',
]);

const DIAGNOSIS_PROTECTED_SOURCES = Object.freeze([
    'diagnosis-rules',
    'stat-data',
    'latest-update',
    'patch-protocol',
    'current-input',
]);

const DIAGNOSIS_RULE_MODES = Object.freeze(['mvu', 'rules', 'all']);

export function validateDiagnosisRecipe(v, { allowEmptyDiagnosisRulesOptions = false } = {}) {
    validateOracleRecipe(v, {
        sources: DIAGNOSIS_SOURCES,
        protectedSources: DIAGNOSIS_PROTECTED_SOURCES,
        requiredSources: DIAGNOSIS_PROTECTED_SOURCES,
        validateOptions(source, options) {
            if (source === 'main-chat') {
                keys(options, 'depth,includeHidden');
                int(options.depth, -1, 500);
                bool(options.includeHidden);
            } else if (source === 'diagnosis-rules') {
                if (!obj(options)) bad();
                if (allowEmptyDiagnosisRulesOptions && Object.keys(options).length === 0) return;
                keys(options, 'mode');
                one(options.mode, DIAGNOSIS_RULE_MODES);
            } else {
                keys(options, '');
            }
        },
    });
}

function validateDiagnosisSettingsBody(p, recipeOpts = {}) {
    keys(p, 'settingsVersion,connectionId,recipe,promptProfiles');
    if (p.settingsVersion !== 4) bad();
    validateCloudConnectionId(p.connectionId);
    validateDiagnosisRecipe(p.recipe, recipeOpts);
    validatePromptProfiles(p.promptProfiles, {
        payloadKeys: 'recipe',
        validatePayload(payload) {
            validateDiagnosisRecipe(payload.recipe, recipeOpts);
        },
    });
    return p;
}

export function validateDiagnosisSettings(p) {
    return validateDiagnosisSettingsBody(p, { allowEmptyDiagnosisRulesOptions: false });
}

export function validateDiagnosisSettingsV1(p) {
    return validateDiagnosisSettingsBody(p, { allowEmptyDiagnosisRulesOptions: true });
}

function normalizeDiagnosisRulesRecipeToV2(recipe) {
    return {
        ...recipe,
        nodes: recipe.nodes.map(node => node.source === 'diagnosis-rules'
            ? { ...node, options: { mode: node.options?.mode || 'mvu' } }
            : node),
    };
}

export function migrateDiagnosisSettingsV1ToV2(p) {
    const cloned = structuredClone(p);
    cloned.recipe = normalizeDiagnosisRulesRecipeToV2(cloned.recipe);
    cloned.promptProfiles = {
        ...cloned.promptProfiles,
        items: cloned.promptProfiles.items.map(item => ({
            ...item,
            payload: {
                ...item.payload,
                recipe: normalizeDiagnosisRulesRecipeToV2(item.payload.recipe),
            },
        })),
    };
    return cloned;
}

export const diagnosisSettingsConsumer = Object.freeze({
    id: 'oracle-diagnosis-settings',
    schemaVersion: 2,
    maxBytes: 2 * 1024 * 1024,
    limits: { maxProfiles: 100, maxRecipeNodes: 128 },
    validate: validateDiagnosisSettings,
    migrations: Object.freeze([
        Object.freeze({
            fromVersion: 1,
            toVersion: 2,
            validateSource: validateDiagnosisSettingsV1,
            convert: migrateDiagnosisSettingsV1ToV2,
        }),
    ]),
});

export function validateDiagnosisRecord(consumer, p) {
    const root = consumer === 'oracle-diagnosis-thread-index'
        ? 'identity,threads'
        : consumer === 'oracle-diagnosis-threads'
            ? 'identity,thread'
            : 'identity,selection';
    keys(p, root);
    validateDiagnosisIdentity(p.identity);
    if (consumer === 'oracle-diagnosis-thread-index') {
        validateThreadIndexEntries(p.threads, 50);
    } else if (consumer === 'oracle-diagnosis-threads') {
        keys(p.thread, 'id,title,autoTitle,createdAt,updatedAt,messages');
        str(p.thread.id, 128, false);
        str(p.thread.title, 60, false);
        bool(p.thread.autoTitle);
        int(p.thread.createdAt);
        int(p.thread.updatedAt);
        array(p.thread.messages, 80, m => {
            if (!obj(m) || Object.keys(m).some(k => !['id', 'role', 'content', 'prompt', 'failed', 'meta', 'diagnosis'].includes(k))) bad();
            str(m.id, 256, false);
            one(m.role, ['user', 'assistant']);
            str(m.content, 200000);
            if (m.prompt !== undefined) bool(m.prompt);
            if (m.failed !== undefined) bool(m.failed);
            if (m.meta !== undefined) str(m.meta, 2000);
            if (m.diagnosis !== undefined) {
                if (m.role !== 'assistant') bad();
                keys(m.diagnosis, 'applyState');
                one(m.diagnosis.applyState, ['ready', 'pending', 'applied', 'nochange', 'undone']);
            }
        });
        unique(p.thread.messages, 'id');
    } else {
        keys(p.selection, 'use,hybrid,targetBook,selected');
        bool(p.selection.use);
        bool(p.selection.hybrid);
        str(p.selection.targetBook, 512);
        if (!obj(p.selection.selected) || Object.keys(p.selection.selected).length > 128) bad();
        let count = 0;
        for (const [book, ids] of Object.entries(p.selection.selected)) {
            str(book, 512, false);
            array(ids, 4096, x => int(x));
            unique(ids);
            count += ids.length;
        }
        if (count > 8192) bad();
    }
    return p;
}

export const diagnosisRecordConsumers = Object.freeze([
    Object.freeze({
        id: 'oracle-diagnosis-thread-index',
        schemaVersion: 1,
        maxBytes: 64 * 1024,
        maxRecords: 4000,
        maxStorageBytes: 32 * 1024 * 1024,
        deletable: false,
        validate: p => validateDiagnosisRecord('oracle-diagnosis-thread-index', p),
    }),
    Object.freeze({
        id: 'oracle-diagnosis-threads',
        schemaVersion: 1,
        maxBytes: 2 * 1024 * 1024,
        maxRecords: 10000,
        maxStorageBytes: 160 * 1024 * 1024,
        deletable: true,
        validate: p => validateDiagnosisRecord('oracle-diagnosis-threads', p),
    }),
    Object.freeze({
        id: 'oracle-diagnosis-lore-selection',
        schemaVersion: 1,
        maxBytes: 256 * 1024,
        maxRecords: 4000,
        maxStorageBytes: 32 * 1024 * 1024,
        deletable: false,
        validate: p => validateDiagnosisRecord('oracle-diagnosis-lore-selection', p),
    }),
]);
