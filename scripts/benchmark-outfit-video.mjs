// Explicit developer benchmark: temporary synthetic data only, no live ST paths.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { createBusiness } from "../src/business/index.js";
import { validateOutfit } from "../src/business/outfit.js";
import { createOutfitVideo } from "../src/outfit-video/index.js";
import { createVideo } from "../src/video/index.js";
import { createWorldbook } from "../src/worldbook/index.js";
import { createReferenceCoordinator } from "../src/governance/coordination.js";
import { validatePolicy } from "../src/config.js";

export function outfitFixture(size) {
    assert.equal(size % 4, 0);
    const assets = [],
        persons = [],
        wearStates = [];
    for (let n = 0; n < size / 4; n++) {
        const personId = `person-${Math.floor(n / 5)}`;
        if (n % 5 === 0)
            persons.push({
                id: personId,
                name: `人物 ${n / 5}`,
                createdAt: "2026-01-01",
                updatedAt: "2026-01-01",
            });
        for (const kind of ["wardrobe", "outfit", "kit", "item"])
            assets.push({
                id: `${kind}-${n}`,
                kind,
                name: `${kind} ${n}`,
                category: "日常",
                tags: ["收藏"],
                sceneTags: [],
                ownerPersonId: personId,
                scope: { type: "global", id: "", label: "全局" },
                mediaRef: null,
                createdAt: "2026-01-01",
                updatedAt: "2026-01-01",
                ...(kind === "wardrobe"
                    ? { outfitIds: [`outfit-${n}`], note: "" }
                    : kind === "outfit"
                      ? {
                            kitIds: [`kit-${n}`],
                            defaultKitId: `kit-${n}`,
                            note: "",
                        }
                      : kind === "kit"
                        ? {
                              itemIds: [`item-${n}`],
                              contextMode: "itemized",
                              overallEffect: "",
                              relationNote: "",
                              summaryDescription: "",
                              note: "",
                          }
                        : {
                              itemType: "clothing",
                              wearSlot: "outer-layer",
                              modelDescription: "测试衣物",
                          }),
            });
        if (n % 5 === 0)
            wearStates.push({
                chatId: `chat-${n}`,
                personId,
                mode: "fixed",
                outfitId: `outfit-${n}`,
                kitId: `kit-${n}`,
                wardrobeIds: [`wardrobe-${n}`],
                extraItemIds: [],
                removedItemIds: [],
                perspectiveRole: "ordinary",
                updatedAt: "2026-01-01",
            });
    }
    const document = { assets, persons, wearStates };
    validateOutfit(document);
    assert(Buffer.byteLength(JSON.stringify(document)) <= 2 * 1024 * 1024);
    return document;
}

const summary = (values) => {
    const sorted = [...values].sort((a, b) => a - b),
        round = (n) => Math.round(n * 1000) / 1000;
    return {
        medianMs: round(sorted[Math.floor(sorted.length / 2)]),
        p95Ms: round(sorted[Math.ceil(sorted.length * 0.95) - 1]),
        samples: sorted.length,
    };
};
const commandId = () => `${Date.now()}-${randomUUID()}`;

