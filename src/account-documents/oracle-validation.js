import { DocumentFailure } from './validation.js';

export const bad = () => { throw new DocumentFailure('DOCUMENT_INVALID'); };
export const obj = v => v && typeof v === 'object' && !Array.isArray(v);
export const keys = (v, names) => { if (!obj(v) || Object.keys(v).sort().join(',') !== names.split(',').sort().join(',')) bad(); };
export const str = (v, max, empty = true) => { if (typeof v !== 'string' || v.length > max || !empty && !v.trim() || v.includes('\0')) bad(); };
export const int = (v, min = 0, max = Number.MAX_SAFE_INTEGER) => { if (!Number.isSafeInteger(v) || v < min || v > max) bad(); };
export const bool = v => { if (typeof v !== 'boolean') bad(); };
export const one = (v, values) => { if (!values.includes(v)) bad(); };
export const array = (v, max, check) => { if (!Array.isArray(v) || v.length > max) bad(); v.forEach(check); };
export const unique = (v, field = null) => { if (new Set(v.map(x => field ? x[field] : x)).size !== v.length) bad(); };
export const nullable = (v, fn) => { if (v !== null) fn(v); };

export function validateCloudConnectionId(connectionId) {
    str(connectionId, 300);
    if (connectionId && !/^cloud:[A-Za-z0-9_-]{1,96}$/.test(connectionId)) bad();
}

export function validateOracleIdentity(v) {
    keys(v, 'kind,owner,chat');
    one(v.kind, ['character', 'group']);
    str(v.owner, 512, false);
    str(v.chat, 512, false);
}

export function validateOracleRecipe(v, { sources, protectedSources, requiredSources = protectedSources, validateOptions }) {
    keys(v, 'version,nodes');
    if (v.version !== 1) bad();
    array(v.nodes, 128, n => {
        str(n?.id, 128, false);
        str(n.title, 200, false);
        bool(n.enabled);
        one(n.role, ['system', 'user', 'assistant', 'preserve']);
        if (n.type === 'text') {
            keys(n, 'id,type,title,role,enabled,content');
            str(n.content, 60000);
            if (n.role === 'preserve') bad();
        } else {
            keys(n, 'id,type,title,role,enabled,source,options');
            one(n.type, ['source', 'protected']);
            one(n.source, sources);
            if (protectedSources.includes(n.source) && (n.type !== 'protected' || n.enabled !== true)) bad();
            validateOptions(n.source, n.options);
        }
    });
    unique(v.nodes, 'id');
    for (const source of requiredSources) {
        if (v.nodes.filter(n => n.source === source).length !== 1) bad();
    }
}

export function validatePromptProfiles(v, { payloadKeys = 'recipe', validatePayload }) {
    keys(v, 'version,activeId,items');
    if (v.version !== 1) bad();
    str(v.promptProfiles ? v.promptProfiles.activeId : v.activeId, 128, false);
    array(v.items, 100, p => {
        keys(p, 'id,name,payload');
        str(p.id, 128, false);
        if (p.id === 'official') bad();
        str(p.name, 80, false);
        keys(p.payload, payloadKeys);
        validatePayload(p.payload);
    });
    unique(v.items, 'id');
    if (v.activeId !== 'official' && !v.items.some(p => p.id === v.activeId)) bad();
}

export function validateThreadIndexEntries(threads, maxThreads = 50) {
    array(threads, maxThreads, t => {
        keys(t, 'id,title,autoTitle,createdAt,updatedAt,messageCount');
        str(t.id, 128, false);
        str(t.title, 60, false);
        bool(t.autoTitle);
        int(t.createdAt);
        int(t.updatedAt);
        int(t.messageCount);
    });
    unique(threads, 'id');
}
