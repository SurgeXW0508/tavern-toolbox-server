# Tavern Toolbox Server

## Phase 5 Character image localization candidate

The `stage/phase-5-remote-image` branch adds `localization.characters` without changing Protocol 1.0 or the Phase 4 release. The authenticated per-user Catalog stores Character Scopes, SHA-256 identities of exact remote locators, and standard Server MediaRefs. It does not store source URLs or own character cards. Explicit Localize uses the existing policy-controlled Network remote import, then commits the Binding with a revision check; failed import or commit leaves the old Binding intact. Unlocalize, replacement, and character deletion never hard-delete Media.

The Server reads the trusted ST user's PNG card metadata and uses the host filename plus `create_date` as the identity proof. Ordinary SillyTavern 1.19.0 atomic saves retain this marker; normal imports reset it and Duplicate uses a distinct filename. Rename, deletion and changed markers detach the Scope and require manual rebind. Existing inode-based candidate Catalogs migrate their bindings as detached. A detached Scope never claims a new Character's locator: unbound images continue through transient Server Network access, even when another Scope used the same URL. Missing host identity disables Character binding but still permits transient access. An effective Binding whose MediaRef is missing does not fetch the source automatically; an unavailable Localization module also fails closed. A raw filesystem copy that restores the same filename and `create_date` between observations cannot be distinguished from an edit, so that host operation is outside the automatic identity guarantee. Per-image resolve checks only its current PNG; Catalog management scans the directory. Group chats may use transient Network image access, but character localization requires a clear single-character identity. This candidate has not completed installed-host acceptance.

The code-side matrix and the smallest remaining installed-host checklist are in [Phase 5 acceptance candidate](PHASE-5-ACCEPTANCE.md). Keep this stage on its branches until that result is recorded; no Phase 5 release is implied by passing automated tests.

## Phase 4 Business Provider and Outfit

Release `v0.4.0` adds an independent Business Collection module and the first complete Outfit Consumer. Its protocol, persistence and backup boundary are in [Business Collection](docs/BUSINESS-COLLECTION.md); the official SillyTavern 1.19.0 Docker/NAS results and their limits are in [Phase 4 acceptance](PHASE-4-ACCEPTANCE.md). No Local Outfit data is migrated automatically. Business ownership is separate from Server Media ownership.

## Releases and rollback

Phase 3 Media Foundation remains available as `v0.3.0`; Phase 2 Network Foundation is `v0.2.0`. Merging a reviewed version bump to `main` runs `.github/workflows/release.yml`: it verifies privacy and tests, creates an immutable annotated `vX.Y.Z` tag at the exact `main` commit, and publishes a GitHub Release with a source archive and SHA-256 checksum. Re-running the workflow never moves an existing tag. Commits with the same package version do not create another release; bump `package.json` and the two root versions in `package-lock.json` only after the next stage is accepted. Pin an installation to a tag or exact commit to roll back. Back up the user data separately; a code tag does not roll back Business or Media data.

Phase 3 adds a user-private, versioned SQLite metadata Store and immutable filesystem Originals without migrating Local images. See [Media Foundation and runtime requirements](docs/MEDIA-FOUNDATION.md) and [installed-host acceptance](PHASE-3-ACCEPTANCE.md). The Phase 2 release has Core and Network only; Phase 3 adds Media, but no role-card rewriting or background jobs.

## Install for official SillyTavern Web

Use a pinned, reviewed version of this repository in the SillyTavern `plugins/tavern-toolbox-server/` directory. Enable `enableServerPlugins: true` in the persistent SillyTavern configuration and restart SillyTavern. The plugin is discovered by `GET /api/plugins/tavern-toolbox-server/status` after SillyTavern authentication; `GET /api/plugins/tavern-toolbox-server/v1/status` requires `X-TTB-Protocol: 1.0`. The frontend provides **设置 → 服务器与扩展能力**. If the plugin is absent, all existing Toolbox data stays local.

Do not copy user data into the plugin code directory. Phase 3 creates per-user Media metadata and files; Phase 4 adds a separate per-user Business Collection. Neither migrates existing Local data. The plugin works independently of 柏宝库. No CORS or cross-origin TT connection is supported.

Optional administrator configuration lives outside the plugin at `<SillyTavern dataRoot>/tavern-toolbox-server.config.json`; `TAVERN_TOOLBOX_SERVER_CONFIG` can select an explicitly managed absolute config path. A missing default file uses safe defaults; a malformed or explicitly missing file reports `INVALID_CORE_CONFIG` and never silently replaces the administrator's policy. Example:

