# Tavern Toolbox Server

Phase 1 Core for the optional Tavern Toolbox SillyTavern Server Plugin. No media, network fetching, storage database, or background jobs are installed in this release.

## Install for official SillyTavern Web

Use a pinned, reviewed version of this repository in the SillyTavern `plugins/tavern-toolbox-server/` directory. Enable `enableServerPlugins: true` in the persistent SillyTavern configuration and restart SillyTavern. The plugin is discovered by `GET /api/plugins/tavern-toolbox-server/status` after SillyTavern authentication; `GET /api/plugins/tavern-toolbox-server/v1/status` requires `X-TTB-Protocol: 1.0`. The frontend provides **设置 → 服务器与扩展能力**. If the plugin is absent, all existing Toolbox data stays local.

Do not copy user data into the plugin code directory. Phase 1 does not create a database or migrate any data. The plugin works independently of 柏宝库. No CORS or cross-origin TT connection is supported.

Optional administrator configuration lives outside the plugin at `<SillyTavern dataRoot>/tavern-toolbox-server.config.json`; `TAVERN_TOOLBOX_SERVER_CONFIG` can select an explicitly managed absolute config path. A missing default file uses safe defaults; a malformed or explicitly missing file reports `INVALID_CORE_CONFIG` and never silently replaces the administrator's policy. Example:

```json
{"schemaVersion":1,"core":{"maxStatusResponseBytes":262144,"allowedOrigins":[]}}
```

`allowedOrigins` is for a future unsafe-operation gate, not a CORS allowlist. It enables no mutation in Phase 1. Changes take effect on restart. `/status` and `/v1/status` are both authenticated, read-only and `Cache-Control: no-store`; the effective policy summary never returns the origin list or secrets.

SillyTavern's global JSON parser runs before plugin routers and currently accepts very large bodies. Phase 1 has only GET endpoints. Before later write/upload features, deploy an ingress request-body limit and verify it on the real NAS. Node >=20 is the packaging minimum; this phase uses only Node built-ins. Validate the actual NAS Node and ST version in the real installation.

Run `npm run check` for unit and HTTP-contract tests. For real-device review: confirm the Toolbox page in the official Web client displays Core status and only `core.status`, then disable/remove this plugin and confirm the existing Local workflows still work. Test the real TT client separately; mocked tests do not establish real device support. No media data is being backed up by this phase.

## Operator and review notes

1. Pin this development branch to an exact reviewed commit before installing in `plugins/tavern-toolbox-server/`. Install the matching frontend Phase 1 candidate in the official Web client. Confirm the installed SillyTavern loader supports `init(router)` and exit hooks, `req.user.profile.handle` and `req.user.directories.root` in your real version. No separate administrator Web UI exists.
2. Confirm `enableServerPlugins: true`, restart one active SillyTavern instance, sign in to the official Web client, open any module homepage in Toolbox, select **服务器与扩展能力**, and inspect `core.status` only. Refresh once and preview diagnostics before copying; verify no personal path/cookie. Try the other ST account, if configured, to verify separate context IDs.
3. Temporarily disable/remove this plugin, restart, and check that old outfit images, Genesis images, and lorebook editing still use their previous Local paths. Repeat in the actual TT client; TT never connects to this Server directly. Re-enable the plugin and check Docker container restart rotates boot/context IDs without modifying existing data.
4. Check coexistence with installed 柏宝库 on the real NAS. The current plugin ID, route and config filename are dedicated; future data layout is not implemented. Keep the actual ST dataRoot and plugin code volume mounted as intended and check UID/GID; config persistence requires the dataRoot volume. The plugin never writes into its own code folder.

The independent Protocol 1.0 fixture, shape, bounds and errors are documented in `protocol/README.md`. Real NAS/ST middleware, CSRF and device testing remain outstanding until performed on the installed host; the in-process HTTP harness tests the plugin router but does not prove the deployed SillyTavern middleware order. The itemized code-side review and explicit real-host gaps are in `PHASE-1-ACCEPTANCE.md`; this is not a release claim.

## Privacy before publication

See [`docs/PRIVACY-AND-SECURITY.md`](docs/PRIVACY-AND-SECURITY.md). Run `npm run audit:privacy` after every change and before pushing; inspect Git history and the GitHub public surfaces before releasing or changing repository visibility. Never commit real administrator configuration or NAS diagnostics.
