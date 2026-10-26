import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createBusiness, BusinessFailure } from "../src/business/index.js";
import { BusinessStore } from "../src/business/store.js";
import { createVideo } from "../src/video/index.js";
import { createWorldbook } from "../src/worldbook/index.js";
import { createOutfitVideo } from "../src/outfit-video/index.js";
import { OutfitVideoStore } from "../src/outfit-video/store.js";
import { createReferenceCoordinator } from "../src/governance/coordination.js";
import { validatePolicy } from "../src/config.js";
const token = () => Date.now() + "-" + randomUUID();
const asset = (id, kind = "item") => ({
    id,
    kind,
    name: "测试" + id,
    category: "",
    tags: [],
    sceneTags: [],
    ownerPersonId: "",
    scope: { type: "global", id: "", label: "全局" },
    mediaRef: null,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    ...(kind === "item"
        ? {
              itemType: "clothing",
              wearSlot: "outer-layer",
              modelDescription: "模型描述",
          }
        : kind === "wardrobe"
          ? { outfitIds: [], note: "" }
          : kind === "outfit"
            ? { kitIds: [], defaultKitId: "", note: "" }
            : {
                  itemIds: [],
                  contextMode: "itemized",
                  overallEffect: "",
                  relationNote: "",
                  summaryDescription: "",
                  note: "",
              }),
});
async function fixture(t) {
    const root = await mkdtemp(path.join(tmpdir(), "outfit-video-")),
        source = path.join(root, "clips");
    await mkdir(source);
    const config = {
            policy: validatePolicy({
                schemaVersion: 1,
                core: { allowedOrigins: ["https://example.invalid"] },
                video: {
                    roots: [
                        {
                            key: "clips",
                            label: "视频",
                            path: source,
                            users: ["alice"],
                        },
                    ],
                },
            }),
        },
        coordinate = createReferenceCoordinator(),
        context = {
            userRoot: path.join(root, "alice"),
            userHandle: "alice",
            contextId: "a".repeat(32),
        };
    const video = createVideo(config, { coordinate }),
        business = createBusiness(
            config,
            { metadata: async () => ({}) },
            coordinate,
        ),
        relations = createOutfitVideo(config, { business, video, coordinate }),
        worldbook = createWorldbook(config, { video, coordinate });
    business.outfitAssetLifecycle = relations.assetLifecycle;
    for (const api of [video, business, relations, worldbook])
        await api.definition.initialize();
    video.registerReferenceProvider(worldbook.videoReferenceProvider);
    video.registerReferenceProvider(relations.referenceProvider);
    t.after(async () => {
        for (const api of [relations, worldbook, business, video])
            await api.definition.shutdown();
        await rm(root, { recursive: true, force: true });
    });
    let snapshot = await business.commit(context, "outfit", 1, 0, {
        assets: ["item", "wardrobe", "outfit", "kit"].map((kind) =>
            asset(kind, kind),
        ),
        persons: [],
        wearStates: [],
    });
    const bytes = Buffer.concat([
        Buffer.from([0, 0, 0, 24]),
        Buffer.from("ftypisom"),
        Buffer.alloc(4),
        Buffer.from("isommp42"),
        Buffer.alloc(64),
    ]);
    for (let i = 0; i < 7; i++)
        await writeFile(path.join(source, i + ".mp4"), bytes);
    const page = await video.browse(context, { rootKey: "clips" }),
        videos = [];
    for (const row of page.entries)
        videos.push(
            await video.register(context, {
                candidateId: row.id,
                operationId: randomUUID(),
                title: row.name,
            }),
        );
    const command = (action, data, commandId = token()) =>
            relations.command(context, {
                commandId,
                action,
                data: { assetId: "item", ...data },
            }),
        read = () => business.read(context, "outfit", 1),
        commit = async (document) => {
            const current = await read();
            return business.commit(
                context,
                "outfit",
                1,
                current.revision,
                document,
            );
        };
    return {
        root,
        source,
        config,
        coordinate,
        context,
        video,
        business,
        relations,
        worldbook,
        videos,
        snapshot,
        command,
        read,
        commit,
    };
}
test("Receipt capacity rejects atomically with its own code; an expired receipt frees space on a later explicit mutation", async (t) => {
    const h = await fixture(t);
    const saved = await h.command("reorder", {
        revision: 0,
        attachmentIds: [],
    });
    const target = await h.relations.store(h.context);
    const original = target.db.prepare("SELECT * FROM commands LIMIT 1").get();
    target.db.exec("BEGIN IMMEDIATE");
    const insert = target.db.prepare("INSERT INTO commands VALUES(?,?,?,?)");
    for (let n = 1; n < 10000; n++)
        insert.run(token(), original.hash, original.result, Date.now());
    target.db.exec("COMMIT");
    const commandId = token();
    await assert.rejects(
        h.command("reorder", { revision: 1, attachmentIds: [] }, commandId),
        { code: "OUTFIT_VIDEO_RECEIPTS_FULL" },
    );
    assert.deepEqual(
        await h.relations.read(h.context, { assetId: "item" }),
        saved.relation,
    );
    assert.equal(
        (await h.relations.operation(h.context, { commandId })).found,
        false,
    );
    assert.equal(
        target.db.prepare("SELECT COUNT(*) n FROM commands").get().n,
        10000,
    );
    target.db
        .prepare("UPDATE commands SET created_at=0 WHERE id=?")
        .run(original.id);
    assert.equal(
        (await h.command("reorder", { revision: 1, attachmentIds: [] }))
            .relation.revision,
        2,
    );
    assert.equal(
        target.db.prepare("SELECT COUNT(*) n FROM commands").get().n,
        10000,
    );
});
test("All four Outfit kinds have independent Video CAS, stable attachments, bounded unique order and exact receipts", async (t) => {
    const h = await fixture(t);
    for (const kind of ["wardrobe", "outfit", "kit", "item"])
        assert.deepEqual(await h.relations.read(h.context, { assetId: kind }), {
            assetId: kind,
            revision: 0,
            attachments: [],
        });
    const commandId = token(),
        data = {
            revision: 0,
            items: h.videos.slice(0, 6).map((row) => row.mediaRef),
        },
        saved = await h.command("add", data, commandId);
    assert.equal(saved.relation.attachments.length, 6);
    assert.equal(saved.relation.revision, 1);
    assert.equal((await h.command("add", data, commandId)).replayed, true);
    assert.deepEqual(
        (await h.relations.operation(h.context, { commandId })).result.relation,
        saved.relation,
    );
    await assert.rejects(
        h.command("add", { revision: 1, items: [h.videos[6].mediaRef] }),
        { code: "OUTFIT_VIDEO_CAPACITY" },
    );
    await assert.rejects(
        h.command("unlink", {
            revision: 0,
            attachmentId: saved.relation.attachments[0].id,
        }),
        { code: "OUTFIT_VIDEO_CONFLICT" },
    );
    const ids = saved.relation.attachments.map((row) => row.id).reverse(),
        ordered = await h.command("reorder", {
            revision: 1,
            attachmentIds: ids,
        });
    assert.deepEqual(
        ordered.relation.attachments.map((row) => row.id),
        ids,
    );
    await assert.rejects(
        h.command("replace", {
            revision: 2,
            attachmentId: ids[0],
            mediaRef: h.videos[0].mediaRef,
        }),
        { code: "OUTFIT_VIDEO_DUPLICATE" },
    );
    const replaced = await h.command("replace", {
        revision: 2,
        attachmentId: ids[0],
        mediaRef: h.videos[6].mediaRef,
    });
    assert.equal(replaced.relation.attachments[0].id, ids[0]);
    assert.deepEqual(
        replaced.relation.attachments[0].mediaRef,
        h.videos[6].mediaRef,
    );
    const removed = await h.command("unlink", {
        revision: 3,
        attachmentId: ids[0],
    });
    assert.equal(removed.relation.attachments.length, 5);
    assert.equal((await h.read()).revision, 1);
    await assert.rejects(
        h.command(
            "add",
            { revision: 0, items: [h.videos[0].mediaRef] },
            commandId,
        ),
        { code: "OUTFIT_VIDEO_IDEMPOTENCY_MISMATCH" },
    );
});
test("Old Business saves, image, names and membership edits retain Video revision; Video never enters Business JSON", async (t) => {
    const h = await fixture(t);
    const relation = (
        await h.command("add", { revision: 0, items: [h.videos[0].mediaRef] })
    ).relation;
    const doc = structuredClone((await h.read()).document);
    doc.assets[0].name = "新名称";
    doc.assets[0].mediaRef = { provider: "server", assetId: randomUUID() };
    doc.assets.find((row) => row.kind === "kit").itemIds = ["item"];
    await h.commit(doc);
    assert.deepEqual(
        await h.relations.read(h.context, { assetId: "item" }),
        relation,
    );
    assert.deepEqual((await h.read()).document, doc);
    assert.equal(
        JSON.stringify(doc).includes(h.videos[0].mediaRef.assetId),
        false,
    );
    await h.command("unlink", {
        revision: 1,
        attachmentId: relation.attachments[0].id,
    });
    assert.equal((await h.read()).revision, 2);
    assert.deepEqual((await h.read()).document, doc);
});
test("Missing/cross-user targets and malformed commands fail closed; offline existing references can unlink", async (t) => {
    const h = await fixture(t);
    await assert.rejects(
        h.command("add", {
            assetId: "missing",
            revision: 0,
            items: [h.videos[0].mediaRef],
        }),
        { code: "OUTFIT_VIDEO_NOT_FOUND" },
    );
    await assert.rejects(
        h.relations.read(
            {
                ...h.context,
                userRoot: path.join(h.root, "bob"),
                userHandle: "bob",
            },
            { assetId: "item" },
        ),
        { code: "OUTFIT_VIDEO_NOT_FOUND" },
    );
    for (const id of ["not-a-uuid", "11111111-1111-1111-8111-111111111111"])
        await assert.rejects(
            h.command("add", {
                revision: 0,
                items: [{ provider: "server", assetId: id }],
            }),
            { code: "OUTFIT_VIDEO_VALIDATION" },
        );
    await assert.rejects(
        h.command("add", {
            revision: 0,
            items: [{ provider: "server", assetId: randomUUID() }],
        }),
        { code: "OUTFIT_VIDEO_TARGET_UNAVAILABLE" },
    );
    await assert.rejects(
        h.command("add", {
            revision: 0,
            items: [h.videos[0].mediaRef, h.videos[0].mediaRef],
        }),
        { code: "OUTFIT_VIDEO_DUPLICATE" },
    );
    const saved = await h.command("add", {
        revision: 0,
        items: [h.videos[0].mediaRef],
    });
    await rename(h.source, h.source + "-offline");
    await h.command("unlink", {
        revision: 1,
        attachmentId: saved.relation.attachments[0].id,
    });
    assert.equal((await h.video.list(h.context)).total, 7);
});
test("Worldbook + Outfit references both protect Video unregister, including the last remaining consumer", async (t) => {
    const h = await fixture(t),
        ref = h.videos[0].mediaRef;
    await h.worldbook.command(h.context, {
        commandId: token(),
        action: "column-create",
        data: {
            profile: {
                title: "资料",
                description: "",
                icon: { type: "builtin", value: "book" },
                accent: "#123456",
            },
            materials: [
                {
                    name: "角色",
                    source: { locator: "Book", uid: 1, title: "角色" },
                },
            ],
        },
    });
    const store = await h.worldbook.store(h.context),
        id = store.catalog({ page: 1, tags: [] }).items[0].id;
    await h.worldbook.videoCommand(h.context, {
        commandId: token(),
        action: "video-add",
        data: { id, revision: 1, items: [{ kind: "video", mediaRef: ref }] },
    });
    const saved = await h.command("add", { revision: 0, items: [ref] });
    assert.equal((await h.video.references(h.context, ref.assetId)).count, 2);
    await h.worldbook.videoCommand(h.context, {
        commandId: token(),
        action: "video-remove",
        data: { id, revision: 2, assetId: ref.assetId },
    });
    const remove = () =>
        h.video.unregister(h.context, ref.assetId, {
            operationId: randomUUID(),
            metadataRevision: 1,
            sourceRevision: 1,
        });
    await assert.rejects(remove(), { code: "VIDEO_REFERENCED" });
    assert.match(
        (await h.video.references(h.context, ref.assetId)).references[0].label,
        /穿搭.*单品/,
    );
    await h.command("unlink", {
        revision: 1,
        attachmentId: saved.relation.attachments[0].id,
    });
    assert.deepEqual(await remove(), { removed: true });
    h.video.registerReferenceProvider({
        id: "broken",
        enumerate: async () => {
            throw Error("unreadable");
        },
    });
    await assert.rejects(
        h.video.unregister(h.context, h.videos[1].mediaRef.assetId, {
            operationId: randomUUID(),
            metadataRevision: 1,
            sourceRevision: 1,
        }),
        { code: "VIDEO_REFERENCES_INCOMPLETE" },
    );
});
test("Delete serializes with Add; failed Business commits never erase live relations", async (t) => {
    const h = await fixture(t),
        ref = h.videos[0].mediaRef,
        adding = h.command("add", { revision: 0, items: [ref] }),
        deleting = h.commit({ assets: [], persons: [], wearStates: [] });
    await adding;
    await deleting;
    assert.equal((await h.video.references(h.context, ref.assetId)).count, 0);
    await assert.rejects(h.command("add", { revision: 0, items: [ref] }), {
        code: "OUTFIT_VIDEO_NOT_FOUND",
    });
    await h.commit(h.snapshot.document);
    const saved = await h.command("add", { revision: 0, items: [ref] });
    const original = BusinessStore.prototype.commit;
    t.mock.method(BusinessStore.prototype, "commit", function (...args) {
        if (!args[3].assets.length)
            throw new BusinessFailure("BUSINESS_CONFLICT");
        return original.apply(this, args);
    });
    await assert.rejects(
        h.commit({ assets: [], persons: [], wearStates: [] }),
        {
            code: "BUSINESS_CONFLICT",
        },
    );
    assert.deepEqual(
        await h.relations.read(h.context, { assetId: "item" }),
        saved.relation,
    );
});
test("Partial physical cleanup failure cannot create valid ghosts and is recoverable before ID reuse", async (t) => {
    const h = await fixture(t),
        ref = h.videos[0].mediaRef;
    await h.command("add", { revision: 0, items: [ref] });
    const store = await h.relations.store(h.context),
        original = store.reconcile.bind(store);
    let blocked = true;
    store.reconcile = (assets) => {
        if (blocked && !assets.length) throw Error("cleanup write failed");
        return original(assets);
    };
    await h.commit({ assets: [], persons: [], wearStates: [] });
    assert.equal(store.read("item").attachments.length, 1);
    assert.equal((await h.video.references(h.context, ref.assetId)).count, 0);
    await assert.rejects(h.commit(h.snapshot.document), /cleanup write failed/);
    assert.equal((await h.read()).document.assets.length, 0);
    blocked = false;
    await h.commit(h.snapshot.document);
    assert.deepEqual(await h.relations.read(h.context, { assetId: "item" }), {
        assetId: "item",
        revision: 0,
        attachments: [],
    });
    assert.equal((await h.video.list(h.context)).total, 7);
});
test("Outfit Video storage is additive; unknown future schema and failed initialization never reset Business", async (t) => {
    const h = await fixture(t),
        before = await h.read(),
        store = await h.relations.store(h.context);
    store.db.exec("PRAGMA user_version=2");
    store.close();
    await assert.rejects(
        new OutfitVideoStore(h.context.userRoot, DatabaseSync).initialize(),
        { code: "OUTFIT_VIDEO_STORAGE_INCOMPATIBLE" },
    );
    assert.deepEqual(await h.read(), before);
});

