import { BusinessFailure } from './store.js';

export const OUTFIT_NAMESPACE = 'outfit';
export const OUTFIT_BUSINESS_SCHEMA = 1;
export const emptyOutfit = () => ({ assets: [], persons: [], wearStates: [] });
const ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const kinds = new Set(['wardrobe', 'outfit', 'kit', 'item']);
const scopes = new Set(['global', 'persona', 'character', 'chat']);
const modes = new Set(['fixed', 'scene']);
const fields = {
    wardrobe: ['outfitIds', 'note'],
    outfit: ['kitIds', 'defaultKitId', 'note'],
    kit: ['itemIds', 'contextMode', 'overallEffect', 'relationNote', 'summaryDescription', 'note'],
    item: ['itemType', 'wearSlot', 'modelDescription'],
};

function invalid() { throw new BusinessFailure('BUSINESS_DATA_INVALID'); }
function object(value, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
function str(value, max = 2048, nonempty = false) {
    if (typeof value !== 'string' || value.length > max || nonempty && !value.trim()) invalid();
}
function id(value) { str(value, 128, true); if (!ID.test(value)) invalid(); }
function hostKey(value) { str(value, 256, true); if (/[\u0000-\u001f\u007f]/.test(value)) invalid(); }
function list(value, max = 5000) {
    if (!Array.isArray(value) || value.length > max) invalid();
    value.forEach(id);
    if (new Set(value).size !== value.length) invalid();
}
function textList(value) {
    if (!Array.isArray(value) || value.length > 32) invalid();
    value.forEach(item => str(item, 120));
}
function mediaRef(value) {
    if (value === null) return;
    object(value, ['provider', 'assetId']);
    if (value.provider !== 'server' || !ASSET_ID.test(value.assetId || '')) invalid();
}
function scope(value) {
    object(value, ['type', 'id', 'label']);
    if (!scopes.has(value.type)) invalid();
    str(value.id, 256); str(value.label, 512);
    if (value.type === 'global' ? value.id !== '' : !value.id) invalid();
}
function asset(value) {
    object(value, ['id', 'kind', 'name', 'category', 'tags', 'sceneTags', 'ownerPersonId',
        'scope', 'mediaRef', 'createdAt', 'updatedAt', ...Object.values(fields).flat()]);
    id(value.id);
    if (!kinds.has(value.kind)) invalid();
    str(value.name, 120, true); str(value.category, 120);
    textList(value.tags); textList(value.sceneTags);
    str(value.ownerPersonId, 128); if (value.ownerPersonId) id(value.ownerPersonId);
    scope(value.scope); mediaRef(value.mediaRef);
    str(value.createdAt, 64, true); str(value.updatedAt, 64, true);
    for (const [kind, specific] of Object.entries(fields)) {
        for (const name of specific) if (kind !== value.kind && name in value &&
            !Object.entries(fields).some(([other, names]) => other === value.kind && names.includes(name))) invalid();
    }
    if (value.kind === 'wardrobe') { list(value.outfitIds); str(value.note); }
    if (value.kind === 'outfit') { list(value.kitIds); str(value.defaultKitId, 128); str(value.note); }
    if (value.kind === 'kit') {
        list(value.itemIds);
        if (!['itemized', 'summary', 'legacy-mixed'].includes(value.contextMode)) invalid();
        ['overallEffect', 'relationNote', 'summaryDescription', 'note'].forEach(key => str(value[key]));
    }
    if (value.kind === 'item') {
        str(value.itemType, 64, true); str(value.wearSlot, 64, true); str(value.modelDescription);
    }
}
function person(value) {
    object(value, ['id', 'name', 'createdAt', 'updatedAt']);
    id(value.id); str(value.name, 120, true);
    str(value.createdAt, 64, true); str(value.updatedAt, 64, true);
}
function wear(value) {
    object(value, ['chatId', 'personId', 'mode', 'outfitId', 'kitId', 'wardrobeIds',
        'extraItemIds', 'removedItemIds', 'perspectiveRole', 'updatedAt']);
    hostKey(value.chatId); id(value.personId);
    if (!modes.has(value.mode)) invalid();
    for (const key of ['outfitId', 'kitId']) { str(value[key], 128); if (value[key]) id(value[key]); }
    ['wardrobeIds', 'extraItemIds', 'removedItemIds'].forEach(key => list(value[key]));
    if (!['ordinary', 'player-protagonist'].includes(value.perspectiveRole)) invalid();
    str(value.updatedAt, 64, true);
}
function compatibleScope(container, member) {
    return member.type === 'global' || container.type === member.type && container.id === member.id;
}

export function validateOutfit(document) {
    object(document, ['assets', 'persons', 'wearStates']);
    if (!Array.isArray(document.assets) || document.assets.length > 5000
        || !Array.isArray(document.persons) || document.persons.length > 1000
        || !Array.isArray(document.wearStates) || document.wearStates.length > 10000) invalid();
    document.assets.forEach(asset); document.persons.forEach(person); document.wearStates.forEach(wear);
    const assets = new Map(document.assets.map(item => [item.id, item]));
    const persons = new Set(document.persons.map(item => item.id));
    if (assets.size !== document.assets.length || persons.size !== document.persons.length) invalid();
    const reference = (parent, childId, kind) => {
        const child = assets.get(childId);
        if (!child || child.kind !== kind || !compatibleScope(parent.scope, child.scope)
            || child.ownerPersonId && child.ownerPersonId !== parent.ownerPersonId) invalid();
    };
    for (const item of document.assets) {
        if (item.ownerPersonId && !persons.has(item.ownerPersonId)) invalid();
        if (item.kind === 'wardrobe') item.outfitIds.forEach(child => reference(item, child, 'outfit'));
        if (item.kind === 'outfit') {
            item.kitIds.forEach(child => reference(item, child, 'kit'));
            if (item.defaultKitId && !item.kitIds.includes(item.defaultKitId)) invalid();
        }
        if (item.kind === 'kit') item.itemIds.forEach(child => reference(item, child, 'item'));
    }
    const wears = new Set();
    for (const item of document.wearStates) {
        if (!persons.has(item.personId)) invalid();
        const key = `${item.chatId}::${item.personId}`;
        if (wears.has(key)) invalid();
        wears.add(key);
        const check = (assetId, kind) => {
            const target = assets.get(assetId);
            if (!target || target.kind !== kind || target.scope.type === 'chat' && target.scope.id !== item.chatId
                || target.ownerPersonId && target.ownerPersonId !== item.personId) invalid();
            return target;
        };
        if (item.outfitId) {
            const outfit = check(item.outfitId, 'outfit');
            if (item.kitId && (!outfit.kitIds.includes(item.kitId) || check(item.kitId, 'kit').id !== item.kitId)) invalid();
        } else if (item.kitId) invalid();
        item.wardrobeIds.forEach(value => check(value, 'wardrobe'));
        [...item.extraItemIds, ...item.removedItemIds].forEach(value => check(value, 'item'));
    }
    return document;
}

export function addedMediaRefs(document, previous) {
    const old = new Map((previous?.assets || []).map(item => [item.id, item.mediaRef?.assetId || null]));
    return [...new Set(document.assets.filter(item => item.mediaRef?.assetId
        && old.get(item.id) !== item.mediaRef.assetId).map(item => item.mediaRef.assetId))];
}

// Consumer-owned adapter: Governance sees only groups and media slots.
export function outfitReferenceGroups(snapshot) {
    return snapshot.document.assets.filter(asset => asset.mediaRef).map(asset => ({
        id: asset.id, label: asset.name, lifecycle: 'active', revision: snapshot.revision,
        description: [asset.kind, asset.scope.label].filter(Boolean).join(' · '), actions: [],
        references: [{ id: 'image', label: '图片', mediaRef: asset.mediaRef, actions: ['replace', 'unlink'] }],
    }));
}
