import { fail, id, integer, object, query as catalogQuery } from './validation.js';
import { RECONCILE_READS, readReconcile } from './reconcile.js';
export function featureScope(scope = {}) {
    object(scope, ['columnId', 'q', 'type', 'tags', 'favorite', 'status', 'sort']);
    return catalogQuery({
        ...(scope.columnId ? { columnId: scope.columnId } : {}),
        q: scope.q ?? '',
        type: scope.type ?? '',
        tags: JSON.stringify(scope.tags ?? []),
        favorite: String(scope.favorite ?? false),
        page: '1',
        ...(scope.status ? { status: scope.status } : {}),
        ...(scope.sort ? { sort: scope.sort } : {}),
    });
}
const page = (input) => integer(input.page ?? 1, 1, 1000000);
const memberSelect = (s, input) => {
    if (input.subjectId) {
        s.detail(id(input.subjectId));
        return { kind: 'companion', id: input.subjectId };
    }
    const preset = s.features.preset(input.presetId);
    return { kind: 'preset', id: preset.id, columnId: preset.column_id };
};
export function readWorldbookFeature(s, input, runtime = null) {
    if (RECONCILE_READS.has(input?.kind)) return readReconcile(s, input);
    const keys = {
        bindings: ['scope', 'after', 'sourceId', 'id', 'materialIds'],
        picker: [
            'scope',
            'page',
            'subjectId',
            'presetId',
            'selected',
            'excludeId',
            'draftAdd',
            'draftRemove',
        ],
        companions: ['scope', 'page', 'subjectId', 'presetId', 'selected'],
        presets: ['scope', 'page', 'id'],
        facets: ['scope', 'page', 'id'],
        plan: ['presetId', 'revision', 'runtimeToken', 'page'],
        'tree-search': ['scope', 'page'],
    };
    if (!keys[input?.kind]) fail('WORLDBOOK_VALIDATION');
    object(input, ['kind', ...keys[input.kind]]);
    if (['bindings', 'presets'].includes(input.kind) && input.scope !== undefined)
        object(input.scope, ['columnId']);
    if (input.kind === 'bindings') {
        const conditions = [],
            args = [];
        if (input.scope?.columnId) {
            s.column(id(input.scope.columnId));
            conditions.push('m.column_id=?');
            args.push(input.scope.columnId);
        }
        if (input.sourceId) {
            conditions.push('m.source_id=?');
            args.push(id(input.sourceId));
        }
        if (input.id) {
            conditions.push('m.id=?');
            args.push(id(input.id));
        }
        if (input.materialIds) {
            if (!Array.isArray(input.materialIds) || input.materialIds.length > 50)
                fail('WORLDBOOK_VALIDATION');
            input.materialIds.forEach(id);
            conditions.push('m.id IN(SELECT value FROM json_each(?))');
            args.push(JSON.stringify(input.materialIds));
        }
        if (input.after) {
            conditions.push('m.id>?');
            args.push(id(input.after));
        }
        const rows = s.all(
            `SELECT m.id,m.source_id,m.entry_uid,m.entry_title,b.lifecycle,b.revision,b.repair_pending,s.locator FROM materials m JOIN wb_bindings b ON b.material_id=m.id JOIN sources s ON s.id=m.source_id ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''} ORDER BY m.id LIMIT 51`,
            ...args,
        );
        const items = rows.slice(0, 50).map((row) => ({
            id: row.id,
            sourceId: row.source_id,
            locator: row.locator,
            uid: row.entry_uid,
            title: row.entry_title,
            lifecycle: row.lifecycle,
            bindingRevision: row.revision,
            repairPending: row.repair_pending === 1,
        }));
        return { items, nextCursor: rows.length > 50 ? items.at(-1).id : null };
    }
    if (input.kind === 'picker' || input.kind === 'companions') {
        const member = memberSelect(s, input),
            scope = featureScope(input.scope),
            selected = input.kind === 'companions' || input.selected === true;
        if (member.columnId) scope.columnId = member.columnId;
        if (input.selected !== undefined && typeof input.selected !== 'boolean') fail('WORLDBOOK_VALIDATION');
        const draftAdd = input.draftAdd ?? [],
            draftRemove = input.draftRemove ?? [];
        for (const values of [draftAdd, draftRemove]) {
            if (!Array.isArray(values) || values.length > 100 || new Set(values).size !== values.length)
                fail('WORLDBOOK_VALIDATION');
            values.forEach(id);
        }
        if (draftAdd.some((value) => draftRemove.includes(value))) fail('WORLDBOOK_VALIDATION');
        const result = s.catalog({
            ...scope,
            page: page(input),
            grouping: false,
            excludeId: input.subjectId ?? input.excludeId,
            member: selected ? member : null,
            draftAdd,
            draftRemove,
        });
        const table = member.kind === 'companion' ? 'wb_companions' : 'wb_preset_members',
            owner = member.kind === 'companion' ? 'subject_id' : 'preset_id',
            target = member.kind === 'companion' ? 'companion_id' : 'material_id';
        const selectedCount = s.one(
            `SELECT COUNT(*) n FROM materials m WHERE (EXISTS(SELECT 1 FROM ${table} rel WHERE rel.${owner}=? AND rel.${target}=m.id) OR m.id IN(SELECT value FROM json_each(?))) AND m.id NOT IN(SELECT value FROM json_each(?))`,
            member.id,
            JSON.stringify(draftAdd),
            JSON.stringify(draftRemove),
        ).n;
        for (const item of result.items)
            item.persistedSelected = Boolean(
                s.one(`SELECT 1 FROM ${table} WHERE ${owner}=? AND ${target}=?`, member.id, item.id),
            );
        for (const item of result.items)
            item.selected =
                !draftRemove.includes(item.id) && (draftAdd.includes(item.id) || item.persistedSelected);
        const revision =
            member.kind === 'companion'
                ? s.features.state(member.id).relationRevision
                : s.features.preset(member.id).revision;
        return { ...result, selectedCount, revision };
    }
    if (input.kind === 'presets') {
        if (input.id) {
            const row = s.features.preset(input.id);
            return {
                items: [
                    {
                        id: row.id,
                        columnId: row.column_id,
                        name: row.name,
                        revision: row.revision,
                        memberCount: s.one(
                            'SELECT COUNT(*) n FROM wb_preset_members WHERE preset_id=?',
                            row.id,
                        ).n,
                    },
                ],
                total: 1,
                page: 1,
                pageSize: 20,
                pageCount: 1,
            };
        }
        const columnId = input.scope?.columnId ?? null;
        if (columnId !== null) s.column(id(columnId));
        const currentPage = page(input),
            total = s.one('SELECT COUNT(*) n FROM wb_presets WHERE column_id IS ?', columnId).n;
        const items = s
            .all(
                'SELECT p.*, (SELECT COUNT(*) FROM wb_preset_members pm WHERE pm.preset_id=p.id) member_count FROM wb_presets p WHERE column_id IS ? ORDER BY wb_fold(name),id LIMIT 20 OFFSET ?',
                columnId,
                (currentPage - 1) * 20,
            )
            .map((row) => ({
                id: row.id,
                columnId: row.column_id,
                name: row.name,
                revision: row.revision,
                memberCount: row.member_count,
            }));
        return {
            items,
            page: currentPage,
            total,
            pageSize: 20,
            pageCount: Math.max(1, Math.ceil(total / 20)),
        };
    }
    if (input.kind === 'facets') {
        const scope = featureScope(input.scope),
            tag = input.id === 'tags';
        if (!tag && input.id !== 'types') fail('WORLDBOOK_VALIDATION');
        const clauses = [tag ? "t.tag<>''" : "m.material_type<>''"],
            args = [];
        if (scope.columnId) {
            clauses.push('m.column_id=?');
            args.push(scope.columnId);
        }
        const field = tag ? 't.tag' : 'm.material_type';
        if (scope.q) {
            clauses.push(`instr(wb_fold(${field}),?)>0`);
            args.push(scope.q);
        }
        const base = `FROM materials m ${tag ? 'JOIN tags t ON t.material_id=m.id' : ''} WHERE ${clauses.join(' AND ')}`;
        const total = s.one(`SELECT COUNT(DISTINCT wb_fold(${field})) n ${base}`, ...args).n;
        return {
            items: s.all(
                `SELECT min(${field}) value,COUNT(*) count ${base} GROUP BY wb_fold(${field}) ORDER BY count DESC,wb_fold(${field}) LIMIT 50 OFFSET ?`,
                ...args,
                (page(input) - 1) * 50,
            ),
            total,
            page: page(input),
            pageSize: 50,
            pageCount: Math.max(1, Math.ceil(total / 50)),
        };
    }
    if (input.kind === 'plan') return enablePlan(s, input, runtime);
    if (input.kind === 'tree-search') return treeSearch(s, input);
    fail('WORLDBOOK_VALIDATION');
}
function enablePlan(s, input, runtime) {
    const preset = s.features.preset(input.presetId);
    if (preset.revision !== integer(input.revision)) fail('WORLDBOOK_CONFLICT');
    const exact = preset.column_id !== null;
    if (exact && !input.runtimeToken) fail('WORLDBOOK_RUNTIME_EXPIRED');
    if (exact && runtime && !runtime.observed) fail('WORLDBOOK_RUNTIME_UNAVAILABLE');
    const args = exact ? [preset.column_id] : [preset.id];
    const base = `WITH chosen AS(SELECT m.id,m.source_id,m.entry_uid,m.entry_title,m.name,s.locator,b.lifecycle,b.revision binding_revision,
        CASE WHEN EXISTS(SELECT 1 FROM wb_preset_members pm WHERE pm.preset_id=? AND pm.material_id=m.id) THEN 1 ELSE 0 END desired
        FROM materials m JOIN sources s ON s.id=m.source_id JOIN wb_bindings b ON b.material_id=m.id WHERE ${exact ? 'm.column_id=?' : 'EXISTS(SELECT 1 FROM wb_preset_members pm WHERE pm.preset_id=? AND pm.material_id=m.id)'}),
        ranked AS(SELECT *,row_number() OVER(PARTITION BY source_id,entry_uid ORDER BY desired DESC,id) member FROM chosen WHERE lifecycle='active')`;
    if (exact && runtime?.observed) {
        const unknown = s.one(
            base +
                ` SELECT COUNT(*) n FROM ranked chosen WHERE member=1 AND NOT EXISTS(SELECT 1 FROM json_each(?) r WHERE json_extract(r.value,'$.locator')=chosen.locator AND json_extract(r.value,'$.uid')=chosen.entry_uid)`,
            preset.id,
            ...args,
            JSON.stringify(runtime.bindings),
        ).n;
        if (unknown) fail('WORLDBOOK_RUNTIME_UNAVAILABLE');
    }
    const total = s.one(base + ' SELECT COUNT(*) n FROM ranked WHERE member=1', preset.id, ...args).n;
    const rows = s.all(
        base + ' SELECT * FROM ranked WHERE member=1 ORDER BY source_id,entry_uid LIMIT 50 OFFSET ?',
        preset.id,
        ...args,
        (page(input) - 1) * 50,
    );
    const skipped = s.one(
        "SELECT COUNT(*) n FROM wb_preset_members pm JOIN wb_bindings b ON b.material_id=pm.material_id WHERE pm.preset_id=? AND b.lifecycle='detached'",
        preset.id,
    ).n;
    return {
        items: rows.map((r) => ({
            id: r.id,
            name: r.name,
            on: r.desired === 1,
            sourceId: r.source_id,
            locator: r.locator,
            uid: r.entry_uid,
            title: r.entry_title,
            bindingRevision: r.binding_revision,
        })),
        total,
        skipped,
        page: page(input),
        pageSize: 50,
        pageCount: Math.max(1, Math.ceil(total / 50)),
        exact,
        preset: { id: preset.id, name: preset.name, revision: preset.revision },
    };
}
function treeSearch(s, input) {
    const scope = featureScope(input.scope);
    if (!scope.columnId) fail('WORLDBOOK_VALIDATION');
    s.column(scope.columnId);
    const sql = `WITH RECURSIVE nodes AS(SELECT id,parent_id,name,'folder' kind FROM folders WHERE column_id=? UNION ALL SELECT id,parent_id,name,'material' kind FROM materials WHERE column_id=?),
        branch(id) AS(SELECT id FROM nodes WHERE kind='folder' AND instr(wb_fold(name),?)>0 UNION SELECT n.id FROM nodes n JOIN branch b ON n.parent_id=b.id),
        hits AS(SELECT n.* FROM nodes n WHERE n.id IN(SELECT id FROM branch) OR instr(wb_fold(n.name),?)>0 OR (n.kind='material' AND EXISTS(SELECT 1 FROM materials m WHERE m.id=n.id AND (instr(wb_fold(m.material_type),?)>0 OR instr(wb_fold(m.summary),?)>0 OR EXISTS(SELECT 1 FROM tags t WHERE t.material_id=m.id AND instr(wb_fold(t.tag),?)>0) OR EXISTS(SELECT 1 FROM material_details d WHERE d.material_id=m.id AND instr(d.description_folded,?)>0)))))`;
    const args = [scope.columnId, scope.columnId, ...Array(6).fill(scope.q)],
        total = s.one(sql + ' SELECT COUNT(*) n FROM hits', ...args).n;
    const hits = s.all(
        sql + ' SELECT * FROM hits ORDER BY name,id LIMIT 10 OFFSET ?',
        ...args,
        (page(input) - 1) * 10,
    );
    const hitIds = hits.map((row) => row.id);
    const rows = hitIds.length
        ? s.all(
              `WITH RECURSIVE ancestors(id) AS(SELECT value FROM json_each(?) UNION SELECT f.parent_id FROM folders f JOIN ancestors a ON f.id=a.id WHERE f.parent_id IS NOT NULL UNION SELECT m.parent_id FROM materials m JOIN ancestors a ON m.id=a.id WHERE m.parent_id IS NOT NULL) SELECT f.id,f.parent_id,f.name,'folder' kind,f.position,f.revision FROM folders f JOIN ancestors a ON a.id=f.id UNION ALL SELECT m.id,m.parent_id,m.name,'material',m.position,m.revision FROM materials m WHERE m.id IN(SELECT value FROM json_each(?))`,
              JSON.stringify(hitIds),
              JSON.stringify(hitIds),
          )
        : [];
    return {
        column: s.columnView(s.column(scope.columnId)),
        items: rows.map((row) => ({
            id: row.id,
            parentId: row.parent_id,
            name: row.name,
            kind: row.kind,
            order: row.position,
            revision: row.revision,
            match: hitIds.includes(row.id),
            ...(row.kind === 'material'
                ? { source: s.detail(row.id).material.source, ...s.features.state(row.id) }
                : {}),
        })),
        total,
        page: page(input),
        pageSize: 10,
        pageCount: Math.max(1, Math.ceil(total / 10)),
    };
}
