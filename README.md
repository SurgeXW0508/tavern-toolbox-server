# Tavern Toolbox Server

## Phase 7 Stable Audio Source — First device candidate

The `stage/phase-7-audio-source` candidate adds `network.remoteAudio` (Protocol 1.0) with user-scoped, expiring opaque playback access and finite-file Streaming Relay. Native GET/Single Range uses the ST session; creation/release use trusted Origin, CSRF and negotiated protocol. Audio budgets are independent of Image, while destination safety and the server-owned proxy transport are shared. Existing administrator Network configuration needs no edit beyond explicitly allowing the actual source/redirect hosts. Optional top-level `audio` limits are described in [Phase 7 architecture and acceptance](PHASE-7-ACCEPTANCE.md).

The additive `preferences.audioRouting` capability stores hostname-only routing preferences under the authenticated ST user directory, independent of Network policy. Read on initialization/settings open; transactional add/remove merges concurrent client edits. Legacy browser hosts require explicit import, never silent migration. Client routing preferences never grant Network permission. No silent direct fallback, Audio localization/assets/cache/transcoding, live streaming or generic URL proxy. A reproduced HTTPS proxy CONNECT/TLS cancellation leak is fixed without changing Image limits; existing Image/Media/Governance behavior and formal versions are unchanged. NAS/device acceptance is pending; do not merge or release this candidate yet.

`audio.sources` adds a separate per-ST-user SQLite Source Registry. Protected create/reuse/read/list/delete controls return an opaque identity and root-relative stable playback path, never original URL/query or identity hash. Creating metadata grants no Network access. Each session-authenticated native Source GET resolves that user's current backend and calls the existing Audio Relay with the same safety, Range and Audio budgets. The standard temporary access path remains unchanged. Sources persist across restart; temporary access IDs do not. Deletion invalidates subsequent old Source GETs and does not delete Assets.

Only Remote backend is implemented. Independent Audio Asset storage/localization must wait for the first real-device validation; no nullable audio fields in Image MediaStore, cache, Runtime adapter or automatic Remote fallback. This branch starts at Server `2d590c6`; Frontend starts at pre-Adapter `83cdb90`. Old experimental branches remain separate. Original author media data is converted only after the user's NAS creates real IDs; copies are bound to this Server instance/user. See [Source wire contract](protocol/README.md) and [mandatory first-stage stop](PHASE-7-ACCEPTANCE.md).

## Phase 6 Media Governance & Asset Manager — Release v0.6.0

Release v0.6.0 is paired with Frontend v0.49.0. Phase 6 has completed code review, automated verification and user acceptance of the core experience. Protocol 1.0 and existing Media IDs/Originals/SQLite schemas are preserved; no automatic migration or GC. Future development starts from latest `main`.

`media.governance` adds bounded Summary, Asset/Reference Group browsers, details, Consumer-owned reference actions and reference-aware batch deletion. Character Localization and Outfit register independent Reference Providers; Governance never parses their business schemas. Active / Detached / Unreferenced / Unknown reference states are separate from Original/Thumbnail health. Broken references survive absent Media rows. Provider failure makes analysis incomplete, preserves known references and prevents deletion; it does not disable Media reads. See [Media Foundation and Governance](docs/MEDIA-FOUNDATION.md), [protocol](protocol/README.md) and [Phase 6 acceptance](PHASE-6-ACCEPTANCE.md).

Every external hard delete, including the existing `DELETE /v1/media/assets/:id`, now rechecks complete provider analysis and zero references under the same per-user coordinator as Business/Localization writes. Active and detached references both prevent deletion. Consumer deletion, unlink, detached forget and replacement retain Media. Batch deletion reports each outcome; no automatic GC or expiry. Existing Originals can be bound to a precise Character locator without Network access and reused in a Server Outfit image slot. No Local IndexedDB Genesis/Worldbook/Outfit data is scanned or migrated.