```json
{"schemaVersion":1,"core":{"maxStatusResponseBytes":262144,"allowedOrigins":[]}}
```

`allowedOrigins` is the deployment administrator’s exact trusted browser origin list for Network POST, not a CORS allowlist. A missing list disables unsafe operations. Host session CSRF protection must also be active. Changes take effect on restart. `/status` and `/v1/status` are both authenticated, read-only and `Cache-Control: no-store`; the effective policy summary never returns the origin list or secrets.

SillyTavern’s global JSON parser runs before plugin routers; deploy a small ingress request-body limit for JSON POST and verify it on the real NAS. The plugin checks its own unparsed request size, but a host parser may already have accepted a larger body. Core/Network support Node >=20; Media and Phase 4 Business each require Node >=22.13 (`node:sqlite`), with Media also requiring its locked Sharp runtime dependency. The package engine remains >=20 so unsupported optional modules report unavailable independently. Validate the actual NAS Node and ST version in the real installation.

For development, run `npm ci --ignore-scripts` then `npm run check` for unit and HTTP-contract tests. The development dependencies reproduce SillyTavern's proxy initialization and raw upload middleware; Media runtime also needs the locked Sharp dependency. Production does not require the openssl CLI: two self-signed HTTPS fixture tests explicitly skip if it is absent. Candidate CI requires openssl and runs both Network HTTPS/CONNECT tests in full. Back up Business and Media together as described in the Business Collection guide.

## Operator and review notes

1. Pin `v0.4.0` or an exact reviewed commit before installing in `plugins/tavern-toolbox-server/`. Use the matching frontend `v0.47.0` for Server Outfit. Confirm the installed SillyTavern loader supports `init(router)` and exit hooks, `req.user.profile.handle` and `req.user.directories.root` in your real version. No separate administrator Web UI exists.
2. Confirm `enableServerPlugins: true`, restart one active SillyTavern instance, sign in to the official Web client, open any module homepage in Toolbox, select **服务器与扩展能力**, and inspect `core.status` plus `network.remoteFetch` (disabled until the administrator enables it). Refresh once and preview diagnostics before copying; verify no personal path/cookie. Try the other ST account, if configured, to verify separate context IDs.
3. Temporarily disable/remove this plugin, restart, and check that old outfit images, Genesis images, and lorebook editing still use their previous Local paths. Repeat in the actual TT client; TT never connects to this Server directly. Re-enable the plugin and check Docker container restart rotates boot/context IDs without modifying existing data.
4. Check coexistence with installed 柏宝库 on the real NAS. The plugin ID, route and config filename are dedicated. Keep the actual ST dataRoot and plugin code volume mounted as intended and check UID/GID; config persistence requires the dataRoot volume. The plugin never writes into its own code folder.

The independent Protocol 1.0 fixture, shape, bounds and errors are documented in `protocol/README.md`. Installed-host evidence and verification limits are recorded in [`PHASE-2-ACCEPTANCE.md`](PHASE-2-ACCEPTANCE.md), [`PHASE-3-ACCEPTANCE.md`](PHASE-3-ACCEPTANCE.md) and [`PHASE-4-ACCEPTANCE.md`](PHASE-4-ACCEPTANCE.md).

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

`POST /v1/network/fetch` requires authenticated SillyTavern user context, protocol header, exact trusted Origin and a valid session CSRF token. It accepts only `{ "url": "https://example.com/image.png", "profile": "image" }`. HTTPS and allowed public domains are checked before and after each redirect; complete A/AAAA answers must be public. Direct sockets connect to a validated address; proxy requests send the approved IP in absolute-form HTTP or HTTPS CONNECT, preserving the original Host and verified TLS name. Every request specifies its protocol to avoid inheriting the host ProxyAgent's stack-dependent default. Mixed/private/Tailscale/metadata answers fail closed. Non-2xx upstream bodies, SVG, HTML and unsupported or oversized images are rejected. Success is a bounded, validated JPEG/PNG/WebP/GIF binary body with `no-store` and `nosniff`; failures use the Protocol 1.0 JSON error envelope.

Network returns transient bytes for one user action. It does not save Media, return persistent proxy URLs, change Regex or rewrite character cards. Phase 3 can consume the validated result inside the server without routing bytes through the browser. The installed-host acceptance scope and verification limits are recorded in `PHASE-2-ACCEPTANCE.md`. See [`PHASE-2-ACCEPTANCE.md`](PHASE-2-ACCEPTANCE.md) for the code-side and real-host checkpoints.
