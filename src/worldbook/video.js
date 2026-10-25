import { fail, id, integer, object } from "./validation.js";
import { mediaRef } from "./media.js";
export const VIDEO_COMMANDS = new Set([
    "video-add",
    "video-remove",
    "video-reorder",
    "video-replace",
]);
export function migrateWorldbookVideo(db) {
    if (db.prepare("PRAGMA user_version").get().user_version === 3)
        db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE wb_video_versions(material_id TEXT PRIMARY KEY REFERENCES materials(id) ON DELETE CASCADE, revision INTEGER NOT NULL);
        CREATE TABLE wb_video_attachments(material_id TEXT NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
            video_id TEXT NOT NULL, position INTEGER NOT NULL CHECK(position>=0), PRIMARY KEY(material_id,video_id));
        CREATE INDEX wb_video_target ON wb_video_attachments(video_id,material_id);
        INSERT INTO wb_video_versions SELECT id,1 FROM materials;
        CREATE TRIGGER wb_video_material_insert AFTER INSERT ON materials BEGIN INSERT INTO wb_video_versions VALUES(NEW.id,1); END;
        PRAGMA user_version=4; COMMIT;`);
    db.prepare(
        "SELECT material_id,revision FROM wb_video_versions LIMIT 0",
    ).all();
    db.prepare(
        "SELECT material_id,video_id,position FROM wb_video_attachments LIMIT 0",
    ).all();
}
export class WorldbookVideo {
    constructor(store) {
        this.store = store;
    }
    read(materialId) {
        const version = this.store.one(
            "SELECT revision FROM wb_video_versions WHERE material_id=?",
            id(materialId),
        );
        if (!version) fail("WORLDBOOK_NOT_FOUND");
        return {
            id: materialId,
            revision: version.revision,
            attachments: this.store
                .all(
                    "SELECT video_id,position FROM wb_video_attachments WHERE material_id=? ORDER BY position,video_id",
                    materialId,
                )
                .map((row) => ({
                    kind: "video",
                    position: row.position,
                    mediaRef: { provider: "server", assetId: row.video_id },
                })),
        };
    }
    validate(action, data) {
        const extra = {
            "video-add": ["items"],
            "video-remove": ["assetId"],
            "video-reorder": ["assetIds"],
            "video-replace": ["assetId", "mediaRef"],
        }[action];
        if (!extra) fail("WORLDBOOK_VALIDATION");
        object(
            data,
            ["id", "revision", ...extra],
            ["id", "revision", ...extra],
        );
        id(data.id);
        integer(data.revision, 1);
        const check = (value) =>
            mediaRef({ provider: "server", assetId: value }).assetId;
        if ("assetId" in data) check(data.assetId);
        if (
            action === "video-reorder" &&
            (!Array.isArray(data.assetIds) ||
                data.assetIds.length > 6 ||
                new Set(data.assetIds).size !== data.assetIds.length)
        )
            fail("WORLDBOOK_VALIDATION");
        if (action === "video-reorder") data.assetIds.forEach(check);
        if (action === "video-replace") return [mediaRef(data.mediaRef)];
        if (action !== "video-add") return [];
        if (
            !Array.isArray(data.items) ||
            !data.items.length ||
            data.items.length > 6
        )
            fail("WORLDBOOK_VALIDATION");
        return data.items.map((row) => {
            object(row, ["kind", "mediaRef"], ["kind", "mediaRef"]);
            if (row.kind !== "video") fail("WORLDBOOK_VALIDATION");
            return mediaRef(row.mediaRef);
        });
    }
    mutate(action, data, { videoValidated = false } = {}) {
        this.validate(action, data);
        if (!videoValidated) fail("WORLDBOOK_VIDEO_UNAVAILABLE");
        const current = this.read(data.id);
        if (current.revision !== data.revision)
            fail("WORLDBOOK_VIDEO_CONFLICT");
        let ids = current.attachments.map((row) => row.mediaRef.assetId);
        if (action === "video-add")
            ids.push(...data.items.map((row) => row.mediaRef.assetId));
        if (action === "video-remove" || action === "video-replace") {
            if (!ids.includes(data.assetId)) fail("WORLDBOOK_NOT_FOUND");
            ids = ids.flatMap((value) =>
                value === data.assetId
                    ? action === "video-remove"
                        ? []
                        : [data.mediaRef.assetId]
                    : [value],
            );
        }
        if (action === "video-reorder") {
            if (
                data.assetIds.length !== ids.length ||
                data.assetIds.some((value) => !ids.includes(value))
            )
                fail("WORLDBOOK_VALIDATION");
            ids = data.assetIds;
        }
        if (ids.length > 6) fail("WORLDBOOK_CAPACITY");
        if (new Set(ids).size !== ids.length) fail("WORLDBOOK_DUPLICATE");
        this.store.run(
            "DELETE FROM wb_video_attachments WHERE material_id=?",
            data.id,
        );
        ids.forEach((value, position) =>
            this.store.run(
                "INSERT INTO wb_video_attachments VALUES(?,?,?)",
                data.id,
                value,
                position,
            ),
        );
        this.store.run(
            "UPDATE wb_video_versions SET revision=revision+1 WHERE material_id=?",
            data.id,
        );
        return { id: data.id, video: this.read(data.id) };
    }
    references(videoId) {
        const rows = this.store.all(
            "SELECT r.video_id,r.material_id,m.name,c.title FROM wb_video_attachments r JOIN materials m ON m.id=r.material_id JOIN columns c ON c.id=m.column_id WHERE r.video_id=? LIMIT 30001",
            videoId,
        );
        if (rows.length > 30000) fail("WORLDBOOK_CAPACITY");
        return rows.map((row) => ({
            videoId: row.video_id,
            ownerId: row.material_id,
            label: `${row.title} / ${row.name}`,
        }));
    }
}
