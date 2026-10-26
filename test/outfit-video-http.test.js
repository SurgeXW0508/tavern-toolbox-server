import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createCore } from "../src/core.js";
import { attachOutfitVideoRoutes } from "../src/outfit-video/routes.js";
import { OutfitVideoFailure } from "../src/outfit-video/store.js";
test("Outfit HTTP distinguishes a full relation conflict from exhausted receipts or storage", async (t) => {
    const origin = "https://example.invalid",
        app = express(),
        router = express.Router();
    let code;
    app.use(express.json());
    app.use((req, res, next) => {
        req.session = { csrfToken: "fixture-csrf" };
        res.locals.ttbRequest = {
            context: { contextId: "fixture" },
            requestId: "request",
            start: 0,
        };
        next();
    });
    attachOutfitVideoRoutes(router, {
        outfitVideo: {
            command: async () => {
                throw new OutfitVideoFailure(code);
            },
        },
        registry: {
            snapshot: async () => ({
                capabilities: [
                    {
                        id: "outfit.video",
                        moduleId: "outfit-video",
                        operations: [{ id: "command", available: true }],
                    },
                ],
            }),
        },
        config: { policy: { core: { allowedOrigins: [origin] } } },
        send: (res, status, data) => res.status(status).json(data),
        failure: (errorCode) => ({ code: errorCode }),
        logger: {},
        now: Date.now,
    });
    app.use(router);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });
    for (const [errorCode, status] of [
        ["OUTFIT_VIDEO_CAPACITY", 409],
        ["OUTFIT_VIDEO_RECEIPTS_FULL", 503],
        ["OUTFIT_VIDEO_STORAGE_CAPACITY", 503],
    ]) {
        code = errorCode;
        const response = await fetch(
            "http://127.0.0.1:" +
                server.address().port +
                "/v1/outfit/video/commands",
            {
                method: "POST",
                headers: {
                    Origin: origin,
                    "Content-Type": "application/json",
                    "X-CSRF-Token": "fixture-csrf",
                    "X-TTB-Protocol": "1.0",
                    "X-TTB-Context": "fixture",
                },
                body: "{}",
            },
        );
        assert.equal(response.status, status);
        assert.equal((await response.json()).code, errorCode);
    }
});
test("Optional Outfit Video HTTP enforces Origin, CSRF, context, bounded DTOs and isolates Business/other users with roots disabled", async (t) => {
    const root = await mkdtemp(path.join(tmpdir(), "outfit-video-http-")),
        logs = [],
        origin = "https://example.invalid",
        core = await createCore({
            policyOptions: {
                configPath: "/fixture/config",
                read: async () =>
                    JSON.stringify({
                        schemaVersion: 1,
                        core: { allowedOrigins: [origin] },
                    }),
            },
            logger: {
                info: (row) => logs.push(row),
                error: (row) => logs.push(row),
            },
        }),
        app = express(),
        router = express.Router();
    app.use(express.json({ limit: "3mb" }));
    app.use((req, _res, next) => {
        const user = req.get("X-Test-User") || "alice";
        if (user !== "none")
            req.user = {
                profile: { handle: user, enabled: true },
                directories: { root: path.join(root, user) },
            };
        req.session = { csrfToken: "fixture-csrf" };
        next();
    });
    core.attach(router);
    app.use(router);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
        await core.shutdown();
        await rm(root, { recursive: true, force: true });
    });
    const base = "http://127.0.0.1:" + server.address().port,
        headers = {
            "X-TTB-Protocol": "1.0",
            "Content-Type": "application/json",
            "X-CSRF-Token": "fixture-csrf",
            Origin: origin,
        };
    const status = await (await fetch(base + "/v1/status", { headers })).json();
    headers["X-TTB-Context"] = status.data.contextId;
    assert.equal(
        status.data.capabilities
            .find((row) => row.id === "outfit.video")
            .operations.find((row) => row.id === "command").available,
        true,
    );
    assert.equal(
        status.data.capabilities
            .find((row) => row.id === "video.catalog")
            .operations.find((row) => row.id === "list").available,
        false,
    );
    const request = async (route, data, extra = {}, method = "POST") => {
        const response = await fetch(base + route, {
            method,
            headers: { ...headers, ...extra },
            body: JSON.stringify(data),
        });
        return {
            status: response.status,
            body: await response.json(),
            headers: response.headers,
        };
    };
    const document = {
        assets: [
            {
                id: "item",
                kind: "item",
                name: "外套",
                category: "",
                tags: [],
                sceneTags: [],
                ownerPersonId: "",
                scope: { type: "global", id: "", label: "全局" },
                mediaRef: null,
                createdAt: "2026-01-01",
                updatedAt: "2026-01-01",
                itemType: "clothing",
                wearSlot: "outer-layer",
                modelDescription: "正文不含视频",
            },
        ],
        persons: [],
        wearStates: [],
    };
    assert.equal(
        (
            await request(
                "/v1/business/collections/outfit",
                { schemaVersion: 1, revision: 0, document },
                {},
                "PUT",
            )
        ).status,
        200,
    );
    const read = () => request("/v1/outfit/video/read", { assetId: "item" });
    assert.deepEqual((await read()).body.data, {
        assetId: "item",
        revision: 0,
        attachments: [],
    });
    for (const [extra, code] of [
        [{ "X-CSRF-Token": "wrong" }, 403],
        [{ Origin: "https://wrong.invalid" }, 403],
        [{ "X-TTB-Context": "wrong" }, 409],
        [{ "X-Test-User": "bob" }, 409],
        [{ "X-Test-User": "none" }, 403],
    ])
        assert.equal(
            (await request("/v1/outfit/video/read", { assetId: "item" }, extra))
                .status,
            code,
        );
    assert.equal(
        (await request("/v1/outfit/video/read?extra=1", { assetId: "item" }))
            .status,
        400,
    );
    assert.equal(
        (await request("/v1/outfit/video/read", { assetId: "item", extra: 1 }))
            .status,
        400,
    );
    const command = (action, data) => ({
        commandId: Date.now() + "-" + randomUUID(),
        action,
        data: { assetId: "item", revision: 0, ...data },
    });
    const malformed = await request(
        "/v1/outfit/video/commands",
        command("add", {
            items: [
                {
                    provider: "server",
                    assetId: "11111111-1111-1111-8111-111111111111",
                },
            ],
        }),
    );
    assert.equal(malformed.status, 400);
    assert.equal(
        (
            await request(
                "/v1/outfit/video/commands",
                command("add", {
                    items: [{ provider: "server", assetId: randomUUID() }],
                }),
            )
        ).status,
        422,
    );
    const input = command("reorder", { attachmentIds: [] }),
        saved = await request("/v1/outfit/video/commands", input);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.data.relation.revision, 1);
    assert.equal(
        (await request("/v1/outfit/video/commands", input)).body.data.replayed,
        true,
    );
    const receipt = await request("/v1/outfit/video/operation", {
        commandId: input.commandId,
    });
    assert.equal(receipt.body.data.found, true);
    assert.equal(receipt.body.data.result.relation.revision, 1);
    assert.equal(receipt.headers.get("cache-control"), "no-store");
    const business = await (
        await fetch(base + "/v1/business/collections/outfit?schemaVersion=1", {
            headers,
        })
    ).json();
    assert.equal(business.data.revision, 1);
    assert.deepEqual(business.data.document, document);
    assert.equal(JSON.stringify(logs).includes("正文不含视频"), false);
});
