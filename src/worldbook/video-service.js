import { VIDEO_COMMANDS } from "./video.js";
import { object, id, fail, commandToken } from "./validation.js";
const resultView = (result) => ({
    id: result.id,
    video: result.video,
    replayed: result.replayed,
});
export function attachWorldbookVideo(
    api,
    { store, video, coordinate, config, now },
) {
    api.videoDefinition = {
        id: "worldbook-video",
        version: "0.1.0",
        dependsOn: ["core", "worldbook"],
        capabilities: [
            {
                id: "worldbook.video",
                contract: { major: 1, minMinor: 0, maxMinor: 0 },
                operations: ["read", "command", "operation"].map((id) => ({
                    id,
                    available: true,
                })),
                operationAvailability: () => Object.fromEntries(
                    ["read", "command", "operation"].map(operation => [operation, {
                        available: config.policy.core.allowedOrigins.length > 0,
                        reasonCode: "ORIGIN_POLICY_MISSING",
                    }]),
                ),
                limits: { maxAttachments: 6, maxReadMaterials: 20 },
                constraints: {
                    kinds: ["video"],
                    revision: "material-video-cas",
                    mediaRefProvider: "server",
                },
            },
        ],
        health: async (context) => {
            await store(context);
            return { state: "ready", reasonCode: null };
        },
    };
    api.readVideo = async (context, input) => {
        object(input, ["materialIds"], ["materialIds"]);
        if (
            !Array.isArray(input.materialIds) ||
            !input.materialIds.length ||
            input.materialIds.length > 20 ||
            new Set(input.materialIds).size !== input.materialIds.length
        )
            fail("WORLDBOOK_VALIDATION");
        const target = await store(context);
        return {
            items: input.materialIds.map((value) =>
                target.video.read(id(value)),
            ),
        };
    };
    api.videoOperation = async (context, input) => {
        object(input, ["commandId"], ["commandId"]);
        commandToken(input.commandId, now());
        const target = await store(context),
            receipt = target.one(
                "SELECT response FROM commands WHERE id=?",
                input.commandId,
            );
        if (!receipt) return { found: false };
        const result = JSON.parse(receipt.response);
        if (!result.video) fail("WORLDBOOK_VALIDATION");
        return { found: true, result: resultView(result) };
    };
    api.videoCommand = (context, input) =>
        coordinate(context, async () => {
            object(
                input,
                ["commandId", "action", "data"],
                ["commandId", "action", "data"],
            );
            if (!VIDEO_COMMANDS.has(input.action)) fail("WORLDBOOK_VALIDATION");
            const target = await store(context);
            if (
                typeof input.commandId === "string" &&
                target.one(
                    "SELECT id FROM commands WHERE id=?",
                    input.commandId,
                )
            )
                return resultView(
                    target.execute(input, { videoValidated: true }),
                );
            const refs = target.video.validate(input.action, input.data);
            if (
                target.video.read(input.data.id).revision !==
                input.data.revision
            )
                fail("WORLDBOOK_VIDEO_CONFLICT");
            // Only existence/authorization: temporary source outages do not destroy relationships.
            for (const ref of refs) {
                try {
                    if (!video) fail("WORLDBOOK_VIDEO_UNAVAILABLE");
                    await video.validateReference(context, ref.assetId);
                } catch {
                    fail("WORLDBOOK_VIDEO_UNAVAILABLE");
                }
            }
            return resultView(target.execute(input, { videoValidated: true }));
        });
    api.videoReferenceProvider = {
        id: "worldbook",
        enumerate: async (context, videoId) =>
            (await store(context)).video.references(videoId),
    };
}