test("Cold relation store retains CAS and receipts without touching the Business SQLite schema", async (t) => {
    const h = await fixture(t),
        saved = await h.command("add", {
            revision: 0,
            items: [h.videos[0].mediaRef],
        }),
        second = new OutfitVideoStore(h.context.userRoot, DatabaseSync);
    await second.initialize();
    t.after(() => second.close());
    assert.deepEqual(second.read("item"), saved.relation);
    const db = new DatabaseSync(
        path.join(
            h.context.userRoot,
            "tavern-toolbox-server/business-v1/collections.sqlite",
        ),
    );
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 1);
    assert.deepEqual(
        db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .all()
            .map((row) => row.name),
        ["collections"],
    );
    db.close();
    for (const action of ["__proto__", "constructor", "toString", {}, null])
        await assert.rejects(
            h.relations.command(h.context, {
                commandId: token(),
                action,
                data: { assetId: "item", revision: 1 },
            }),
            { code: "OUTFIT_VIDEO_VALIDATION" },
        );
});

test("Video reference enumeration is read-only; orphan recovery remains inside the user coordinator", async (t) => {
    const h = await fixture(t),
        ref = h.videos[0].mediaRef;
    await h.command("add", { revision: 0, items: [ref] });
    const store = await h.relations.store(h.context);
    let writes = 0;
    const reconcile = store.reconcile.bind(store);
    store.reconcile = () => {
        writes++;
        throw Error("write denied");
    };
    assert.equal((await h.video.references(h.context, ref.assetId)).count, 1);
    assert.equal(writes, 0);
    store.reconcile = reconcile;
});
