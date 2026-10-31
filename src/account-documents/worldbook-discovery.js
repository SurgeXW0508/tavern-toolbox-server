import { DocumentFailure } from './validation.js';

export const DISCOVERY_LIMITS = Object.freeze({ maxSettingsBytes: 256 * 1024, maxLibraryBytes: 2 * 1024 * 1024,
    maxSchemeBytes: 512 * 1024, maxSchemes: 128, maxBlocks: 107, maxContentChars: 30000,
    maxBooks: 128, maxEntriesPerBook: 512, maxSelections: 4096 });
export const DISCOVERY_SETTING_FIELDS = 'promptId,connectionId,count,contextBudget,historyDepth,extractRules,excludeRules,includeStorySummary,includeMvu,includeWorldbook,worldbookMode,worldbookSelections'.split(',');
const plain = v => v && typeof v === 'object' && !Array.isArray(v);
const keys = (v, names) => plain(v) && Object.keys(v).sort().join(',') === [...names].sort().join(',');
const text = (v, max, empty = false) => typeof v === 'string' && v === v.trim() && v.length <= max && (empty || v.length > 0);
const id = v => text(v, 128) && /^[a-zA-Z0-9:_-]+$/.test(v);
const integer = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const bytes = v => new TextEncoder().encode(JSON.stringify(v)).byteLength;
const invalid = () => { throw new DocumentFailure('DOCUMENT_INVALID'); };
const bounded = (v, max) => { if (bytes(v) > max) throw new DocumentFailure('DOCUMENT_TOO_LARGE'); };

export function validateDiscoverySettings(p) {
    if (!keys(p, DISCOVERY_SETTING_FIELDS) || !id(p.promptId) || !(p.connectionId === '' || id(p.connectionId))
        || !integer(p.count, 1, 100) || !integer(p.historyDepth, 1, 100) || !integer(p.contextBudget, 4096, 1048576)
        || !['includeStorySummary', 'includeMvu', 'includeWorldbook'].every(k => typeof p[k] === 'boolean')
        || !['matched', 'enabled', 'selected'].includes(p.worldbookMode)) invalid();
    for (const rules of [p.extractRules, p.excludeRules]) {
        if (!Array.isArray(rules) || rules.length > 40 || rules.some(r => !keys(r, ['start', 'end']) || !text(r.start, 200) || !text(r.end, 200))) invalid();
    }
    if (!plain(p.worldbookSelections) || Object.keys(p.worldbookSelections).length > DISCOVERY_LIMITS.maxBooks) invalid();
    let total = 0;
    for (const [book, entries] of Object.entries(p.worldbookSelections)) {
        if (!text(book, 512) || !Array.isArray(entries) || !entries.length || entries.length > DISCOVERY_LIMITS.maxEntriesPerBook
            || entries.some(uid => !text(uid, 128)) || new Set(entries).size !== entries.length) invalid();
        total += entries.length;
    }
    if (total > DISCOVERY_LIMITS.maxSelections) invalid();
    bounded(p, DISCOVERY_LIMITS.maxSettingsBytes); return p;
}

const systemRoles = { principles: 'system', worldbook: 'system', summary: 'system', history: 'history', mvu: 'system', candidates: 'system', request: 'user_input' };
export function validateDiscoveryPrompts(p) {
    if (!keys(p, ['schemes']) || !Array.isArray(p.schemes) || p.schemes.length > DISCOVERY_LIMITS.maxSchemes) invalid();
    const ids = new Set(['balanced']);
    for (const s of p.schemes) {
        if (!keys(s, ['id', 'name', 'description', 'prompt', 'blocks', 'schemaVersion', 'createdAt', 'updatedAt', 'factory'])
            || !id(s.id) || ids.has(s.id) || !text(s.name, 80) || !text(s.description, 180, true) || s.factory !== false
            || s.schemaVersion !== 2 || !integer(s.createdAt, 0, Number.MAX_SAFE_INTEGER) || !integer(s.updatedAt, 0, Number.MAX_SAFE_INTEGER)
            || !text(s.prompt, DISCOVERY_LIMITS.maxContentChars) || !Array.isArray(s.blocks) || s.blocks.length > DISCOVERY_LIMITS.maxBlocks) invalid();
        ids.add(s.id);
        const blockIds = new Set(), types = new Set();
        for (const b of s.blocks) {
            const custom = b?.type === 'custom', principles = b?.type === 'principles';
            if (!keys(b, custom || principles ? ['id', 'type', 'name', 'role', 'content'] : ['id', 'type', 'name', 'role'])
                || !id(b.id) || blockIds.has(b.id) || !text(b.name, 80, custom)) invalid();
            blockIds.add(b.id);
            if (custom) {
                if (Object.hasOwn(systemRoles, b.id) || !['system', 'assistant', 'user'].includes(b.role) || !text(b.content, DISCOVERY_LIMITS.maxContentChars)) invalid();
            } else {
                if (!Object.hasOwn(systemRoles, b.type) || types.has(b.type) || b.id !== b.type || b.role !== systemRoles[b.type]) invalid();
                types.add(b.type);
                if (principles && (b.content !== s.prompt || !text(b.content, DISCOVERY_LIMITS.maxContentChars))) invalid();
            }
        }
        if (types.size !== Object.keys(systemRoles).length) invalid();
        bounded(s, DISCOVERY_LIMITS.maxSchemeBytes);
    }
    bounded(p, DISCOVERY_LIMITS.maxLibraryBytes); return p;
}

export const discoverySettingsConsumer = Object.freeze({ id: 'worldbook-discovery-settings', schemaVersion: 1,
    maxBytes: DISCOVERY_LIMITS.maxSettingsBytes, limits: DISCOVERY_LIMITS, validate: validateDiscoverySettings });
export const discoveryPromptsConsumer = Object.freeze({ id: 'worldbook-discovery-prompts', schemaVersion: 1,
    maxBytes: DISCOVERY_LIMITS.maxLibraryBytes, limits: DISCOVERY_LIMITS, validate: validateDiscoveryPrompts });
