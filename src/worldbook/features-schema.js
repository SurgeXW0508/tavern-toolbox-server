// One atomic upgrade; the v1 tables and every existing identity stay in place.
export function migrateWorldbookFeatures(db) {
    if (db.prepare('PRAGMA user_version').get().user_version === 1) {
        db.exec(`BEGIN IMMEDIATE;
            CREATE TABLE wb_bindings(material_id TEXT PRIMARY KEY REFERENCES materials(id) ON DELETE CASCADE,
                lifecycle TEXT NOT NULL CHECK(lifecycle IN('active','detached')), revision INTEGER NOT NULL, repair_pending INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE wb_usage(material_id TEXT PRIMARY KEY REFERENCES materials(id) ON DELETE CASCADE,
                enable_count INTEGER NOT NULL DEFAULT 0, last_enabled_at INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE wb_relation_versions(material_id TEXT PRIMARY KEY REFERENCES materials(id) ON DELETE CASCADE, revision INTEGER NOT NULL);
            CREATE TABLE wb_companions(subject_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
                companion_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
                PRIMARY KEY(subject_id,companion_id), CHECK(subject_id<>companion_id));
            CREATE INDEX wb_companion_incoming ON wb_companions(companion_id,subject_id);
            CREATE TABLE wb_presets(id TEXT PRIMARY KEY, column_id TEXT REFERENCES columns(id) ON DELETE CASCADE,
                name TEXT NOT NULL, revision INTEGER NOT NULL);
            CREATE UNIQUE INDEX wb_preset_names ON wb_presets(coalesce(column_id,''),wb_fold(name));
            CREATE TABLE wb_preset_members(preset_id TEXT NOT NULL REFERENCES wb_presets(id) ON DELETE CASCADE,
                material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE, PRIMARY KEY(preset_id,material_id));
            CREATE INDEX wb_preset_material ON wb_preset_members(material_id,preset_id);
            INSERT INTO wb_bindings(material_id,lifecycle,revision) SELECT id,'active',1 FROM materials;
            INSERT INTO wb_usage(material_id) SELECT id FROM materials;
            INSERT INTO wb_relation_versions SELECT id,1 FROM materials;
            CREATE TRIGGER wb_material_insert AFTER INSERT ON materials BEGIN
                INSERT INTO wb_bindings(material_id,lifecycle,revision) VALUES(NEW.id,'active',1);
                INSERT INTO wb_usage(material_id) VALUES(NEW.id);
                INSERT INTO wb_relation_versions VALUES(NEW.id,1);
            END;
            CREATE TRIGGER wb_material_move AFTER UPDATE OF column_id ON materials WHEN NEW.column_id<>OLD.column_id BEGIN
                UPDATE wb_presets SET revision=revision+1 WHERE column_id=OLD.column_id AND id IN(SELECT preset_id FROM wb_preset_members WHERE material_id=NEW.id);
                DELETE FROM wb_preset_members WHERE material_id=NEW.id AND preset_id IN(SELECT id FROM wb_presets WHERE column_id=OLD.column_id);
            END;
            CREATE TRIGGER wb_material_delete BEFORE DELETE ON materials BEGIN
                UPDATE wb_presets SET revision=revision+1 WHERE id IN(SELECT preset_id FROM wb_preset_members WHERE material_id=OLD.id);
                UPDATE wb_relation_versions SET revision=revision+1 WHERE material_id IN(SELECT subject_id FROM wb_companions WHERE companion_id=OLD.id);
            END;
            PRAGMA user_version=2;
            COMMIT;`);
    }
    for (const name of [
        'wb_bindings',
        'wb_usage',
        'wb_relation_versions',
        'wb_companions',
        'wb_presets',
        'wb_preset_members',
    ])
        db.prepare(`SELECT * FROM ${name} LIMIT 0`).all();
}