The frontend global manager replaces the old detached-management panel in Server Status. Thumbnails are lazy/static with no Original fallback; Original is explicit, references are paginated and user changes discard previews. Only one active ST process may use a user data volume: the coordinator is process-local and is not a distributed lock. The user completed core use and UI checks on SillyTavern 1.19.0 Docker / NAS without an obvious blocker. This aggregate report is not a claim that every specialized matrix case was manually exercised; see the evidence categories in PHASE-6-ACCEPTANCE.md.

## Phase 5 Remote Image Access & Localization Foundation

Release `v0.5.0`, paired with frontend `v0.48.0`, completes Phase 5 and adds `localization.characters` without changing Protocol 1.0. The authenticated per-user Catalog stores Character Scopes, SHA-256 identities of exact remote locators, and standard Server MediaRefs. It does not store source URLs or own character cards. Explicit Localize uses the existing policy-controlled Network remote import, then commits the Binding with a revision check; failed import or commit leaves the old Binding intact. Unlocalize, replacement, and character deletion never hard-delete Media.

The Server reads the trusted ST user's PNG card metadata and uses the host filename plus `create_date` as the identity proof. Ordinary SillyTavern 1.19.0 atomic saves retain this marker; normal imports reset it and Duplicate uses a distinct filename. Rename, deletion and changed markers detach the Scope and require manual rebind. Existing inode-based candidate Catalogs migrate their bindings as detached. A detached Scope never claims a new Character's locator: unbound images continue through transient Server Network access, even when another Scope used the same URL. Missing host identity disables Character binding but still permits transient access. An effective Binding whose MediaRef is missing does not fetch the source automatically; an unavailable Localization module also fails closed. A raw filesystem copy that restores the same filename and `create_date` between observations cannot be distinguished from an edit, so that host operation is outside the automatic identity guarantee. Per-image resolve checks only its current PNG; Catalog management scans the directory. Group chats may use transient Network image access, but character localization requires a clear single-character identity. The user confirms Phase 5 core, Allowlist hot apply/persistence and Desktop / Tablet / Phone final UI smoke passed on ST 1.19.0 Docker / NAS. Specialized GIF/streaming installed-host checks remain unperformed and non-blocking; their automated contracts are covered.

The completed installed-host acceptance and automated evidence boundaries are in [Phase 5 final acceptance](PHASE-5-ACCEPTANCE.md). Future work starts from latest `main`; no Phase 5 product scope is added during Release Closeout.

## Release notes

- Media Governance module with Reference Provider / Reference Group contracts, independent Character Localization and Outfit providers.
- Reference Analysis completeness separates Active, Detached, Unreferenced, Unknown and Broken Reference from physical Media health; incomplete analysis fails closed.
- Safe single and batch Hard Delete, including the legacy Media DELETE path, requires complete analysis and zero references.
- Per-user coordination serializes reference writes and deletion. A batch holds one coordinator, analyzes Providers once and returns partial per-item outcomes.
- Existing Media binding verifies the target Original and precise Character locator without Network access; Server Outfit slots reuse the same Original through Business CAS.
- Detached lifecycle supports explicit Rebind / Forget; unlink, replacement and Business deletion retain Media.
- Protocol 1.0, Media IDs, Originals and existing Media / Business / Localization Schema versions are unchanged. No automatic migration, GC or Local Genesis / Worldbook / Outfit conversion.

The user completed core use and UI checks on SillyTavern 1.19.0 Docker / NAS with no obvious blocker. Automated evidence covers 48-item batch races, Provider incomplete, cross-ST-user negative cases and deletion coordination; artificial Corrupt Original, SQLite damage and high-concurrency installed-host drills were not specifically exercised and remain non-blocking. The release-package NAS sanity check requires a separate user confirmation.

## Phase 4 Business Provider and Outfit

Release `v0.4.0` adds an independent Business Collection module and the first complete Outfit Consumer. Its protocol, persistence and backup boundary are in [Business Collection](docs/BUSINESS-COLLECTION.md); the official SillyTavern 1.19.0 Docker/NAS results and their limits are in [Phase 4 acceptance](PHASE-4-ACCEPTANCE.md). No Local Outfit data is migrated automatically. Business ownership is separate from Server Media ownership.

