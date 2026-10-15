import path from 'node:path';
import { mkdir, lstat, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
    LIMITS,
    BUILTINS,
    fail,
    id,
    integer,
    text,
    object,
    source,
    metadata,
    appearance,
    commandToken,
    canonical,
    newId,
    folded,
} from './validation.js';

export class WorldbookStore {
    constructor(userRoot, DatabaseSync, { now = () => Date.now() } = {}) {
        this.root = path.join(userRoot, 'tavern-toolbox-server', 'worldbook-v1');
        this.DatabaseSync = DatabaseSync;
        this.now = now;
    }
    async initialize() {
        for (const directory of [path.dirname(this.root), this.root]) {
            await mkdir(directory, { recursive: true, mode: 0o700 });
            const info = await lstat(directory);
            if (!info.isDirectory() || info.isSymbolicLink()) fail('WORLDBOOK_DATA_INVALID');
            await chmod(directory, 0o700);
        }
        const file = path.join(this.root, 'worldbook.sqlite');
        try {
            if ((await lstat(file)).isSymbolicLink()) fail('WORLDBOOK_DATA_INVALID');
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        const db = new this.DatabaseSync(file);
        try {
            db.function('wb_fold', { deterministic: true }, folded);
            await chmod(file, 0o600);
            db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=1000; PRAGMA synchronous=FULL;');
            const version = db.prepare('PRAGMA user_version').get().user_version;
            if (version !== 0 && version !== 1) fail('WORLDBOOK_SCHEMA_INCOMPATIBLE');
            if (version === 0) {
                if (
                    db
                        .prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
                        .get().n
                )
                    fail('WORLDBOOK_SCHEMA_INCOMPATIBLE');
                db.exec(`BEGIN IMMEDIATE;
                    CREATE TABLE columns (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL, icon TEXT NOT NULL, accent TEXT NOT NULL,
                        position INTEGER NOT NULL, builtin INTEGER NOT NULL, revision INTEGER NOT NULL, structure_revision INTEGER NOT NULL, tree_revision INTEGER NOT NULL);
                    CREATE TABLE sources (id TEXT PRIMARY KEY, locator TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, revision INTEGER NOT NULL);
                    CREATE TABLE folders (id TEXT PRIMARY KEY, column_id TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
                        parent_id TEXT REFERENCES folders(id), name TEXT NOT NULL, position INTEGER NOT NULL, revision INTEGER NOT NULL);
                    CREATE INDEX folder_parent ON folders(column_id,parent_id,position,id);
                    CREATE TABLE materials (id TEXT PRIMARY KEY, column_id TEXT NOT NULL REFERENCES columns(id) ON DELETE CASCADE,
                        parent_id TEXT REFERENCES folders(id), position INTEGER NOT NULL, name TEXT NOT NULL, material_type TEXT NOT NULL,
                        summary TEXT NOT NULL, favorite INTEGER NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id),
                        entry_uid INTEGER NOT NULL, entry_title TEXT NOT NULL, revision INTEGER NOT NULL);
                    CREATE INDEX material_parent ON materials(column_id,parent_id,position,id);
                    CREATE INDEX material_source ON materials(source_id,entry_uid,column_id,id);
                    CREATE INDEX material_favorite ON materials(favorite,column_id,position,id);
                    CREATE INDEX material_type ON materials(wb_fold(material_type),column_id,position,id);
                    CREATE TABLE material_details (material_id TEXT PRIMARY KEY REFERENCES materials(id) ON DELETE CASCADE, description TEXT NOT NULL, description_folded TEXT NOT NULL);
                    CREATE TABLE tags (material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE, tag TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY(material_id,tag));
                    CREATE INDEX tag_value ON tags(wb_fold(tag),material_id);
                    CREATE TABLE commands (id TEXT PRIMARY KEY, issued_at INTEGER NOT NULL, digest TEXT NOT NULL, response TEXT NOT NULL);
                    CREATE INDEX command_expiry ON commands(issued_at); PRAGMA user_version=1;`);
                const insert = db.prepare('INSERT INTO columns VALUES (?,?,?,?,?,?,1,1,1,1)');
                for (const row of BUILTINS)
                    insert.run(row.id, row.title, row.description, JSON.stringify(row.icon), row.accent, row.order);
                db.exec('COMMIT');
            }
            try {
                for (const table of [
                    'columns',
                    'folders',
                    'materials',
                    'material_details',
                    'sources',
                    'tags',
                    'commands',
                ])
                    db.prepare(`SELECT * FROM ${table} LIMIT 0`).all();
                const tagColumns = db
                    .prepare('PRAGMA table_info(tags)')
                    .all()
                    .map((row) => row.name);
                // Narrow additive upgrade of the earlier, unreleased v1 candidate.
                // Preserve its observed alphabetical order and all business IDs.
                if (tagColumns.join(',') === 'material_id,tag') {
                    db.exec(`BEGIN IMMEDIATE;
                        ALTER TABLE tags ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
                        WITH ordered AS (SELECT material_id,tag,row_number() OVER(PARTITION BY material_id ORDER BY tag)-1 position FROM tags)
                        UPDATE tags SET position=(SELECT position FROM ordered o WHERE o.material_id=tags.material_id AND o.tag=tags.tag);
                        COMMIT;`);
                } else if (tagColumns.join(',') !== 'material_id,tag,position') fail('WORLDBOOK_SCHEMA_INCOMPATIBLE');
            } catch {
                fail('WORLDBOOK_SCHEMA_INCOMPATIBLE');
            }
            if (BUILTINS.some((row) => db.prepare('SELECT builtin FROM columns WHERE id=?').get(row.id)?.builtin !== 1))
                fail('WORLDBOOK_DATA_INVALID');
            this.db = db;
        } catch (error) {
            try {
                db.exec('ROLLBACK');
            } catch {}
            db.close();
            throw error;
        }
    }
    close() {
        this.db?.close();
        this.db = null;
    }
    one(sql, ...args) {
        return this.db.prepare(sql).get(...args);
    }
    all(sql, ...args) {
        return this.db.prepare(sql).all(...args);
    }
    run(sql, ...args) {
        return this.db.prepare(sql).run(...args);
    }
    column(columnId) {
        const row = this.one('SELECT * FROM columns WHERE id=?', id(columnId));
        if (!row) fail('WORLDBOOK_NOT_FOUND');
        return row;
    }
    columnView(row) {
        return {
            id: row.id,
            title: row.title,
            description: row.description,
            icon: JSON.parse(row.icon),
            accent: row.accent,
            order: row.position,
            builtin: row.builtin === 1,
            revision: row.revision,
            structureRevision: row.structure_revision,
            treeRevision: row.tree_revision,
            materialCount: this.one('SELECT COUNT(*) n FROM materials WHERE column_id=?', row.id).n,
        };
    }
    summary(page = 1) {
        const total = this.one('SELECT COUNT(*) n FROM columns').n;
        return {
            schemaVersion: 1,
            columns: this.all(
                'SELECT * FROM columns ORDER BY position,id LIMIT ? OFFSET ?',
                LIMITS.summaryPageSize,
                (page - 1) * LIMITS.summaryPageSize,
            ).map((row) => this.columnView(row)),
            total,
            page,
            pageSize: LIMITS.summaryPageSize,
            nextPage: page * LIMITS.summaryPageSize < total ? page + 1 : null,
        };
    }
    sources(page = 1) {
        const total = this.one(
            'SELECT COUNT(*) n FROM sources s WHERE EXISTS(SELECT 1 FROM materials m WHERE m.source_id=s.id)',
        ).n;
        return {
            items: this.all(
                'SELECT s.id,s.locator,s.display_name FROM sources s WHERE EXISTS(SELECT 1 FROM materials m WHERE m.source_id=s.id) ORDER BY s.id LIMIT ? OFFSET ?',
                LIMITS.sourcePageSize,
                (page - 1) * LIMITS.sourcePageSize,
            ).map((row) => ({
                id: row.id,
                locator: row.locator,
                displayName: row.display_name,
            })),
            total,
            nextPage: page * LIMITS.sourcePageSize < total ? page + 1 : null,
        };
    }
    material(row, detail = false) {
        return {
            id: row.id,
            columnId: row.column_id,
            parentId: row.parent_id,
            order: row.position,
            name: row.name,
            materialType: row.material_type,
            summary: row.summary,
            ...(detail ? { description: row.description } : {}),
            tags: this.all('SELECT tag FROM tags WHERE material_id=? ORDER BY position,tag', row.id).map(
                (item) => item.tag,
            ),
            favorite: row.favorite === 1,
            revision: row.revision,
            source: {
                sourceId: row.source_id,
                locator: row.locator,
                uid: row.entry_uid,
                title: row.entry_title,
            },
            ...(row.member_count ? { memberCount: row.member_count } : {}),
        };
    }
    detail(materialId) {
        const row = this.one(
            'SELECT m.*,d.description,s.locator FROM materials m JOIN material_details d ON d.material_id=m.id JOIN sources s ON s.id=m.source_id WHERE m.id=?',
            id(materialId),
        );
        if (!row) fail('WORLDBOOK_NOT_FOUND');
        return {
            material: this.material(row, true),
            column: this.columnView(this.column(row.column_id)),
        };
    }
    ack(materialId) {
        const row = this.one('SELECT id,column_id,revision FROM materials WHERE id=?', materialId);
        return {
            id: row.id,
            columnId: row.column_id,
            revision: row.revision,
            structureRevision: this.column(row.column_id).structure_revision,
        };
    }
    catalog(query, runtime = null) {
        if (query.columnId) this.column(query.columnId);
        const clauses = [],
            args = [];
        if (query.columnId) {
            clauses.push('m.column_id=?');
            args.push(query.columnId);
        }
        if (query.q) {
            clauses.push(
                '(instr(wb_fold(m.name),?)>0 OR instr(wb_fold(m.material_type),?)>0 OR instr(wb_fold(m.summary),?)>0 OR EXISTS(SELECT 1 FROM tags t WHERE t.material_id=m.id AND instr(wb_fold(t.tag),?)>0) OR EXISTS(SELECT 1 FROM material_details d WHERE d.material_id=m.id AND instr(d.description_folded,?)>0))',
            );
            args.push(...Array(5).fill(query.q));
        }
        if (query.type) {
            clauses.push('wb_fold(m.material_type)=?');
            args.push(query.type);
        }
        if (query.favorite) clauses.push('m.favorite=1');
        for (const tag of query.tags) {
            clauses.push('EXISTS(SELECT 1 FROM tags t WHERE t.material_id=m.id AND wb_fold(t.tag)=?)');
            args.push(tag);
        }
        if (query.sourceId) {
            clauses.push('m.source_id=? AND m.entry_uid=?');
            args.push(query.sourceId, query.uid);
        }
        if (runtime) args.unshift(JSON.stringify(runtime));
        const grouping = !query.columnId && !query.sourceId;
        const base = `WITH ${runtime ? "runtime_bindings AS MATERIALIZED(SELECT DISTINCT json_extract(value,'$.locator') locator,json_extract(value,'$.uid') uid FROM json_each(?))," : ''} selected AS (SELECT m.id,m.column_id,m.parent_id,m.position,m.name,m.material_type,m.summary,m.favorite,m.source_id,m.entry_uid,m.entry_title,m.revision,s.locator,c.position column_order,
            ROW_NUMBER() OVER(PARTITION BY ${grouping ? 'm.source_id,m.entry_uid' : 'm.id'} ORDER BY c.position,c.id,m.position,m.id) member_number,
            COUNT(*) OVER(PARTITION BY ${grouping ? 'm.source_id,m.entry_uid' : 'm.id'}) member_count
            FROM materials m JOIN sources s ON s.id=m.source_id JOIN columns c ON c.id=m.column_id ${runtime ? 'JOIN runtime_bindings r ON r.locator=s.locator AND r.uid=m.entry_uid' : ''} ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''})`;
        const total = this.one(base + ' SELECT COUNT(*) n FROM selected WHERE member_number=1', ...args).n;
        const rows = this.all(
            base +
                ' SELECT * FROM selected WHERE member_number=1 ORDER BY column_order,column_id,position,id LIMIT ? OFFSET ?',
            ...args,
            LIMITS.pageSize,
            (query.page - 1) * LIMITS.pageSize,
        );
        const columns = [...new Set(rows.map((row) => row.column_id))].map((columnId) =>
            this.columnView(this.column(columnId)),
        );
        return {
            items: rows.map((row) => this.material(row)),
            columns,
            total,
            page: query.page,
            pageSize: LIMITS.pageSize,
            pageCount: Math.max(1, Math.ceil(total / LIMITS.pageSize)),
        };
    }
    tree(columnId, { offset = 0, stamp = null } = {}) {
        const column = this.column(columnId);
        if (stamp !== null && stamp !== column.tree_revision) fail('WORLDBOOK_TREE_CHANGED');
        const sql = `WITH RECURSIVE nodes AS (
            SELECT id,parent_id,name,position,revision,'folder' kind,NULL source_id,NULL entry_uid FROM folders WHERE column_id=?
            UNION ALL SELECT id,parent_id,name,position,revision,'material' kind,source_id,entry_uid FROM materials WHERE column_id=?),
            tree AS (SELECT *,printf('%010d',position)||id path,1 depth FROM nodes WHERE parent_id IS NULL
            UNION ALL SELECT n.*,t.path||'/'||printf('%010d',n.position)||n.id,t.depth+1 FROM nodes n JOIN tree t ON n.parent_id=t.id WHERE t.depth<17)
            SELECT t.*,s.locator FROM tree t LEFT JOIN sources s ON s.id=t.source_id ORDER BY path LIMIT ? OFFSET ?`;
        const rows = this.all(sql, columnId, columnId, LIMITS.treePageSize + 1, offset),
            more = rows.length > LIMITS.treePageSize;
        return {
            column: this.columnView(column),
            items: rows.slice(0, LIMITS.treePageSize).map((row) => ({
                id: row.id,
                kind: row.kind,
                parentId: row.parent_id,
                name: row.name,
                order: row.position,
                revision: row.revision,
                ...(row.kind === 'material'
                    ? {
                          source: {
                              sourceId: row.source_id,
                              locator: row.locator,
                              uid: row.entry_uid,
                          },
                      }
                    : {}),
            })),
            nextCursor: more ? `${column.tree_revision}:${offset + LIMITS.treePageSize}` : null,
        };
    }
    capacity(table, limit, extra = 1) {
        if (this.one(`SELECT COUNT(*) n FROM ${table}`).n + extra > limit) fail('WORLDBOOK_CAPACITY');
    }
    ensureSource(binding) {
        const existing = this.one('SELECT id FROM sources WHERE locator=?', binding.locator);
        if (existing) return existing.id;
        // Check the referenced-source budget after mutation and orphan cleanup;
        // a rebind at capacity must be able to replace its final old reference.
        const sourceId = newId('source');
        this.run('INSERT INTO sources VALUES(?,?,?,1)', sourceId, binding.locator, binding.locator);
        return sourceId;
    }
    parent(columnId, parentId) {
        if (parentId === null) return 0;
        id(parentId);
        let depth = 0,
            current = parentId;
        const seen = new Set();
        while (current) {
            if (seen.has(current) || ++depth > LIMITS.maxDepth) fail('WORLDBOOK_VALIDATION');
            seen.add(current);
            const row = this.one('SELECT parent_id,column_id FROM folders WHERE id=?', current);
            if (!row || row.column_id !== columnId) fail('WORLDBOOK_NOT_FOUND');
            current = row.parent_id;
        }
        return depth;
    }
    expectStructure(columnId, revision) {
        const row = this.column(columnId);
        integer(revision);
        if (row.structure_revision !== revision) fail('WORLDBOOK_CONFLICT');
        return row;
    }
    bump(columnId, structure = false) {
        this.run(
            `UPDATE columns SET tree_revision=tree_revision+1${structure ? ',structure_revision=structure_revision+1' : ''} WHERE id=?`,
            columnId,
        );
    }
    position(columnId, parentId, beforeId = null) {
        this.parent(columnId, parentId);
        const all =
            'SELECT id,position FROM folders WHERE column_id=? AND parent_id IS ? UNION ALL SELECT id,position FROM materials WHERE column_id=? AND parent_id IS ?';
        if (!beforeId)
            return integer(
                (this.one(`SELECT MAX(position) n FROM (${all})`, columnId, parentId, columnId, parentId).n ?? -1) + 1,
                0,
                1000000000,
            );
        const target = this.one(
            `SELECT position FROM (${all}) WHERE id=?`,
            columnId,
            parentId,
            columnId,
            parentId,
            id(beforeId),
        );
        if (!target) fail('WORLDBOOK_NOT_FOUND');
        for (const table of ['folders', 'materials'])
            this.run(
                `UPDATE ${table} SET position=position+1 WHERE column_id=? AND parent_id IS ? AND position>=?`,
                columnId,
                parentId,
                target.position,
            );
        return target.position;
    }
    insertMaterial(columnId, parentId, value, position) {
        this.capacity('materials', LIMITS.maxMaterials);
        const materialId = newId('material'),
            sourceId = this.ensureSource(value.source);
        this.run(
            'INSERT INTO materials(id,column_id,parent_id,position,name,material_type,summary,favorite,source_id,entry_uid,entry_title,revision) VALUES(?,?,?,?,?,?,?,?,?,?,?,1)',
            materialId,
            columnId,
            parentId,
            position,
            value.name,
            value.materialType,
            value.summary,
            value.favorite ? 1 : 0,
            sourceId,
            value.source.uid,
            value.source.title,
        );
        // Normalize only this edited body. Querying long descriptions must not
        // invoke JavaScript/ICU for every body on every keystroke.
        this.run(
            'INSERT INTO material_details VALUES(?,?,?)',
            materialId,
            value.description,
            folded(value.description),
        );
        // Explicit column list prevents schema/placeholder drift from silently losing a placement.
        value.tags.forEach((tag, position) =>
            this.run('INSERT INTO tags(material_id,tag,position) VALUES(?,?,?)', materialId, tag, position),
        );
        return materialId;
    }
    execute(body) {
        object(body, ['commandId', 'action', 'data'], ['commandId', 'action', 'data']);
        const issuedAt = commandToken(body.commandId, this.now());
        text(body.action, 40, true);
        const digest = createHash('sha256')
            .update(JSON.stringify(canonical({ action: body.action, data: body.data })))
            .digest('hex');
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const receipt = this.one('SELECT * FROM commands WHERE id=?', body.commandId);
            if (receipt) {
                if (receipt.digest !== digest) fail('WORLDBOOK_IDEMPOTENCY_MISMATCH');
                const result = JSON.parse(receipt.response);
                this.db.exec('COMMIT');
                return { ...result, replayed: true };
            }
            this.run('DELETE FROM commands WHERE issued_at<?', this.now() - LIMITS.commandTtlMs);
            this.capacity('commands', LIMITS.maxCommandReceipts);
            const before = new Set(
                this.all(
                    'SELECT s.id FROM sources s WHERE EXISTS(SELECT 1 FROM materials m WHERE m.source_id=s.id)',
                ).map((row) => row.id),
            );
            const result = this.mutate(body.action, body.data);
            this.run('DELETE FROM sources WHERE NOT EXISTS(SELECT 1 FROM materials m WHERE m.source_id=sources.id)');
            this.capacity('sources', LIMITS.maxSources, 0);
            result.replayed = false;
            result.columns = [...new Set([result.columnId, result.fromColumnId, result.column?.id].filter(Boolean))]
                .filter((columnId) => this.one('SELECT id FROM columns WHERE id=?', columnId))
                .map((columnId) => this.columnView(this.column(columnId)));
            const after = this.all(
                    'SELECT s.id,s.locator FROM sources s WHERE EXISTS(SELECT 1 FROM materials m WHERE m.source_id=s.id)',
                ),
                remaining = new Set(after.map((row) => row.id));
            result.sourcesAdded = after
                .filter((row) => !before.has(row.id))
                .map((row) => ({ id: row.id, locator: row.locator }));
            result.sourceIdsRemoved = [...before].filter((sourceId) => !remaining.has(sourceId));
            const response = JSON.stringify(result);
            if (Buffer.byteLength(response) > LIMITS.maxResponseBytes - 1024) fail('WORLDBOOK_CAPACITY');
            this.run('INSERT INTO commands VALUES(?,?,?,?)', body.commandId, issuedAt, digest, response);
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    mutate(action, data) {
        if (action === 'column-reorder') {
            object(
                data,
                ['id', 'revision', 'targetId', 'targetRevision'],
                ['id', 'revision', 'targetId', 'targetRevision'],
            );
            const current = this.column(data.id),
                target = this.column(data.targetId);
            if (current.builtin || target.builtin || current.id === target.id) fail('WORLDBOOK_BUILTIN');
            if (current.revision !== integer(data.revision) || target.revision !== integer(data.targetRevision))
                fail('WORLDBOOK_CONFLICT');
            const rows = this.all('SELECT id,position FROM columns WHERE builtin=0 ORDER BY position,id'),
                from = rows.findIndex((row) => row.id === current.id),
                to = rows.findIndex((row) => row.id === target.id);
            rows.splice(to, 0, ...rows.splice(from, 1));
            rows.forEach((row, index) => {
                const position = 100 + index * 10;
                if (row.position !== position)
                    this.run('UPDATE columns SET position=?,revision=revision+1 WHERE id=?', position, row.id);
            });
            return {
                column: this.columnView(this.column(current.id)),
                summaryChanged: true,
            };
        }
        if (action === 'column-create') {
            object(data, ['profile', 'materials', 'importFolderName'], ['profile']);
            const profile = appearance(data.profile),
                rows = data.materials ?? [];
            if (!Array.isArray(rows) || rows.length > LIMITS.maxImportItems) fail('WORLDBOOK_VALIDATION');
            const materials = rows.map((row) => metadata(row));
            const folderName =
                data.importFolderName === undefined ? profile.title : text(data.importFolderName, LIMITS.maxName, true);
            this.capacity('columns', LIMITS.maxColumns);
            const columnId = newId('worldbook-user');
            this.run(
                'INSERT INTO columns VALUES(?,?,?,?,?,?,0,1,1,1)',
                columnId,
                profile.title,
                profile.description,
                JSON.stringify(profile.icon),
                profile.accent,
                profile.order,
            );
            let folderId = null;
            if (materials.length) {
                this.capacity('folders', LIMITS.maxFolders);
                folderId = newId('folder');
                this.run('INSERT INTO folders VALUES(?,?,NULL,?,0,1)', folderId, columnId, folderName);
            }
            materials.forEach((row, index) => this.insertMaterial(columnId, folderId, row, index));
            return {
                column: this.columnView(this.column(columnId)),
                createdCount: materials.length,
            };
        }
        if (action === 'column-update') {
            object(data, ['id', 'revision', 'profile'], ['id', 'revision', 'profile']);
            const current = this.column(data.id),
                profile = appearance(data.profile);
            integer(data.revision);
            if (current.builtin) fail('WORLDBOOK_BUILTIN');
            if (current.revision !== data.revision) fail('WORLDBOOK_CONFLICT');
            this.run(
                'UPDATE columns SET title=?,description=?,icon=?,accent=?,position=?,revision=revision+1 WHERE id=?',
                profile.title,
                profile.description,
                JSON.stringify(profile.icon),
                profile.accent,
                profile.order,
                current.id,
            );
            return { column: this.columnView(this.column(current.id)) };
        }
        if (action === 'column-delete') {
            object(data, ['id', 'revision', 'structureRevision'], ['id', 'revision', 'structureRevision']);
            const current = this.expectStructure(data.id, data.structureRevision);
            if (current.builtin) fail('WORLDBOOK_BUILTIN');
            if (current.revision !== integer(data.revision)) fail('WORLDBOOK_CONFLICT');
            this.run('DELETE FROM materials WHERE column_id=?', current.id);
            this.run('UPDATE folders SET parent_id=NULL WHERE column_id=?', current.id);
            this.run('DELETE FROM folders WHERE column_id=?', current.id);
            this.run('DELETE FROM columns WHERE id=?', current.id);
            return { deleted: true, columnId: current.id };
        }
        if (action === 'material-update') {
            object(data, ['id', 'revision', 'fields'], ['id', 'revision', 'fields']);
            const current = this.detail(data.id).material;
            if (current.revision !== integer(data.revision)) fail('WORLDBOOK_CONFLICT');
            const fields = metadata(data.fields, true),
                mapping = {
                    name: 'name',
                    materialType: 'material_type',
                    summary: 'summary',
                    favorite: 'favorite',
                };
            for (const [key, column] of Object.entries(mapping))
                if (Object.hasOwn(fields, key))
                    this.run(
                        `UPDATE materials SET ${column}=? WHERE id=?`,
                        key === 'favorite' ? (fields[key] ? 1 : 0) : fields[key],
                        data.id,
                    );
            if (Object.hasOwn(fields, 'description'))
                this.run(
                    'UPDATE material_details SET description=?,description_folded=? WHERE material_id=?',
                    fields.description,
                    folded(fields.description),
                    data.id,
                );
            if (fields.tags) {
                this.run('DELETE FROM tags WHERE material_id=?', data.id);
                fields.tags.forEach((tag, position) =>
                    this.run('INSERT INTO tags(material_id,tag,position) VALUES(?,?,?)', data.id, tag, position),
                );
            }
            if (fields.source)
                this.run(
                    'UPDATE materials SET source_id=?,entry_uid=?,entry_title=? WHERE id=?',
                    this.ensureSource(fields.source),
                    fields.source.uid,
                    fields.source.title,
                    data.id,
                );
            this.run('UPDATE materials SET revision=revision+1 WHERE id=?', data.id);
            this.bump(current.columnId);
            return this.ack(data.id);
        }
        if (action === 'material-create') {
            object(
                data,
                ['columnId', 'parentId', 'structureRevision', 'material'],
                ['columnId', 'parentId', 'structureRevision', 'material'],
            );
            this.expectStructure(data.columnId, data.structureRevision);
            this.parent(data.columnId, data.parentId);
            const materialId = this.insertMaterial(
                data.columnId,
                data.parentId,
                metadata(data.material),
                this.position(data.columnId, data.parentId),
            );
            this.bump(data.columnId, true);
            return this.ack(materialId);
        }
        if (['material-copy', 'material-move', 'material-delete'].includes(action)) {
            const allowed = [
                'id',
                'revision',
                'structureRevision',
                ...(action === 'material-delete'
                    ? []
                    : ['columnId', 'parentId', 'targetStructureRevision', 'beforeId']),
            ];
            object(data, allowed, ['id', 'revision', 'structureRevision']);
            const current = this.detail(data.id).material;
            if (current.revision !== integer(data.revision)) fail('WORLDBOOK_CONFLICT');
            this.expectStructure(current.columnId, data.structureRevision);
            if (action === 'material-delete') {
                this.run('DELETE FROM materials WHERE id=?', current.id);
                this.bump(current.columnId, true);
                return {
                    deleted: true,
                    id: current.id,
                    columnId: current.columnId,
                };
            }
            this.expectStructure(data.columnId, data.targetStructureRevision);
            this.parent(data.columnId, data.parentId);
            if (data.beforeId === current.id) fail('WORLDBOOK_VALIDATION');
            const position = this.position(data.columnId, data.parentId, data.beforeId ?? null);
            if (action === 'material-copy') {
                const materialId = this.insertMaterial(
                    data.columnId,
                    data.parentId,
                    {
                        ...current,
                        source: {
                            locator: current.source.locator,
                            uid: current.source.uid,
                            title: current.source.title,
                        },
                    },
                    position,
                );
                this.bump(data.columnId, true);
                return this.ack(materialId);
            }
            this.run(
                'UPDATE materials SET column_id=?,parent_id=?,position=?,revision=revision+1 WHERE id=?',
                data.columnId,
                data.parentId,
                position,
                current.id,
            );
            this.bump(current.columnId, true);
            if (data.columnId !== current.columnId) this.bump(data.columnId, true);
            return { ...this.ack(current.id), fromColumnId: current.columnId };
        }
        if (action === 'folder-create') {
            object(
                data,
                ['columnId', 'parentId', 'structureRevision', 'name'],
                ['columnId', 'parentId', 'structureRevision', 'name'],
            );
            this.expectStructure(data.columnId, data.structureRevision);
            if (this.parent(data.columnId, data.parentId) >= LIMITS.maxDepth) fail('WORLDBOOK_VALIDATION');
            this.capacity('folders', LIMITS.maxFolders);
            const folderId = newId('folder');
            this.run(
                'INSERT INTO folders VALUES(?,?,?,?,?,1)',
                folderId,
                data.columnId,
                data.parentId,
                text(data.name, 80, true),
                this.position(data.columnId, data.parentId),
            );
            this.bump(data.columnId, true);
            return { folderId, columnId: data.columnId };
        }
        if (['folder-update', 'folder-move', 'folder-delete'].includes(action)) {
            const allowed = [
                'id',
                'revision',
                'structureRevision',
                ...(action === 'folder-update'
                    ? ['name']
                    : action === 'folder-delete'
                      ? ['deleteContents']
                      : ['parentId', 'beforeId']),
            ];
            object(data, allowed, ['id', 'revision', 'structureRevision']);
            const current = this.one('SELECT * FROM folders WHERE id=?', id(data.id));
            if (!current) fail('WORLDBOOK_NOT_FOUND');
            this.expectStructure(current.column_id, data.structureRevision);
            if (current.revision !== integer(data.revision)) fail('WORLDBOOK_CONFLICT');
            if (action === 'folder-update')
                this.run(
                    'UPDATE folders SET name=?,revision=revision+1 WHERE id=?',
                    text(data.name, 80, true),
                    current.id,
                );
            else if (action === 'folder-move') {
                this.parent(current.column_id, data.parentId);
                const descendants = this.all(
                    'WITH RECURSIVE d(id,depth) AS(SELECT id,1 FROM folders WHERE id=? UNION ALL SELECT f.id,d.depth+1 FROM folders f JOIN d ON f.parent_id=d.id) SELECT * FROM d',
                    current.id,
                );
                if (
                    descendants.some((row) => row.id === data.parentId) ||
                    this.parent(current.column_id, data.parentId) + Math.max(...descendants.map((row) => row.depth)) >
                        LIMITS.maxDepth ||
                    data.beforeId === current.id
                )
                    fail('WORLDBOOK_VALIDATION');
                this.run(
                    'UPDATE folders SET parent_id=?,position=?,revision=revision+1 WHERE id=?',
                    data.parentId,
                    this.position(current.column_id, data.parentId, data.beforeId ?? null),
                    current.id,
                );
            } else {
                if (typeof data.deleteContents !== 'boolean') fail('WORLDBOOK_VALIDATION');
                if (data.deleteContents) {
                    this.run(
                        'WITH RECURSIVE d(id) AS(SELECT id FROM folders WHERE id=? UNION ALL SELECT f.id FROM folders f JOIN d ON f.parent_id=d.id) DELETE FROM materials WHERE parent_id IN(SELECT id FROM d)',
                        current.id,
                    );
                    this.run(
                        'WITH RECURSIVE d(id) AS(SELECT id FROM folders WHERE id=? UNION ALL SELECT f.id FROM folders f JOIN d ON f.parent_id=d.id) DELETE FROM folders WHERE id IN(SELECT id FROM d)',
                        current.id,
                    );
                } else {
                    const children = this.all(
                        "SELECT id,position,'folders' target FROM folders WHERE parent_id=? UNION ALL SELECT id,position,'materials' target FROM materials WHERE parent_id=? ORDER BY position,id",
                        current.id,
                        current.id,
                    );
                    for (const table of ['folders', 'materials'])
                        this.run(
                            `UPDATE ${table} SET position=position+? WHERE column_id=? AND parent_id IS ? AND position>=?`,
                            children.length,
                            current.column_id,
                            current.parent_id,
                            current.position,
                        );
                    children.forEach((child, index) =>
                        this.run(
                            `UPDATE ${child.target} SET parent_id=?,position=?,revision=revision+1 WHERE id=?`,
                            current.parent_id,
                            current.position + index,
                            child.id,
                        ),
                    );
                }
                this.run('DELETE FROM folders WHERE id=?', current.id);
            }
            this.bump(current.column_id, true);
            return {
                columnId: current.column_id,
                folderId: current.id,
                deleted: action === 'folder-delete',
            };
        }
        fail('WORLDBOOK_VALIDATION');
    }
}
