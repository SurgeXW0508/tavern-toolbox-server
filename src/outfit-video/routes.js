import { mutationGate } from "../security.js";
import { OutfitVideoFailure, fail } from "./store.js";
export function attachOutfitVideoRoutes(
    router,
    { outfitVideo, registry, config, send, failure, logger, now },
) {
    for (const [operation, path] of [
        ["read", "read"],
        ["command", "commands"],
        ["operation", "operation"],
    ])
        router.post("/v1/outfit/video/" + path, async (req, res) => {
            const { context, requestId, start } = res.locals.ttbRequest;
            let code = "OK";
            try {
                if (req.get("X-TTB-Protocol") !== "1.0")
                    fail("PROTOCOL_INCOMPATIBLE");
                if (req.get("X-TTB-Context") !== context.contextId)
                    fail("CONTEXT_CHANGED");
                if (!mutationGate(req, config.policy.core.allowedOrigins))
                    fail("CSRF_REJECTED");
                if (
                    Object.keys(req.query).length ||
                    !/^application\/json(?:\s*;|\s*$)/i.test(
                        req.headers["content-type"] || "",
                    )
                )
                    fail("OUTFIT_VIDEO_VALIDATION");
                const cap = (
                    await registry.snapshot(context)
                ).capabilities.find((row) => row.id === "outfit.video");
                if (
                    cap?.moduleId !== "outfit-video" ||
                    cap.operations.find((row) => row.id === operation)
                        ?.available !== true
                )
                    fail("OUTFIT_VIDEO_UNAVAILABLE");
                let input = req.body;
                if (input === undefined) {
                    let size = 0;
                    const chunks = [];
                    for await (const chunk of req) {
                        size += chunk.length;
                        if (size > 8192) fail("OUTFIT_VIDEO_VALIDATION");
                        chunks.push(chunk);
                    }
                    try {
                        input = JSON.parse(Buffer.concat(chunks));
                    } catch {
                        fail("OUTFIT_VIDEO_VALIDATION");
                    }
                }
                if (Buffer.byteLength(JSON.stringify(input) || "") > 8192)
                    fail("OUTFIT_VIDEO_VALIDATION");
                const result = await outfitVideo[operation](context, input);
                if (!res.destroyed)
                    send(res, 200, result, requestId, true, 65536);
            } catch (error) {
                code =
                    error instanceof OutfitVideoFailure
                        ? error.code
                        : "OUTFIT_VIDEO_UNAVAILABLE";
                const status =
                    code === "OUTFIT_VIDEO_VALIDATION"
                        ? 400
                        : code === "OUTFIT_VIDEO_NOT_FOUND"
                          ? 404
                          : code === "CSRF_REJECTED"
                            ? 403
                            : code === "OUTFIT_VIDEO_TARGET_UNAVAILABLE"
                              ? 422
                              : [
                                      "OUTFIT_VIDEO_CONFLICT",
                                      "OUTFIT_VIDEO_CAPACITY",
                                      "OUTFIT_VIDEO_DUPLICATE",
                                      "OUTFIT_VIDEO_COMMAND_EXPIRED",
                                      "OUTFIT_VIDEO_IDEMPOTENCY_MISMATCH",
                                      "CONTEXT_CHANGED",
                                      "PROTOCOL_INCOMPATIBLE",
                                  ].includes(code)
                                ? 409
                                : 503;
                if (!res.destroyed)
                    send(
                        res,
                        status,
                        failure(code, "穿搭视频关联操作未完成。"),
                        requestId,
                        true,
                        4096,
                    );
            } finally {
                logger.info?.({
                    service: "tavern-toolbox-server",
                    time: new Date().toISOString(),
                    severity: "info",
                    requestId,
                    moduleId: "outfit-video",
                    operation,
                    durationMs: now() - start,
                    code,
                    outcome: "notApplicable",
                });
            }
        });
}