## Releases and rollback

Phase 3 Media Foundation remains available as `v0.3.0`; Phase 2 Network Foundation is `v0.2.0`. Merging a reviewed version bump to `main` runs `.github/workflows/release.yml`: it verifies privacy and tests, creates an immutable annotated `vX.Y.Z` tag at the exact `main` commit, and publishes a GitHub Release with a source archive and SHA-256 checksum. Re-running the workflow never moves an existing tag. Commits with the same package version do not create another release; bump `package.json` and the two root versions in `package-lock.json` only after the next stage is accepted. Pin an installation to a tag or exact commit to roll back. Back up the user data separately; a code tag does not roll back Business, Localization or Media data. Phase 5 Frontend v0.48.0 / Server v0.5.0 remain code rollback baselines; restore the user's own Server data backup if data rollback is needed.

Phase 3 adds a user-private, versioned SQLite metadata Store and immutable filesystem Originals without migrating Local images. See [Media Foundation and runtime requirements](docs/MEDIA-FOUNDATION.md) and [installed-host acceptance](PHASE-3-ACCEPTANCE.md). The Phase 2 release has Core and Network only; Phase 3 adds Media, but no role-card rewriting or background jobs.

## Install for official SillyTavern Web

Use a pinned, reviewed version of this repository in the SillyTavern `plugins/tavern-toolbox-server/` directory. Enable `enableServerPlugins: true` in the persistent SillyTavern configuration and restart SillyTavern. The plugin is discovered by `GET /api/plugins/tavern-toolbox-server/status` after SillyTavern authentication; `GET /api/plugins/tavern-toolbox-server/v1/status` requires `X-TTB-Protocol: 1.0`. The frontend provides **设置 → 服务器与扩展能力**. If the plugin is absent, all existing Toolbox data stays local.

Do not copy user data into the plugin code directory. Phase 3 creates per-user Media metadata and files; Phase 4 adds a separate per-user Business Collection. Neither migrates existing Local data. The plugin works independently of 柏宝库. No CORS or cross-origin TT connection is supported.

Optional administrator configuration lives outside the plugin at `<SillyTavern dataRoot>/tavern-toolbox-server.config.json`; `TAVERN_TOOLBOX_SERVER_CONFIG` can select an explicitly managed absolute config path. A missing default file uses safe defaults; a malformed or explicitly missing file reports `INVALID_CORE_CONFIG` and never silently replaces the administrator's policy. Example:

```json
{"schemaVersion":1,"core":{"maxStatusResponseBytes":262144,"allowedOrigins":[]}}
```

`allowedOrigins` is the deployment administrator’s exact trusted browser origin list for Network POST, not a CORS allowlist. A missing list disables unsafe operations. Host session CSRF protection must also be active. Configuration changes outside the bounded Allowlist UI take effect on restart; the UI activates successful allowlist edits immediately. `/status` and `/v1/status` are both authenticated, read-only and `Cache-Control: no-store`; the effective policy summary never returns the origin list or secrets.

SillyTavern’s global JSON parser runs before plugin routers; deploy a small ingress request-body limit for JSON POST and verify it on the real NAS. The plugin checks its own unparsed request size, but a host parser may already have accepted a larger body. Core/Network support Node >=20; Media and Phase 4 Business each require Node >=22.13 (`node:sqlite`), with Media also requiring its locked Sharp runtime dependency. The package engine remains >=20 so unsupported optional modules report unavailable independently. Validate the actual NAS Node and ST version in the real installation.

For development, run `npm ci --ignore-scripts` then `npm run check` for unit and HTTP-contract tests. The development dependencies reproduce SillyTavern's proxy initialization and raw upload middleware; Media runtime also needs the locked Sharp dependency. Production does not require the openssl CLI: two self-signed HTTPS fixture tests explicitly skip if it is absent. Candidate CI requires openssl and runs both Network HTTPS/CONNECT tests in full. Back up Business and Media together as described in the Business Collection guide.

