import { randomUUID } from 'node:crypto';
export class WorldbookFailure extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}
export const fail = (code) => {
    throw new WorldbookFailure(code);
};
export const LIMITS = Object.freeze({
    pageSize: 20,
    treePageSize: 50,
    summaryPageSize: 32,
    sourcePageSize: 50,
    maxColumns: 128,
    maxFolders: 10000,
    maxMaterials: 50000,
    maxSources: 256,
    maxDepth: 16,
    maxImportItems: 100,
    maxTags: 16,
    maxName: 80,
    maxType: 60,
    maxTag: 32,
    maxSummary: 160,
    maxDescription: 20000,
    maxQuery: 160,
    maxBodyBytes: 262144,
    maxResponseBytes: 131072,
    runtimeBatchSize: 100,
    maxRuntimeBindings: 8192,
    maxObservedBindings: 65536,
    runtimeTtlMs: 60000,
    commandTtlMs: 7 * 86400000,
    maxCommandReceipts: 16384,
});
export const BUILTINS = Object.freeze([
    {
        id: 'xp-worldbook',
        title: '性爱指导',
        description: '道具与指导条目控制',
        icon: { type: 'builtin', value: 'wand' },
        accent: '#ff453a',
        order: 10,
    },
    {
        id: 'fate-worldbook',
        title: '命运编织',
        description: '角色与命运条目控制',
        icon: { type: 'builtin', value: 'sparkles' },
        accent: '#bf5af2',
        order: 20,
    },
]);
export const newId = (kind) => `${kind}-${randomUUID()}`;
export const folded = (value) =>
    String(value ?? '')
        .trim()
        .toLocaleLowerCase('zh-CN');
export function id(value) {
    if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,95}$/.test(value)) fail('WORLDBOOK_VALIDATION');
    return value;
}
export function integer(value, min = 0, max = Number.MAX_SAFE_INTEGER - 1) {
    if (!Number.isSafeInteger(value) || value < min || value > max) fail('WORLDBOOK_VALIDATION');
    return value;
}
export function text(value, max, required = false) {
    if (
        typeof value !== 'string' ||
        value.length > max ||
        value.includes('\0') ||
        /[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) ||
        (required && !value.trim())
    )
        fail('WORLDBOOK_VALIDATION');
    return value;
}
export function object(value, allowed, required = []) {
    if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.keys(value).some((k) => !allowed.includes(k)) ||
        required.some((k) => !Object.hasOwn(value, k))
    )
        fail('WORLDBOOK_VALIDATION');
    return value;
}
export function tags(value) {
    if (!Array.isArray(value) || value.length > LIMITS.maxTags || new Set(value).size !== value.length)
        fail('WORLDBOOK_VALIDATION');
    return value.map((t) => text(t, LIMITS.maxTag, true));
}
export function source(value) {
    object(value, ['locator', 'uid', 'title'], ['locator', 'uid', 'title']);
    return { locator: text(value.locator, 240, true), uid: integer(value.uid), title: text(value.title, 200, true) };
}
export function metadata(value, partial = false) {
    const keys = ['name', 'materialType', 'summary', 'description', 'tags', 'favorite'];
    // Existing Materials change sources only through Binding CAS. Creation still
    // requires an explicit source, independently of metadata edits.
    object(value, partial ? keys : [...keys, 'source'], partial ? [] : ['name', 'source']);
    const result = partial ? {} : { materialType: '', summary: '', description: '', tags: [], favorite: false };
    for (const [key, val] of Object.entries(value)) {
        if (key === 'source') result.source = source(val);
        else if (key === 'tags') result.tags = tags(val);
        else if (key === 'favorite') {
            if (typeof val !== 'boolean') fail('WORLDBOOK_VALIDATION');
            result.favorite = val;
        } else
            result[key] = text(
                val,
                {
                    name: LIMITS.maxName,
                    materialType: LIMITS.maxType,
                    summary: LIMITS.maxSummary,
                    description: LIMITS.maxDescription,
                }[key],
                key === 'name',
            );
    }
    if (partial && !Object.keys(result).length) fail('WORLDBOOK_VALIDATION');
    return result;
}
export function appearance(value) {
    object(value, ['title', 'description', 'icon', 'accent', 'order'], ['title', 'description', 'icon', 'accent']);
    text(value.title, 80, true);
    text(value.description, 160);
    integer(value.order ?? 100, 0, 1000000000);
    object(value.icon, ['type', 'value'], ['type', 'value']);
    if (!['text', 'builtin'].includes(value.icon.type)) fail('WORLDBOOK_VALIDATION');
    text(value.icon.value, 32, true);
    if (!/^#[a-fA-F0-9]{6}$/.test(value.accent)) fail('WORLDBOOK_VALIDATION');
    return { ...value, order: value.order ?? 100 };
}
export function page(value = '1') {
    if (typeof value !== 'string' || !/^[1-9]\d{0,6}$/.test(value)) fail('WORLDBOOK_VALIDATION');
    return integer(Number(value), 1, 1000000);
}
export function query(value = {}) {
    object(value, ['columnId', 'q', 'type', 'tags', 'favorite', 'page', 'runtimeToken', 'sourceId', 'uid', 'status', 'sort']);
    const result = {
        columnId: value.columnId ? id(value.columnId) : '',
        q: folded(text(value.q ?? '', LIMITS.maxQuery)),
        type: folded(text(value.type ?? '', LIMITS.maxType)),
        page: page(value.page),
        tags: [],
    };
    if (value.tags) {
        try {
            result.tags = tags(JSON.parse(value.tags)).map(folded);
        } catch {
            fail('WORLDBOOK_VALIDATION');
        }
    }
    if (value.favorite !== undefined && !['true', 'false'].includes(value.favorite)) fail('WORLDBOOK_VALIDATION');
    result.favorite = value.favorite === 'true';
    if (value.status !== undefined && !['all','enabled','disabled','detached','unknown'].includes(value.status)) fail('WORLDBOOK_VALIDATION');
    if (value.sort !== undefined && !['default','recent','frequent'].includes(value.sort)) fail('WORLDBOOK_VALIDATION');
    if (value.status) result.status = value.status;
    if (value.sort) result.sort = value.sort;
    if (value.runtimeToken) result.runtimeToken = id(value.runtimeToken);
    if (value.uid !== undefined && !value.sourceId) fail('WORLDBOOK_VALIDATION');
    if (value.sourceId) {
        result.sourceId = id(value.sourceId);
        if (!/^\d{1,16}$/.test(value.uid ?? '')) fail('WORLDBOOK_VALIDATION');
        result.uid = integer(Number(value.uid));
    }
    return result;
}
export function commandToken(token, now) {
    if (typeof token !== 'string' || !/^\d{13}-[a-f0-9-]{36}$/.test(token)) fail('WORLDBOOK_VALIDATION');
    const time = Number(token.slice(0, 13));
    if (time > now + 300000) fail('WORLDBOOK_CLOCK_SKEW');
    if (now - time > LIMITS.commandTtlMs) fail('WORLDBOOK_COMMAND_EXPIRED');
    return time;
}
export const canonical = (value) =>
    value && typeof value === 'object'
        ? Array.isArray(value)
            ? value.map(canonical)
            : Object.fromEntries(
                  Object.keys(value)
                      .sort()
                      .map((k) => [k, canonical(value[k])]),
              )
        : value;
