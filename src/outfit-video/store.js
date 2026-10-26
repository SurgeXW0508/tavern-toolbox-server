import path from "node:path";
import { mkdir } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
export class OutfitVideoFailure extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}
export const fail = (code) => {
    throw new OutfitVideoFailure(code);
};
export function object(value, keys, required = keys) {
    if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => !keys.includes(key)) ||
        required.some((key) => !Object.hasOwn(value, key))
    )
        fail("OUTFIT_VIDEO_VALIDATION");
}
export function assetId(value) {
    if (
        typeof value !== "string" ||
        !/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(value)
    )
        fail("OUTFIT_VIDEO_VALIDATION");
    return value;
}
export function uuid(value) {
    if (
        typeof value !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            value,
        )
    )
        fail("OUTFIT_VIDEO_VALIDATION");
    return value;
}
export function mediaRef(value) {
    object(value, ["provider", "assetId"]);
    if (value.provider !== "server") fail("OUTFIT_VIDEO_VALIDATION");
    return { provider: "server", assetId: uuid(value.assetId) };
}
const TTL = 7 * 86400000,
    MAX_RECEIPTS = 10000;
export function commandId(value, now) {
    if (typeof value !== "string" || !/^\d{13}-[0-9a-f-]{36}$/.test(value))
        fail("OUTFIT_VIDEO_VALIDATION");
    uuid(value.slice(14));
    const time = Number(value.slice(0, 13));
    if (time > now + 300000 || time < now - TTL)
        fail("OUTFIT_VIDEO_COMMAND_EXPIRED");
    return value;
}
export function validateCommand(input, now) {
    object(input, ["commandId", "action", "data"]);
    commandId(input.commandId, now);
    const actions = {
        add: ["items"],
        replace: ["attachmentId", "mediaRef"],
        reorder: ["attachmentIds"],
        unlink: ["attachmentId"],
    };
    if (
        typeof input.action !== "string" ||
        !Object.hasOwn(actions, input.action)
    )
        fail("OUTFIT_VIDEO_VALIDATION");
    const extras = actions[input.action];
    const d = input.data;
    object(d, ["assetId", "revision", ...extras]);
    assetId(d.assetId);
    if (
        !Number.isSafeInteger(d.revision) ||
        d.revision < 0 ||
        d.revision >= Number.MAX_SAFE_INTEGER
    )
        fail("OUTFIT_VIDEO_VALIDATION");
    if ("attachmentId" in d) uuid(d.attachmentId);
    if (input.action === "replace") return [mediaRef(d.mediaRef)];
    if (input.action === "add") {
        if (!Array.isArray(d.items) || !d.items.length || d.items.length > 6)
            fail("OUTFIT_VIDEO_VALIDATION");
        return d.items.map(mediaRef);
    }
    if (input.action === "reorder") {
        if (
            !Array.isArray(d.attachmentIds) ||
            d.attachmentIds.length > 6 ||
            new Set(d.attachmentIds).size !== d.attachmentIds.length
        )
            fail("OUTFIT_VIDEO_VALIDATION");
        d.attachmentIds.forEach(uuid);
    }
    return [];
}
export class OutfitVideoStore {
    constructor(userRoot, DatabaseSync, now = Date.now) {
        this.root = path.join(
            userRoot,
            "tavern-toolbox-server",
            "outfit-video-v1",
        );
        this.DatabaseSync = DatabaseSync;
        this.now = now;
    }
    async initialize() {
        await mkdir(this.root, { recursive: true, mode: 0o700 });
        const db = new this.DatabaseSync(
            path.join(this.root, "relations.sqlite"),
        );
        try {
            db.exec(
                "PRAGMA busy_timeout=3000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;",
            );
            const version = db
                .prepare("PRAGMA user_version")
                .get().user_version;
            if (version > 1) fail("OUTFIT_VIDEO_STORAGE_INCOMPATIBLE");
            if (!version) {
                if (
                    db
                        .prepare(
                            "SELECT COUNT(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
                        )
                        .get().n
                )
                    fail("OUTFIT_VIDEO_STORAGE_INCOMPATIBLE");
                db.exec(`BEGIN IMMEDIATE;
                    CREATE TABLE owners(asset_id TEXT PRIMARY KEY,revision INTEGER NOT NULL);
                    CREATE TABLE attachments(id TEXT PRIMARY KEY,asset_id TEXT NOT NULL REFERENCES owners(asset_id) ON DELETE CASCADE,video_id TEXT NOT NULL,position INTEGER NOT NULL CHECK(position>=0),UNIQUE(asset_id,video_id));
                    CREATE INDEX video_target ON attachments(video_id,asset_id);
                    CREATE TABLE commands(id TEXT PRIMARY KEY,hash TEXT NOT NULL,result TEXT NOT NULL,created_at INTEGER NOT NULL);
                    PRAGMA user_version=1; COMMIT;`);
            }
            for (const table of ["owners", "attachments", "commands"])
                db.prepare(`SELECT * FROM ${table} LIMIT 0`).all();
            this.db = db;
        } catch (error) {
            try {
                db.exec("ROLLBACK");
            } catch {}
            db.close();
            throw error;
        }
    }
    read(id) {
        return {
            assetId: id,
            revision:
                this.db
                    .prepare("SELECT revision FROM owners WHERE asset_id=?")
                    .get(id)?.revision || 0,
            attachments: this.db
                .prepare(
                    "SELECT * FROM attachments WHERE asset_id=? ORDER BY position,id",
                )
                .all(id)
                .map((row) => ({
                    id: row.id,
                    position: row.position,
                    kind: "video",
                    mediaRef: { provider: "server", assetId: row.video_id },
                })),
        };
    }
    receipt(id, input) {
        const row = this.db
            .prepare("SELECT * FROM commands WHERE id=?")
            .get(id);
        if (!row) return null;
        if (
            input &&
            row.hash !==
                createHash("sha256").update(JSON.stringify(input)).digest("hex")
        )
            fail("OUTFIT_VIDEO_IDEMPOTENCY_MISMATCH");
        return { ...JSON.parse(row.result), replayed: true };
    }
    // Only removes owners already absent from a fresh, validated Business snapshot.
    // Called before an asset-set change and after its successful Business commit.
    reconcile(assets) {
        const live = new Set(assets.map((row) => row.id)),
            owners = this.db
                .prepare("SELECT asset_id FROM owners LIMIT 5001")
                .all();
        if (owners.length > 5000) fail("OUTFIT_VIDEO_STORAGE_CAPACITY");
        const orphaned = owners.filter((row) => !live.has(row.asset_id));
        if (!orphaned.length) return;
        this.db.exec("BEGIN IMMEDIATE");
        try {
            for (const row of orphaned)
                this.db
                    .prepare("DELETE FROM owners WHERE asset_id=?")
                    .run(row.asset_id);
            this.db.exec("COMMIT");
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    execute(input) {
        const { data: d, action } = input,
            previous = this.read(d.assetId);
        if (previous.revision !== d.revision) fail("OUTFIT_VIDEO_CONFLICT");
        let rows = previous.attachments.map((row) => ({ ...row }));
        const index = rows.findIndex((row) => row.id === d.attachmentId);
        if (["replace", "unlink"].includes(action) && index < 0)
            fail("OUTFIT_VIDEO_NOT_FOUND");
        if (action === "add")
            rows.push(
                ...d.items.map((ref) => ({
                    id: randomUUID(),
                    kind: "video",
                    mediaRef: ref,
                })),
            );
        if (action === "replace") rows[index].mediaRef = d.mediaRef;
        if (action === "unlink") rows.splice(index, 1);
        if (action === "reorder") {
            if (
                d.attachmentIds.length !== rows.length ||
                d.attachmentIds.some((id) => !rows.some((row) => row.id === id))
            )
                fail("OUTFIT_VIDEO_VALIDATION");
            rows = d.attachmentIds.map((id) =>
                rows.find((row) => row.id === id),
            );
        }
        if (rows.length > 6) fail("OUTFIT_VIDEO_CAPACITY");
        if (
            new Set(rows.map((row) => row.mediaRef.assetId)).size !==
            rows.length
        )
            fail("OUTFIT_VIDEO_DUPLICATE");
        const result = {
            relation: {
                assetId: d.assetId,
                revision: previous.revision + 1,
                attachments: rows.map((row, position) => ({
                    ...row,
                    position,
                })),
            },
            replayed: false,
        };
        this.db.exec("BEGIN IMMEDIATE");
        try {
            this.db
                .prepare("DELETE FROM commands WHERE created_at<?")
                .run(this.now() - TTL);
            if (
                this.db.prepare("SELECT COUNT(*) n FROM commands").get().n >=
                MAX_RECEIPTS
            )
                fail("OUTFIT_VIDEO_RECEIPTS_FULL");
            this.db
                .prepare(
                    "INSERT INTO owners VALUES(?,?) ON CONFLICT(asset_id) DO UPDATE SET revision=excluded.revision",
                )
                .run(d.assetId, result.relation.revision);
            this.db
                .prepare("DELETE FROM attachments WHERE asset_id=?")
                .run(d.assetId);
            for (const row of result.relation.attachments)
                this.db
                    .prepare("INSERT INTO attachments VALUES(?,?,?,?)")
                    .run(row.id, d.assetId, row.mediaRef.assetId, row.position);
            this.db
                .prepare("INSERT INTO commands VALUES(?,?,?,?)")
                .run(
                    input.commandId,
                    createHash("sha256")
                        .update(JSON.stringify(input))
                        .digest("hex"),
                    JSON.stringify(result),
                    this.now(),
                );
            this.db.exec("COMMIT");
            return result;
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    references(videoId, assets) {
        const live = new Map(assets.map((row) => [row.id, row]));
        const rows = this.db
            .prepare(
                "SELECT asset_id,video_id FROM attachments WHERE video_id=? LIMIT 30001",
            )
            .all(videoId);
        if (rows.length > 30000) fail("OUTFIT_VIDEO_STORAGE_CAPACITY");
        const labels = {
            wardrobe: "场景组",
            outfit: "穿搭组合",
            kit: "具体搭配",
            item: "单品",
        };
        return rows.flatMap((row) => {
            const owner = live.get(row.asset_id);
            return owner
                ? [
                      {
                          videoId: row.video_id,
                          ownerId: owner.id,
                          label: `穿搭 · ${owner.name}（${labels[owner.kind]}）`,
                      },
                  ]
                : [];
        });
    }
    close() {
        this.db?.close();
    }
}
