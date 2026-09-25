# Tavern Toolbox Server

Phase 2 development candidate: Phase 1 Core plus an optional safe remote image fetch Network Module. This branch has no Media persistence, database, role-card rewriting or background jobs.

## Install for official SillyTavern Web

Use a pinned, reviewed version of this repository in the SillyTavern `plugins/tavern-toolbox-server/` directory. Enable `enableServerPlugins: true` in the persistent SillyTavern configuration and restart SillyTavern. The plugin is discovered by `GET /api/plugins/tavern-toolbox-server/status` after SillyTavern authentication; `GET /api/plugins/tavern-toolbox-server/v1/status` requires `X-TTB-Protocol: 1.0`. The frontend provides **设置 → 服务器与扩展能力**. If the plugin is absent, all existing Toolbox data stays local.

Do not copy user data into the plugin code directory. Phase 1 does not create a database or migrate any data. The plugin works independently of 柏宝库. No CORS or cross-origin TT connection is supported.

Optional administrator configuration lives outside the plugin at `<SillyTavern dataRoot>/tavern-toolbox-server.config.json`; `TAVERN_TOOLBOX_SERVER_CONFIG` can select an explicitly managed absolute config path. A missing default file uses safe defaults; a malformed or explicitly missing file reports `INVALID_CORE_CONFIG` and never silently replaces the administrator's policy. Example:

```json
{"schemaVersion":1,"core":{"maxStatusResponseBytes":262144,"allowedOrigins":[]}}
```

`allowedOrigins` is the deployment administrator’s exact trusted browser origin list for Network POST, not a CORS allowlist. A missing list disables unsafe operations. Host session CSRF protection must also be active. Changes take effect on restart. `/status` and `/v1/status` are both authenticated, read-only and `Cache-Control: no-store`; the effective policy summary never returns the origin list or secrets.

SillyTavern’s global JSON parser runs before plugin routers; deploy a small ingress request-body limit for the Network POST and verify it on the real NAS. The plugin checks its own unparsed request size, but a host parser may already have accepted a larger body. Node >=20 is the packaging minimum; this phase uses only Node built-ins. Validate the actual NAS Node and ST version in the real installation.

Run `npm run check` for unit and HTTP-contract tests. For real-device review: confirm the Toolbox page in the official Web client displays Core plus the disabled Network capability by default, then disable/remove this plugin and confirm the existing Local workflows still work. Test the real TT client separately; mocked tests do not establish real device support. No media data is being backed up by this phase.

## Operator and review notes

1. Pin this development branch to an exact reviewed commit before installing in `plugins/tavern-toolbox-server/`. Install the matching frontend Phase 2 candidate in the official Web client. Confirm the installed SillyTavern loader supports `init(router)` and exit hooks, `req.user.profile.handle` and `req.user.directories.root` in your real version. No separate administrator Web UI exists.
2. Confirm `enableServerPlugins: true`, restart one active SillyTavern instance, sign in to the official Web client, open any module homepage in Toolbox, select **服务器与扩展能力**, and inspect `core.status` plus `network.remoteFetch` (disabled until the administrator enables it). Refresh once and preview diagnostics before copying; verify no personal path/cookie. Try the other ST account, if configured, to verify separate context IDs.
3. Temporarily disable/remove this plugin, restart, and check that old outfit images, Genesis images, and lorebook editing still use their previous Local paths. Repeat in the actual TT client; TT never connects to this Server directly. Re-enable the plugin and check Docker container restart rotates boot/context IDs without modifying existing data.
4. Check coexistence with installed 柏宝库 on the real NAS. The current plugin ID, route and config filename are dedicated; future data layout is not implemented. Keep the actual ST dataRoot and plugin code volume mounted as intended and check UID/GID; config persistence requires the dataRoot volume. The plugin never writes into its own code folder.

The independent Protocol 1.0 fixture, shape, bounds and errors are documented in `protocol/README.md`. Phase 2 Network CSRF and proxy behavior still need verification on the installed NAS; the in-process HTTP harness tests the plugin router but does not prove the deployed SillyTavern middleware order. The itemized code-side review and explicit real-host gaps are in `PHASE-1-ACCEPTANCE.md`; this is not a release claim.

## Privacy before publication

See [`docs/PRIVACY-AND-SECURITY.md`](docs/PRIVACY-AND-SECURITY.md). Run `npm run audit:privacy` after every change and before pushing; inspect Git history and the GitHub public surfaces before releasing or changing repository visibility. Never commit real administrator configuration or NAS diagnostics.

## Phase 2 Network administrator policy

The default and existing Phase 1 config leave Network disabled. A deployment administrator can add a `network` object to the same persistent config file and restart SillyTavern. This public example uses only illustrative domains; put the real endpoint and allowed public image domains solely in the private deployment config:

```json
{
  "schemaVersion": 1,
  "core": { "allowedOrigins": ["https://example.com"] },
  "network": {
    "enabled": true,
    "transport": "http-proxy",
    "proxyUrl": "http://proxy.example.com:8080",
    "destinationPolicy": "allowlist-only",
    "allowlist": ["example.com", "*.example.com"],
    "allowHttp": false
  }
}
```

`*.example.com` matches true subdomains only; add the apex separately. Proxy credentials may be in the private proxy URL and are never returned by status or logs. The supported transports are `direct` and explicit `http-proxy`; neither inherits SillyTavern's process-wide proxy agents. HTTP is off by default. Effective limits default to 16 MiB, three redirect hops, 5 s connect, 10 s first byte, 10 s idle, 30 s total, two requests per user, four globally and 30 per minute per user; administrator values may only reduce them. Configured proxy failure never falls back to direct. Invalid Network config leaves Core discovery available but Network unavailable.

`POST /v1/network/fetch` requires authenticated SillyTavern user context, protocol header, exact trusted Origin and a valid session CSRF token. It accepts only `{ "url": "https://example.com/image.png", "profile": "image" }`. HTTPS and allowed public domains are checked before and after each redirect; complete A/AAAA answers must be public. Direct requests pin a validated address through DNS lookup; proxy requests send the approved IP in absolute-form HTTP or HTTPS CONNECT, preserving the original Host and verified TLS name. Mixed/private/Tailscale/metadata answers fail closed. Non-2xx upstream bodies, SVG, HTML and unsupported or oversized images are rejected. Success is a bounded, validated JPEG/PNG/WebP/GIF binary body with `no-store` and `nosniff`; failures use the Protocol 1.0 JSON error envelope.

Network returns transient bytes for one user action. It does not save Media, return persistent proxy URLs, change Regex or rewrite character cards. Phase 3 can consume the validated result inside the server without routing bytes through the browser. Host session/CSRF behavior, Docker proxy routing, mobile preview and coexistence must be verified on the actual installation before accepting this candidate. See [`PHASE-2-ACCEPTANCE.md`](PHASE-2-ACCEPTANCE.md) for the code-side and real-host checkpoints.
