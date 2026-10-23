import { newId, object, id, integer, fail, LIMITS } from './validation.js';
import { featureScope } from './feature-queries.js';

// Folder is an explicit Candidate-only scope. Other Feature readers continue
// validating their own scope and must reject this key instead of ignoring it.
function candidateScope(value = {}) {
    if (value && Object.hasOwn(value, 'folderId')) {
        object(value, ['columnId', 'folderId'], ['columnId', 'folderId']);
        return { ...featureScope({columnId:id(value.columnId)}), folderId:id(value.folderId) };
    }
    return featureScope(value);
}
function folderScope(store, scope) {
    if (!scope.folderId) return null;
    const column = store.column(scope.columnId);
    const folder = store.one('SELECT id,column_id FROM folders WHERE id=?', scope.folderId);
    if (!folder) fail('WORLDBOOK_NOT_FOUND');
    if (folder.column_id !== scope.columnId) fail('WORLDBOOK_VALIDATION');
    const path = store.all('WITH RECURSIVE ancestors AS(SELECT id,parent_id,name,1 depth FROM folders WHERE id=? UNION ALL SELECT f.id,f.parent_id,f.name,a.depth+1 FROM folders f JOIN ancestors a ON a.parent_id=f.id WHERE a.depth<16) SELECT name FROM ancestors ORDER BY depth DESC',folder.id).map(row=>row.name);
    return {columnId:scope.columnId,folderId:folder.id,treeRevision:column.tree_revision,path};
}
function checkFolderScope(store, scope) {
    if (!scope) return;
    const column = store.one('SELECT tree_revision FROM columns WHERE id=?',scope.columnId);
    const folder = store.one('SELECT column_id FROM folders WHERE id=?',scope.folderId);
    if (!column || column.tree_revision !== scope.treeRevision || folder?.column_id !== scope.columnId)
        fail('WORLDBOOK_TREE_CHANGED');
}

// A selection cursor retains a seed and one bounded response, not an ID pool.
export class WorldbookCandidateSessions {
    constructor(now = () => Date.now()) {
        this.now = now;
        this.sessions = new Map();
    }
    clear() {
        this.sessions.clear();
    }
    read(context, store, input, runtime) {
        object(input, ['kind', 'scope', 'runtimeToken', 'sessionId', 'cursor', 'limit']);
        for (const [key, value] of this.sessions)
            if (value.expiresAt <= this.now()) this.sessions.delete(key);
        if (input.kind === 'session-end') {
            object(input,['kind','sessionId','runtimeToken'],['sessionId']);
            const session = this.sessions.get(id(input.sessionId));
            if (session?.userRoot === context.userRoot && session.contextId === context.contextId)
                this.sessions.delete(input.sessionId);
            return { ended: true };
        }
        if (!['roll', 'discovery'].includes(input.kind) || !runtime?.observed || runtime.unknownBooks.length)
            fail('WORLDBOOK_RUNTIME_UNAVAILABLE');
        let session = input.sessionId ? this.sessions.get(id(input.sessionId)) : null;
        if (
            input.sessionId &&
            (!session ||
                session.userRoot !== context.userRoot ||
                session.contextId !== context.contextId ||
                session.kind !== input.kind)
        )
            fail('WORLDBOOK_SESSION_EXPIRED');
        const scope = input.scope !== undefined ? candidateScope(input.scope) : null;
        if (session && scope && JSON.stringify(scope) !== JSON.stringify(session.scope))
            fail('WORLDBOOK_VALIDATION');
        if (!session) {
            const owned = [...this.sessions.values()].filter((row) => row.userRoot === context.userRoot);
            if (owned.length >= 4 || this.sessions.size >= 16) fail('RESOURCE_BUSY');
            session = {
                id: newId('selection'),
                seed: newId('seed').replaceAll('-', '').slice(4),
                kind: input.kind,
                scope: scope ?? candidateScope(),
                folderScope: folderScope(store, scope ?? {}),
                userRoot: context.userRoot,
                contextId: context.contextId,
                cursor: 0,
                lastCursor: -1,
                afterRank: null,
                afterSource: null,
                afterUid: null,
                seen: 0,
                expiresAt: this.now() + 15 * 60000,
            };
            this.sessions.set(session.id, session);
        }
        // Validate even a cached cursor replay. Keep the invalid session until
        // TTL/end so it can never silently restart under a changed tree.
        checkFolderScope(store,session.folderScope);
        const cursor = integer(input.cursor ?? 0),
            limit = integer(input.limit ?? (input.kind === 'roll' ? 3 : 20), 1, 20);
        if (cursor === session.lastCursor) return session.response;
        if (cursor !== session.cursor) fail('WORLDBOOK_SESSION_EXPIRED');
        const result = store.catalog(
            {
                ...session.scope,
                includeMedia: input.kind !== 'discovery',
                status: 'disabled',
                empty: ['enabled', 'detached', 'unknown'].includes(session.scope.status),
                grouping: true,
                seed: session.seed,
                afterRank: session.afterRank,
                afterSource: session.afterSource,
                afterUid: session.afterUid,
                limit,
                page: 1,
            },
            runtime,
        );
        for (const item of result.items)
            item.folderPath = store
                .all(
                    'WITH RECURSIVE ancestors AS(SELECT f.id,f.parent_id,f.name,1 depth FROM folders f JOIN materials m ON m.parent_id=f.id WHERE m.id=? UNION ALL SELECT f.id,f.parent_id,f.name,a.depth+1 FROM folders f JOIN ancestors a ON a.parent_id=f.id WHERE a.depth<16) SELECT name FROM ancestors ORDER BY depth DESC',
                    item.id,
                )
                .map((row) => row.name);
        while (
            result.items.length > 1 &&
            Buffer.byteLength(JSON.stringify(result)) > LIMITS.maxResponseBytes - 8192
        )
            result.items.pop();
        const last = result.items.at(-1),
            returned = result.items.length;
        session.scopeTotal ??= result.total;
        session.seen += returned;
        session.lastCursor = cursor;
        session.cursor++;
        if (last) {
            session.afterRank = last.rank;
            session.afterSource = last.source.sourceId;
            session.afterUid = last.source.uid;
        }
        const remaining = Math.max(0, result.remaining - returned);
        const columnIds = new Set(result.items.map((row) => row.columnId));
        session.response = {
            ...result,
            ...(session.folderScope ? {folderScope:session.folderScope} : {}),
            columns: result.columns.filter((row) => columnIds.has(row.id)),
            sessionId: session.id,
            nextCursor: remaining > 0 ? session.cursor : null,
            scopeTotal: session.scopeTotal,
            candidateCount: returned,
            seen: session.seen,
            remaining,
        };
        return session.response;
    }
}
