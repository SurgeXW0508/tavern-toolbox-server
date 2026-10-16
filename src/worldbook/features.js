import { readWorldbookFeature } from './feature-queries.js';
import { fail, id, integer, text, object, source, newId } from './validation.js';
export const FEATURE_COMMANDS = new Set([
    'companions-save',
    'companions-members',
    'preset-capture',
    'preset-create',
    'preset-update',
    'preset-delete',
    'preset-members',
    'usage-increment',
    'binding-observe',
    'binding-rebind',
    'source-rebind',
]);
const ids = (value) => {
    if (!Array.isArray(value) || value.length > 100 || new Set(value).size !== value.length)
        fail('WORLDBOOK_VALIDATION');
    return value.map(id);
};

// Worldbook's own business operations; all mutations run inside Store.execute's
// existing SQLite transaction and durable command receipt, never an ST writer.
export class WorldbookFeatures {
    constructor(store) {
        this.store = store;
    }
    read(input, runtime) {
        return readWorldbookFeature(this.store, input, runtime);
    }
    material(idValue) {
        return this.store.detail(idValue).material;
    }
    state(materialId) {
        const row = this.store.one(
            'SELECT b.lifecycle,b.revision binding_revision,b.repair_pending,u.enable_count,u.last_enabled_at,r.revision relation_revision FROM wb_bindings b JOIN wb_usage u USING(material_id) JOIN wb_relation_versions r USING(material_id) WHERE b.material_id=?',
            materialId,
        );
        return {
            lifecycle: row.lifecycle,
            repairPending: row.repair_pending === 1,
            bindingRevision: row.binding_revision,
            relationRevision: row.relation_revision,
            enableCount: row.enable_count,
            lastEnabledAt: row.last_enabled_at,
        };
    }
    preset(presetId) {
        const row = this.store.one('SELECT * FROM wb_presets WHERE id=?', id(presetId));
        if (!row) fail('WORLDBOOK_NOT_FOUND');
        return row;
    }
    members(preset, values) {
        const s = this.store;
        for (const memberId of ids(values)) {
            const member = this.material(memberId);
            if (preset.column_id && member.columnId !== preset.column_id) fail('WORLDBOOK_VALIDATION');
            s.run('INSERT OR IGNORE INTO wb_preset_members VALUES(?,?)', preset.id, memberId);
        }
    }
    mutate(action, data, options = {}) {
        const s = this.store;
        if (action === 'companions-members') {
            object(data, ['id', 'revision', 'add', 'remove'], ['id', 'revision', 'add', 'remove']);
            const material = this.material(data.id),
                add = ids(data.add),
                remove = ids(data.remove);
            if (this.state(material.id).relationRevision !== integer(data.revision))
                fail('WORLDBOOK_CONFLICT');
            if (add.includes(material.id) || add.some((value) => remove.includes(value)))
                fail('WORLDBOOK_VALIDATION');
            for (const target of add) this.material(target);
            for (const target of remove)
                s.run('DELETE FROM wb_companions WHERE subject_id=? AND companion_id=?', material.id, target);
            for (const target of add)
                s.run('INSERT OR IGNORE INTO wb_companions VALUES(?,?)', material.id, target);
            if (s.one('SELECT COUNT(*) n FROM wb_companions WHERE subject_id=?', material.id).n > 64)
                fail('WORLDBOOK_CAPACITY');
            s.run('UPDATE wb_relation_versions SET revision=revision+1 WHERE material_id=?', material.id);
            return { id: material.id, relationRevision: data.revision + 1 };
        }
        if (action === 'preset-capture') {
            object(data, ['id', 'revision', 'runtimeToken'], ['id', 'revision', 'runtimeToken']);
            const preset = this.preset(data.id);
            if (preset.revision !== integer(data.revision)) fail('WORLDBOOK_CONFLICT');
            // Resolve only after the durable receipt check: a response-lost retry
            // stays idempotent even when its transient runtime token has expired.
            const runtime = options.getRuntime?.(data.runtimeToken);
            if (!runtime?.observed || runtime.unknownBooks.length) fail('WORLDBOOK_RUNTIME_UNAVAILABLE');
            const scope = preset.column_id ? ' AND m.column_id=?' : '';
            s.run('DELETE FROM wb_preset_members WHERE preset_id=?', preset.id);
            s.run(
                `INSERT INTO wb_preset_members SELECT ?,m.id FROM materials m JOIN sources s ON s.id=m.source_id JOIN wb_bindings b ON b.material_id=m.id JOIN json_each(?) r ON json_extract(r.value,'$.locator')=s.locator AND json_extract(r.value,'$.uid')=m.entry_uid WHERE b.lifecycle='active' AND json_extract(r.value,'$.enabled')=1${scope}`,
                preset.id,
                JSON.stringify(runtime.bindings),
                ...(preset.column_id ? [preset.column_id] : []),
            );
            s.run('UPDATE wb_presets SET revision=revision+1 WHERE id=?', preset.id);
            return { presetId: preset.id, revision: preset.revision + 1 };
        }
        if (action === 'companions-save') {
            object(data, ['id', 'revision', 'memberIds'], ['id', 'revision', 'memberIds']);
            const material = this.material(data.id),
                members = ids(data.memberIds);
            if (members.length > 64 || members.includes(material.id)) fail('WORLDBOOK_VALIDATION');
            if (
                s.one('SELECT revision FROM wb_relation_versions WHERE material_id=?', material.id)
                    .revision !== integer(data.revision)
            )
                fail('WORLDBOOK_CONFLICT');
            for (const target of members) this.material(target);
            s.run('DELETE FROM wb_companions WHERE subject_id=?', material.id);
            for (const target of members) s.run('INSERT INTO wb_companions VALUES(?,?)', material.id, target);
            s.run('UPDATE wb_relation_versions SET revision=revision+1 WHERE material_id=?', material.id);
            return { id: material.id, columnId: material.columnId, relationRevision: data.revision + 1 };
        }
        if (action === 'preset-create') {
            object(data, ['name', 'columnId', 'memberIds'], ['name', 'columnId']);
            if (data.columnId !== null) s.column(id(data.columnId));
            text(data.name, 80, true);
            if (
                s.one(
                    'SELECT id FROM wb_presets WHERE column_id IS ? AND wb_fold(name)=wb_fold(?)',
                    data.columnId,
                    data.name,
                )
            )
                fail('WORLDBOOK_DUPLICATE');
            if (s.one('SELECT COUNT(*) n FROM wb_presets').n >= 1024) fail('WORLDBOOK_CAPACITY');
            const preset = { id: newId('preset'), column_id: data.columnId };
            s.run('INSERT INTO wb_presets VALUES(?,?,?,1)', preset.id, data.columnId, data.name);
            this.members(preset, data.memberIds ?? []);
            return { presetId: preset.id, revision: 1 };
        }
        if (['preset-update', 'preset-delete', 'preset-members'].includes(action)) {
            object(
                data,
                [
                    'id',
                    'revision',
                    ...(action === 'preset-update'
                        ? ['name']
                        : action === 'preset-members'
                          ? ['add', 'remove']
                          : []),
                ],
                ['id', 'revision'],
            );
            const preset = this.preset(data.id);
            if (preset.revision !== integer(data.revision)) fail('WORLDBOOK_CONFLICT');
            if (action === 'preset-delete') s.run('DELETE FROM wb_presets WHERE id=?', preset.id);
            else {
                if (action === 'preset-update') {
                    text(data.name, 80, true);
                    if (
                        s.one(
                            'SELECT id FROM wb_presets WHERE id<>? AND column_id IS ? AND wb_fold(name)=wb_fold(?)',
                            preset.id,
                            preset.column_id,
                            data.name,
                        )
                    )
                        fail('WORLDBOOK_DUPLICATE');
                    s.run('UPDATE wb_presets SET name=? WHERE id=?', data.name, preset.id);
                } else {
                    const add = ids(data.add ?? []),
                        remove = ids(data.remove ?? []);
                    if (add.some((item) => remove.includes(item))) fail('WORLDBOOK_VALIDATION');
                    for (const member of remove)
                        s.run(
                            'DELETE FROM wb_preset_members WHERE preset_id=? AND material_id=?',
                            preset.id,
                            member,
                        );
                    this.members(preset, add);
                }
                s.run('UPDATE wb_presets SET revision=revision+1 WHERE id=?', preset.id);
            }
            return {
                presetId: preset.id,
                revision: preset.revision + 1,
                deleted: action === 'preset-delete',
            };
        }
        if (action === 'usage-increment') {
            object(data, ['materialIds', 'at'], ['materialIds', 'at']);
            integer(data.at, 0, Math.max(0, s.now() + 300000));
            // One increment per business cause, deduped by logical ST source in this operation.
            const seen = new Set();
            let updated = 0;
            for (const materialId of ids(data.materialIds)) {
                const material = this.material(materialId),
                    key = material.source.sourceId + '\0' + material.source.uid;
                if (seen.has(key)) continue;
                seen.add(key);
                s.run(
                    'UPDATE wb_usage SET enable_count=enable_count+1,last_enabled_at=max(last_enabled_at,?) WHERE material_id=?',
                    data.at,
                    materialId,
                );
                updated++;
            }
            return { updated };
        }
        if (action === 'binding-observe') {
            object(data, ['observations'], ['observations']);
            if (!Array.isArray(data.observations) || data.observations.length > 100)
                fail('WORLDBOOK_VALIDATION');
            let updated = 0,
                skipped = 0;
            const changedIds = [],
                changedColumns = new Set();
            for (const observation of data.observations) {
                object(
                    observation,
                    ['id', 'sourceId', 'locator', 'uid', 'bindingRevision', 'lifecycle', 'title'],
                    ['id', 'sourceId', 'locator', 'uid', 'bindingRevision', 'lifecycle'],
                );
                id(observation.id);
                id(observation.sourceId);
                integer(observation.uid);
                integer(observation.bindingRevision);
                text(observation.locator, 240, true);
                if (!['active', 'detached'].includes(observation.lifecycle)) fail('WORLDBOOK_VALIDATION');
                if (observation.title !== undefined) text(observation.title, 200);
                const row = s.one(
                    'SELECT m.*,b.lifecycle,b.revision binding_revision,b.repair_pending,s.locator FROM materials m JOIN wb_bindings b ON b.material_id=m.id JOIN sources s ON s.id=m.source_id WHERE m.id=?',
                    observation.id,
                );
                if (
                    !row ||
                    row.source_id !== observation.sourceId ||
                    row.locator !== observation.locator ||
                    row.entry_uid !== observation.uid ||
                    row.binding_revision !== observation.bindingRevision ||
                    (row.lifecycle === 'detached' && !row.repair_pending)
                ) {
                    skipped++;
                    continue;
                }
                const title =
                    observation.lifecycle === 'active'
                        ? (observation.title ?? row.entry_title)
                        : row.entry_title;
                if (
                    row.repair_pending ||
                    row.lifecycle !== observation.lifecycle ||
                    title !== row.entry_title
                ) {
                    s.run(
                        'UPDATE wb_bindings SET lifecycle=?,repair_pending=0,revision=revision+1 WHERE material_id=?',
                        observation.lifecycle,
                        row.id,
                    );
                    s.run('UPDATE materials SET entry_title=? WHERE id=?', title, row.id);
                    updated++;
                    changedIds.push(row.id);
                    changedColumns.add(row.column_id);
                }
            }
            for (const columnId of changedColumns) s.bump(columnId);
            return { updated, skipped, changedIds };
        }
        if (action === 'binding-rebind') {
            object(data, ['id', 'bindingRevision', 'source'], ['id', 'bindingRevision', 'source']);
            const material = this.material(data.id),
                binding = source(data.source);
            if (material.bindingRevision !== integer(data.bindingRevision)) fail('WORLDBOOK_CONFLICT');
            s.run(
                'UPDATE materials SET source_id=?,entry_uid=?,entry_title=?,revision=revision+1 WHERE id=?',
                s.ensureSource(binding),
                binding.uid,
                binding.title,
                material.id,
            );
            s.run(
                "UPDATE wb_bindings SET lifecycle='active',repair_pending=0,revision=revision+1 WHERE material_id=?",
                material.id,
            );
            s.bump(material.columnId);
            return s.ack(material.id);
        }
        if (action === 'source-rebind') {
            object(data, ['id', 'revision', 'locator'], ['id', 'revision', 'locator']);
            id(data.id);
            text(data.locator, 240, true);
            const current = s.one('SELECT * FROM sources WHERE id=?', data.id);
            if (!current) fail('WORLDBOOK_NOT_FOUND');
            if (current.revision !== integer(data.revision)) fail('WORLDBOOK_CONFLICT');
            if (s.one('SELECT id FROM sources WHERE locator=? AND id<>?', data.locator, current.id))
                fail('WORLDBOOK_SOURCE_COLLISION');
            s.run(
                'UPDATE sources SET locator=?,display_name=?,revision=revision+1 WHERE id=?',
                data.locator,
                data.locator,
                current.id,
            );
            // The explicit continuity decision invalidates all old observations. A
            // successful target read, not this command, classifies each UID.
            s.run(
                'UPDATE wb_bindings SET repair_pending=1,revision=revision+1 WHERE material_id IN(SELECT id FROM materials WHERE source_id=?)',
                current.id,
            );
            return { sourceId: current.id, sourcesChanged: true };
        }
        fail('WORLDBOOK_VALIDATION');
    }
}