export async function benchmark(size, { repetitions = 15 } = {}) {
    const root = await mkdtemp(path.join(tmpdir(), "ttb-video-benchmark-")),
        clips = path.join(root, "clips");
    await mkdir(clips);
    const config = {
        policy: validatePolicy({
            schemaVersion: 1,
            core: { allowedOrigins: ["https://example.invalid"] },
            video: {
                roots: [
                    {
                        key: "clips",
                        label: "测试视频",
                        path: clips,
                        users: ["fixture"],
                    },
                ],
            },
        }),
    };
    const context = {
        userRoot: path.join(root, "fixture"),
        userHandle: "fixture",
        contextId: "a".repeat(32),
    };
    const coordinate = createReferenceCoordinator(),
        video = createVideo(config, { coordinate });
    const business = createBusiness(
        config,
        { metadata: async () => ({}) },
        coordinate,
    );
    const outfit = createOutfitVideo(config, { business, video, coordinate }),
        worldbook = createWorldbook(config, { video, coordinate });
    business.outfitAssetLifecycle = outfit.assetLifecycle;
    const services = [video, business, outfit, worldbook];
    try {
        for (const service of services) await service.definition.initialize();
        video.registerReferenceProvider(worldbook.videoReferenceProvider);
        video.registerReferenceProvider(outfit.referenceProvider);
        const document = outfitFixture(size);
        await business.commit(context, "outfit", 1, 0, document);
        const bytes = Buffer.concat([
            Buffer.from([0, 0, 0, 24]),
            Buffer.from("ftypisom"),
            Buffer.alloc(4),
            Buffer.from("isommp42"),
            Buffer.alloc(64),
        ]);
        for (let n = 0; n < 8; n++)
            await writeFile(path.join(clips, `${n}.mp4`), bytes);
        const page = await video.browse(context, { rootKey: "clips" }),
            videos = [];
        for (const entry of page.entries)
            videos.push(
                await video.register(context, {
                    candidateId: entry.id,
                    operationId: randomUUID(),
                    title: entry.name,
                }),
            );
        video.cancel(context, page.sessionId);
        const mutate = (action, assetId, revision, extras) =>
            outfit.command(context, {
                commandId: commandId(),
                action,
                data: { assetId, revision, ...extras },
            });
        await mutate("add", "item-0", 0, {
            items: videos.slice(0, 6).map((row) => row.mediaRef),
        });
        const target = await outfit.store(context);
        // Instrument existing public composition methods, never production source.
        let trace = null;
        const wrap = (object, key, label) => {
            const original = object[key];
            object[key] = function (...args) {
                const start = performance.now(),
                    captured = trace;
                const finish = () => {
                    if (captured)
                        captured[label] =
                            (captured[label] || 0) + performance.now() - start;
                };
                try {
                    const result = original.apply(this, args);
                    if (result?.then) return result.finally(finish);
                    finish();
                    return result;
                } catch (error) {
                    finish();
                    throw error;
                }
            };
        };
        wrap(business, "read", "businessSnapshotValidation");
        for (const [key, label] of [
            ["read", "relationRead"],
            ["execute", "relationTransaction"],
            ["reconcile", "ownerReconcile"],
            ["references", "indexedReferences"],
        ])
            wrap(target, key, label);
        wrap(video, "validateReference", "videoValidation");
        const measure = async (fn) => {
            for (let n = 0; n < 3; n++) await fn();
            const samples = [],
                details = {};
            for (let n = 0; n < repetitions; n++) {
                trace = {};
                const start = performance.now();
                await fn();
                samples.push(performance.now() - start);
                for (const [key, value] of Object.entries(trace))
                    (details[key] ||= []).push(value);
                trace = null;
            }
            return {
                ...summary(samples),
                components: Object.fromEntries(
                    Object.entries(details).map(([key, values]) => [
                        key,
                        summary(values),
                    ]),
                ),
            };
        };
        const json = JSON.stringify(document);
        // Independent component microbenchmarks are not an additive accounting.
        const parse = await measure(() => JSON.parse(json));
        const validation = await measure(() => validateOutfit(document));
        const ownerExists = await measure(() =>
            assert(
                document.assets.some(
                    (row) => row.id === `item-${size / 4 - 1}`,
                ),
            ),
        );
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(
            path.join(
                context.userRoot,
                "tavern-toolbox-server/business-v1/collections.sqlite",
            ),
            { readOnly: true },
        );
        const rawRead = await measure(
            () =>
                db
                    .prepare(
                        "SELECT document FROM collections WHERE namespace=?",
                    )
                    .get("outfit").document,
        );
        db.close();
        const catalogSnapshot = await measure(() =>
            business.read(context, "outfit", 1),
        );
        const emptyEditor = await measure(() =>
            outfit.read(context, { assetId: "item-1" }),
        );
        const sixVideoEditor = await measure(() =>
            outfit.read(context, { assetId: "item-0" }),
        );
        let added,
            emptyRevision = 0;
        const addSamples = [],
            unlinkSamples = [],
            addComponents = [],
            unlinkComponents = [];
        for (let n = 0; n < repetitions; n++) {
            trace = {};
            let start = performance.now();
            added = await mutate("add", "item-1", emptyRevision, {
                items: [videos[6].mediaRef],
            });
            addSamples.push(performance.now() - start);
            addComponents.push(trace);
            trace = {};
            start = performance.now();
            const removed = await mutate(
                "unlink",
                "item-1",
                added.relation.revision,
                { attachmentId: added.relation.attachments[0].id },
            );
            unlinkSamples.push(performance.now() - start);
            unlinkComponents.push(trace);
            emptyRevision = removed.relation.revision;
            trace = null;
        }
        const phases = (rows) =>
            Object.fromEntries(
                [...new Set(rows.flatMap(Object.keys))].map((key) => [
                    key,
                    summary(rows.map((row) => row[key] || 0)),
                ]),
            );
        const zeroReferences = await measure(async () =>
            assert.equal(
                (await video.references(context, videos[6].mediaRef.assetId))
                    .count,
                0,
            ),
        );
        const oneReference = await measure(async () =>
            assert.equal(
                (await video.references(context, videos[0].mediaRef.assetId))
                    .count,
                1,
            ),
        );
        await worldbook.command(context, {
            commandId: commandId(),
            action: "column-create",
            data: {
                profile: {
                    title: "测试",
                    description: "",
                    icon: { type: "builtin", value: "book" },
                    accent: "#567aa0",
                },
                materials: [
                    {
                        name: "测试资料",
                        description: "",
                        source: {
                            locator: "测试世界书",
                            uid: 1,
                            title: "测试条目",
                        },
                    },
                ],
            },
        });
        const material = (
            await worldbook.read(context, "catalog", { page: 1, tags: [] })
        ).items[0];
        await worldbook.videoCommand(context, {
            commandId: commandId(),
            action: "video-add",
            data: {
                id: material.id,
                revision: 1,
                items: [{ kind: "video", mediaRef: videos[0].mediaRef }],
            },
        });
        const mixedReferences = await measure(async () =>
            assert.equal(
                (await video.references(context, videos[0].mediaRef.assetId))
                    .count,
                2,
            ),
        );
        assert.equal((await business.read(context, "outfit", 1)).revision, 1);
        return {
            size,
            jsonBytes: Buffer.byteLength(json),
            persons: document.persons.length,
            wearStates: document.wearStates.length,
            rawRead,
            parse,
            validation,
            ownerExists,
            catalogSnapshot,
            emptyEditor,
            sixVideoEditor,
            add: { ...summary(addSamples), components: phases(addComponents) },
            unlink: {
                ...summary(unlinkSamples),
                components: phases(unlinkComponents),
            },
            zeroReferences,
            oneReference,
            mixedReferences,
        };
    } finally {
        for (const service of services.reverse())
            await service.definition.shutdown();
        await rm(root, { recursive: true, force: true });
    }
}

if (
    process.argv[1] &&
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
    const results = [];
    for (const size of [100, 1000, 5000]) results.push(await benchmark(size));
    console.log(
        JSON.stringify(
            {
                node: process.version,
                platform: process.platform,
                timing: "wall-clock milliseconds; 3 warmups and 15 samples; independent components are not additive; local synthetic storage, not NAS",
                results,
            },
            null,
            2,
        ),
    );
}
