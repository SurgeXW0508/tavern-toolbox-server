import {
    OutfitVideoStore,
    fail,
    object,
    assetId,
    commandId,
    validateCommand,
} from "./store.js";
import {
    OUTFIT_NAMESPACE,
    OUTFIT_BUSINESS_SCHEMA,
} from "../business/outfit.js";
export function createOutfitVideo(
    config,
    { business, video, coordinate, now = Date.now },
) {
    const stores = new Map();
    let DatabaseSync,
        stopped = false;
    async function store(context) {
        if (!DatabaseSync || stopped || !context?.userRoot)
            fail("OUTFIT_VIDEO_UNAVAILABLE");
        if (!stores.has(context.userRoot))
            stores.set(
                context.userRoot,
                (async () => {
                    const item = new OutfitVideoStore(
                        context.userRoot,
                        DatabaseSync,
                        now,
                    );
                    await item.initialize();
                    return item;
                })(),
            );
        try {
            return await stores.get(context.userRoot);
        } catch (error) {
            stores.delete(context.userRoot);
            throw error;
        }
    }
    const snapshot = (context) =>
        business.read(context, OUTFIT_NAMESPACE, OUTFIT_BUSINESS_SCHEMA);
    const owner = (document, id) => {
        if (!document.assets.some((row) => row.id === id))
            fail("OUTFIT_VIDEO_NOT_FOUND");
    };
    const api = {
        definition: {
            id: "outfit-video",
            version: "0.1.0",
            dependsOn: ["core", "business"],
            capabilities: [
                {
                    id: "outfit.video",
                    contract: { major: 1, minMinor: 0, maxMinor: 0 },
                    operations: ["read", "command", "operation"].map((id) => ({
                        id,
                        available: true,
                    })),
                    operationAvailability: () =>
                        Object.fromEntries(
                            ["read", "command", "operation"].map((id) => [
                                id,
                                {
                                    available:
                                        config.policy.core.allowedOrigins
                                            .length > 0,
                                    reasonCode: "ORIGIN_POLICY_MISSING",
                                },
                            ]),
                        ),
                    limits: { maxVideosPerAsset: 6, maxReadAssets: 1 },
                    constraints: {
                        provider: "server",
                        relationRevision: "asset-video-cas",
                        storageSchemaVersion: 1,
                    },
                },
            ],
            initialize: async () => {
                ({ DatabaseSync } = await import("node:sqlite"));
            },
            health: async (context) => {
                await store(context);
                return { state: "ready", reasonCode: null };
            },
            shutdown: async () => {
                stopped = true;
                for (const pending of stores.values())
                    try {
                        (await pending).close();
                    } catch {}
                stores.clear();
            },
        },
        store,
        read: (context, input) =>
            coordinate(context, async () => {
                object(input, ["assetId"]);
                assetId(input.assetId);
                const current = await snapshot(context);
                const target = await store(context);
                try {
                    target.reconcile(current.document.assets);
                } catch {
                    /* Cleanup failure does not hide still-live relations. */
                }
                owner(current.document, input.assetId);
                return target.read(input.assetId);
            }),
        command: (context, input) =>
            coordinate(context, async () => {
                const refs = validateCommand(input, now()),
                    target = await store(context),
                    replay = target.receipt(input.commandId, input);
                if (replay) return replay;
                const current = await snapshot(context);
                owner(current.document, input.data.assetId);
                if (
                    target.read(input.data.assetId).revision !==
                    input.data.revision
                )
                    fail("OUTFIT_VIDEO_CONFLICT");
                for (const ref of refs)
                    try {
                        await video.validateReference(context, ref.assetId);
                    } catch {
                        fail("OUTFIT_VIDEO_TARGET_UNAVAILABLE");
                    }
                return target.execute(input);
            }),
        operation: async (context, input) => {
            object(input, ["commandId"]);
            commandId(input.commandId, now());
            const receipt = (await store(context)).receipt(input.commandId);
            return receipt
                ? { found: true, result: receipt }
                : { found: false };
        },
        // Existing ordinary Business metadata/image/wear commits never call these.
        // Before only prunes already-absent owners, so a failed Business CAS cannot
        // destroy any relation belonging to an asset still in that collection.
        assetLifecycle: {
            before: async (context, current) =>
                (await store(context)).reconcile(current.document.assets),
            after: async (context, current) => {
                try {
                    (await store(context)).reconcile(current.document.assets);
                } catch {
                    /* Durable orphan rows are filtered by fresh owner existence and retried on the next asset-set change. */
                }
            },
        },
        referenceProvider: {
            id: "outfit",
            enumerate: async (context, videoId) => {
                const current = await snapshot(context),
                    target = await store(context);
                const result = target.references(
                    videoId,
                    current.document.assets,
                );
                return result;
            },
        },
    };
    return api;
}
