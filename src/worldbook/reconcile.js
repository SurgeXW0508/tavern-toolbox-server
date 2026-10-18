import { createHash } from 'node:crypto';
import { fail, id, integer, object, text, metadata, newId, LIMITS } from './validation.js';

export const RECONCILE_COMMANDS = new Set(['column-import', 'source-migrate']);
export const RECONCILE_READS = new Set(['column-sources', 'import-context', 'source-impact']);

// Explicit maintenance only; tokens bind a confirmation to current business
// evidence without storing a second copy of folder graphs or Source bindings.
function digest(s, sql, args = []) {
    const hash = createHash('sha256');
    for (const row of s.db.prepare(sql).iterate(...args)) hash.update(JSON.stringify(row));
    return hash.digest('hex');
}
export function folderToken(s, columnId) {
    return digest(s, 'SELECT id,parent_id,name,position FROM folders WHERE column_id=? ORDER BY id', [columnId]);
}
function impact(s, sourceId, columnId) {
    s.column(id(columnId)); id(sourceId);
    if (!s.one('SELECT 1 FROM materials WHERE column_id=? AND source_id=?', columnId, sourceId)) fail('WORLDBOOK_NOT_FOUND');
    const source = s.one('SELECT id,locator,revision FROM sources WHERE id=?', sourceId);
    const columns = s.all('SELECT c.id,c.title,COUNT(*) count FROM materials m JOIN columns c ON c.id=m.column_id WHERE m.source_id=? GROUP BY c.id ORDER BY c.id', sourceId);
    const token = digest(s, 'SELECT m.id,m.column_id,m.entry_uid,b.revision FROM materials m JOIN wb_bindings b ON b.material_id=m.id WHERE m.source_id=? ORDER BY m.id', [sourceId]);
    return { source, columns, total: columns.reduce((n, row) => n + row.count, 0), impactToken: token };
}
export function readReconcile(s, input) {
    const { kind, columnId } = input;
    object(input, ['kind', 'columnId', ...(kind === 'source-impact' ? ['sourceId'] : ['after']), ...(kind === 'import-context' ? ['locator'] : [])], ['kind', 'columnId']);
    const column = s.columnView(s.column(id(columnId)));
    if (kind === 'source-impact') return impact(s, input.sourceId, columnId);
    if (input.after) id(input.after);
    if (kind === 'column-sources') {
        const rows = s.all('SELECT s.id,s.locator,s.revision,COUNT(*) count FROM sources s JOIN materials m ON m.source_id=s.id WHERE m.column_id=? AND s.id>? GROUP BY s.id ORDER BY s.id LIMIT 51', columnId, input.after || '');
        return { items: rows.slice(0, 50), nextCursor: rows.length > 50 ? rows[49].id : null };
    }
    const rows = s.all('SELECT id,parent_id parentId,name FROM folders WHERE column_id=? AND id>? ORDER BY id LIMIT 51', columnId, input.after || '');
    if(input.locator !== undefined) text(input.locator, 240, true);
    const same = input.locator ? s.all('SELECT id FROM folders WHERE column_id=? AND parent_id IS NULL AND name=? LIMIT 2', columnId, input.locator.slice(0,80)) : [];
    return { column, folderToken: folderToken(s, columnId), sourceFolderId: same.length === 1 ? same[0].id : null, items: rows.slice(0, 50), nextCursor: rows.length > 50 ? rows[49].id : null };
}
export function mutateReconcile(s, action, data) {
    if (action === 'source-migrate') {
        object(data, ['columnId', 'id', 'revision', 'locator', 'impactToken'], ['columnId', 'id', 'revision', 'locator', 'impactToken']);
        const current = impact(s, data.id, data.columnId);
        if (current.impactToken !== data.impactToken) fail('WORLDBOOK_CONFLICT');
        return s.features.rebindSource({ id: data.id, revision: data.revision, locator: data.locator }, { singleColumnOnly: false });
    }
    object(data, ['columnId', 'structureRevision', 'folderToken', 'destination', 'locator', 'entries', 'expectedSource'], ['columnId', 'structureRevision', 'folderToken', 'destination', 'locator', 'entries']);
    const column = s.column(id(data.columnId)); integer(data.structureRevision);
    text(data.locator, 240, true); text(data.folderToken, 64, true);
    if(data.expectedSource) {
        object(data.expectedSource, ['id','revision'], ['id','revision']);id(data.expectedSource.id);integer(data.expectedSource.revision);
        const current=s.one('SELECT id,revision FROM sources WHERE locator=?',data.locator);
        if(!current||current.id!==data.expectedSource.id||current.revision!==data.expectedSource.revision)fail('WORLDBOOK_CONFLICT');
    }
    // Concurrent material appends can advance structureRevision. Permit them
    // only while the confirmed folder graph stays identical, then recheck UIDs.
    if (folderToken(s, column.id) !== data.folderToken) fail('WORLDBOOK_TREE_CHANGED');
    if (data.structureRevision > column.structure_revision) fail('WORLDBOOK_CONFLICT');
    object(data.destination, ['parentId', 'newFolderName']);
    if (data.destination.parentId && data.destination.newFolderName) fail('WORLDBOOK_VALIDATION');
    let parentId = data.destination.parentId ?? null;
    s.parent(column.id, parentId);
    if (data.destination.newFolderName !== undefined) text(data.destination.newFolderName, 80, true);
    if (!Array.isArray(data.entries) || !data.entries.length || data.entries.length > LIMITS.maxImportItems) fail('WORLDBOOK_VALIDATION');
    const seen = new Set(), additions = []; let existing = 0;
    for (const entry of data.entries) {
        object(entry, ['uid', 'title'], ['uid', 'title']); integer(entry.uid); text(entry.title, 200, true);
        if (seen.has(entry.uid)) fail('WORLDBOOK_VALIDATION'); seen.add(entry.uid);
        const found = s.one('SELECT 1 FROM materials m JOIN sources s ON s.id=m.source_id WHERE m.column_id=? AND s.locator=? AND m.entry_uid=?', column.id, data.locator, entry.uid);
        if (found) existing++;
        else additions.push(metadata({ name: entry.title.slice(0, 80), source: { locator: data.locator, uid: entry.uid, title: entry.title } }));
    }
    if (additions.length && data.destination.newFolderName !== undefined) {
        s.capacity('folders', LIMITS.maxFolders); parentId = newId('folder');
        s.run('INSERT INTO folders VALUES(?,?,NULL,?,?,1)', parentId, column.id, data.destination.newFolderName, s.position(column.id, null));
    }
    if (additions.length) {
        const position = s.position(column.id, parentId);
        additions.forEach((row, index) => s.insertMaterial(column.id, parentId, row, position + index));
        s.bump(column.id, true);
    }
    return { columnId: column.id, added: additions.length, existing, parentId, folderToken: folderToken(s, column.id) };
}