## Operator and review notes

1. Pin `v0.5.0` or an exact reviewed commit before installing in `plugins/tavern-toolbox-server/`. Use the matching frontend `v0.48.0` for Server Outfit and Character Localization. Confirm the installed SillyTavern loader supports `init(router)` and exit hooks, `req.user.profile.handle` and `req.user.directories.root` in your real version. No separate administrator Web UI exists.
2. Confirm `enableServerPlugins: true`, restart one active SillyTavern instance, sign in to the official Web client, open any module homepage in Toolbox, select **服务器与扩展能力**, and inspect `core.status` plus `network.remoteFetch` (disabled until the administrator enables it). Refresh once and preview diagnostics before copying; verify no personal path/cookie. Try the other ST account, if configured, to verify separate context IDs.
3. Temporarily disable/remove this plugin, restart, and check that old outfit images, Genesis images, and lorebook editing still use their previous Local paths. Repeat in the actual TT client; TT never connects to this Server directly. Re-enable the plugin and check Docker container restart rotates boot/context IDs without modifying existing data.
4. Check coexistence with installed 柏宝库 on the real NAS. The plugin ID, route and config filename are dedicated. Keep the actual ST dataRoot and plugin code volume mounted as intended and check UID/GID; config persistence requires the dataRoot volume. The plugin never writes into its own code folder.

The independent Protocol 1.0 fixture, shape, bounds and errors are documented in `protocol/README.md`. Installed-host evidence and verification limits are recorded in [`PHASE-2-ACCEPTANCE.md`](PHASE-2-ACCEPTANCE.md), [`PHASE-3-ACCEPTANCE.md`](PHASE-3-ACCEPTANCE.md) and [`PHASE-4-ACCEPTANCE.md`](PHASE-4-ACCEPTANCE.md).

## Privacy before publication

See [`docs/PRIVACY-AND-SECURITY.md`](docs/PRIVACY-AND-SECURITY.md). Run `npm run audit:privacy` after every change and before pushing; inspect Git history and the GitHub public surfaces before releasing or changing repository visibility. Never commit real administrator configuration or NAS diagnostics.


## Phase 5 bounded operations

Network **管理** (writable) or **查看** (read-only) opens `network.policy` read/add/remove. Every mutation requires the current trusted ST administrator (`profile.admin === true`), Protocol 1.0, Origin + session CSRF and the revision from read. Only the `network.allowlist` field in the existing default deployment config is writable. Explicit `TAVERN_TOOLBOX_SERVER_CONFIG` paths are externally managed/read-only, as are symlinks, unsafe/readonly files or externally changed config. No secondary config or runtime overlay is created; reload Server after external edits. Normal successful UI changes are persisted and activated without restart. Validation, stale-write, persistence or preflight activation failures preserve the old effective policy. An in-flight image request retains its start-time policy snapshot; subsequent requests use the new list.

Policy mutation uses a kernel-owned process lock: Linux abstract Unix IPC (Node >=20.8) or a Windows named pipe. A live or paused holder is never reclaimed by a lease timeout; process exit, SIGKILL and reboot release the lock automatically. The old `.ttb-lock` directory is no longer used or deleted, so a legacy artifact cannot permanently block management. File persistence and policy/CAS checks are unchanged. Platforms without this crash-safe primitive keep policy management read-only; Core/Network access is unaffected. Use one active ST instance for this deployment; this is not a distributed lock between containers in separate network namespaces sharing one volume. The implementation follows the official [Node IPC lifetime contract](https://github.com/nodejs/node/blob/v20.20.0/doc/api/net.md#ipc-support).

The Server API accepts hostname or explicit `*.hostname` only. The frontend also accepts pasted http/https URLs as a convenience: it previews the canonical hostname before confirmation and sends only that hostname; path/query/fragment and credential-bearing URLs are never sent or persisted. Case, trailing dots and IDN are canonicalized; no URL, credentials, paths, ports, IPs or local/private labels. Including subdomains adds both exact and wildcard; wildcard alone never grants apex. The Server advertises authoritative `maxHosts` (currently 128) in the policy view and capability; the frontend uses that value, not a duplicate fixed limit. At capacity, Add is disabled while viewing and deleting remain available. An empty allowlist is valid deny-all. Allowing a domain does not bypass DNS/public-unicast, redirect, HTTP/port, transport or image validation. Nonadmin sees count/strategy, not the host list; Server status and copied diagnostics expose only safe summaries. `TARGET_NOT_ALLOWED` can include **only** `error.details.hostname` for an actual rejected host; frontend confirmation is required before an add and Server retry.

The Character panel auto-reads when expanded and offers explicit detached-only **忘记**. It CAS-removes Scope/binding metadata while retaining Media. Broken **重试** reads the current existing MediaRef without resolve/import/source fallback. Operations dialogs reuse the existing Toolbox Appearance themes (auto/paper/dark/ink) and density, including live setting changes, with no separate dialog palette. The bounded host list scrolls independently with local filtering and an Add entry above it. Media summary reuses `media.assets/storage` and reads “媒体配额 · used / quota”, the per-user budget rather than NAS disk space; this adds no gallery/delete/quota editor. The original config, Catalog, MediaRefs, Outfit data and browser Routing preference need no migration. Media remains a shared Asset Pool per ST user with logical Consumer references, not physical consumer folders. Future management must inspect Consumer/reference state, kind, size and creation time and perform reference-aware deletion; this release adds no Media Manager or GC. Routing still covers formatter-produced img/picture/srcset only, not CSS backgrounds, plugin-created DOM, new Image/fetch/canvas, or a global proxy.

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

`*.example.com` matches true subdomains only; add the apex separately. Proxy credentials may be in the private proxy URL and are never returned by status or logs. The supported transports are `direct` and explicit `http-proxy`; neither inherits SillyTavern's process-wide proxy agents. HTTP is off by default. Network and Media image defaults are 64 MiB each; either `maxBytes` may be configured up to 256 MiB (268435456 bytes). Remote Import must pass both effective byte budgets. Media quota defaults to 2 GiB per user and may be configured up to 1 TiB; 20/100 GiB are supported. Defaults apply only to omitted fields: an existing explicit 16 MiB budget stays 16 MiB until the administrator changes it. These deployment config edits take effect after restart and have no web quota editor. Three redirect hops, 5 s connect, 10 s first byte, 10 s idle, 30 s total, two requests per user, four globally and 30 per minute per user remain independent ceilings; administrator values can only reduce those. Dimension/pixel/frame/MIME and decode concurrency safeguards also remain unchanged. Configured proxy failure never falls back to direct. Invalid Network config leaves Core discovery available but Network unavailable.

`POST /v1/network/fetch` requires authenticated SillyTavern user context, protocol header, exact trusted Origin and a valid session CSRF token. It accepts only `{ "url": "https://example.com/image.png", "profile": "image" }`. HTTPS and allowed public domains are checked before and after each redirect; complete A/AAAA answers must be public. Direct sockets connect to a validated address; proxy requests send the approved IP in absolute-form HTTP or HTTPS CONNECT, preserving the original Host and verified TLS name. Every request specifies its protocol to avoid inheriting the host ProxyAgent's stack-dependent default. Mixed/private/Tailscale/metadata answers fail closed. Non-2xx upstream bodies, SVG, HTML and unsupported or oversized images are rejected. Success is a bounded, validated JPEG/PNG/WebP/GIF binary body with `no-store` and `nosniff`; failures use the Protocol 1.0 JSON error envelope.

Network returns transient bytes for one user action. It does not save Media, return persistent proxy URLs, change Regex or rewrite character cards. Phase 3 can consume the validated result inside the server without routing bytes through the browser. The installed-host acceptance scope and verification limits are recorded in `PHASE-2-ACCEPTANCE.md`. See [`PHASE-2-ACCEPTANCE.md`](PHASE-2-ACCEPTANCE.md) for the code-side and real-host checkpoints.
