# Phase 3 Media Foundation

This module is a Server capability. It does not migrate existing IndexedDB data or make Assets, Outfit, Worldbook, Genesis, Regex or character cards into Media consumers. A future consumer stores only `{ "provider": "server", "assetId": "<opaque UUID>" }`; it never persists the HTTP path, content digest, source URL or NAS path. Local Provider remains independent.

## Runtime and deployment gate

The official SillyTavern 1.19.0 Dockerfile uses a moving `node:lts-alpine3.23` base. Check `node -v` **inside the actual running container** before installing: Media requires Node >=22.13 (including Node 24), `node:sqlite`, and the locked `sharp` runtime dependencies. Install with `npm ci --omit=dev --ignore-scripts` after verifying the image's native Sharp package loads; run `node -e "import('sharp').then(m => console.log(m.default.versions.sharp))"` in the plugin directory. On an older or unsupported runtime, Media is unavailable while Core, Network and existing Local functions remain independent.

The policy file remains outside plugin code. Optional `media` fields must be positive safe integers. Defaults and configurable ceilings are separate:

| Field | Default | Configurable ceiling |
| --- | --- | --- |
| maxBytes | 64 MiB | 256 MiB |
| quotaBytes | 2 GiB per ST user | 1 TiB per ST user; 20/100 GiB supported |
| maxDimension | 8192 | 8192 |
| maxPixels | 24 Mi pixels | 24 Mi pixels |
| maxFrames | 64 | 64 |
| maxFramePixels | 48 Mi aggregate frame pixels | 48 Mi aggregate frame pixels |
| maxConcurrentImports | 2 globally | 2 globally |

`network.maxBytes` independently defaults to 64 MiB and accepts up to 256 MiB; Remote Import passes both budgets. An old explicit 16 MiB setting is preserved, not migrated or silently raised. Administrator config edits require restart; the UI only reports the authoritative quota and offers no quota editor. All other decode/request safeguards remain independent ceilings. Invalid Media policy makes Media unavailable without replacing Core or Network policy. `core.allowedOrigins` must include the trusted browser origin for mutation operations.

## Storage and backup

Every authenticated ST user's trusted `req.user.directories.root` owns a separate `tavern-toolbox-server/media-v1/` directory: `metadata.sqlite`, `originals/`, `derived/`, and `staging/`. The user's real root is never returned to the browser or logged. SQLite schema v1 records the opaque asset ID, SHA-256 internal content identity, authoritative MIME, size, dimensions, frame count, creation time and derived state. The database never contains large media bytes. Exact imported Original bytes are immutable. A content-identical Import in the same user Store returns the same valid MediaRef. Different users have separate databases and physical blobs. Within one user this is a shared Asset Pool: Consumer/Character Scopes store logical MediaRefs and do not create physical subdirectories or copies. Removing a Consumer binding does not delete an asset. No existing storage is migrated. A future Media Manager should query logical Consumer ownership, reference state (Active / Detached-only / Unreferenced), kind, size and creation time; deletion must account for all references. No new gallery, deletion policy or GC is introduced here.

Back up the whole Media Store as one unit **with SillyTavern stopped**. Restore that consistent unit before restarting; asset IDs continue resolving. `derived/` can be rebuilt; `metadata.sqlite` plus `originals/` are canonical. Do not remove individual Original files in NAS File Manager. A missing or changed Original reports `MEDIA_CORRUPT` and is never silently fetched again. A newer unknown SQLite schema reports `INCOMPATIBLE_SCHEMA` and is never reset to empty. A physical orphan cleanup is available through the explicit authenticated maintenance operation; valid unreferenced assets are retained.

## Protocol 1.0 operations

All paths below are relative to `/api/plugins/tavern-toolbox-server`. JSON requests use `X-TTB-Protocol: 1.0`. Mutations additionally require the trusted same-origin Origin and the active ST session CSRF token in `X-CSRF-Token`. Ordinary image GETs require only the authenticated ST session so `<img>` works. All GETs use `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`, preventing browser user-switch cache reuse. All errors have the existing Protocol 1.0 JSON envelope and omit filesystem paths and source URLs.

| Operation | Request | Result |
| --- | --- | --- |
| Local Import | `POST /v1/media/import/local` with raw `image/jpeg`, `image/png`, `image/webp`, `image/gif` or `application/octet-stream` bytes | JSON asset metadata and MediaRef |
| Remote Import | `POST /v1/media/import/remote` JSON `{ "url": "https://example.com/image.png" }` | Same; fetches internally through Phase 2 Network, subject to its policy |
| Metadata | `GET /v1/media/assets/:id` | JSON metadata and MediaRef |
| Original | `GET /v1/media/assets/:id/original` | Exact bytes, authoritative image Content-Type |
| Thumbnail | `GET /v1/media/assets/:id/thumbnail` | Bounded static WebP preview where available |
| Storage | `GET /v1/media/storage` | Counts, Original and Derived bytes, quota state |
| Delete | `DELETE /v1/media/assets/:id` | Phase 6: rechecks complete reference analysis and zero Active/Detached refs before permanently invalidating identity |
| Rebuild | `POST /v1/media/assets/:id/rebuild-thumbnail` | Rebuilds Derived from Original without changing MediaRef |
| Maintenance | `POST /v1/media/maintenance/cleanup` | Removes only physical orphan files and expired staging |

Media registers independently of Network and advertises `media.assets` with operation-level availability. A proxy transport failure degrades Network, but Remote Import remains available for a real retry after proxy recovery; disabled or unavailable Network prevents Remote Import. Local Import and existing Reads remain available. An explicitly requested Server write never falls back to IndexedDB. Remote URL, supplied filename and content digest do not become MediaRef identity. Animated GIF Original is preserved; animated WebP and APNG are explicitly rejected in this first profile. SVG, Video, Audio and arbitrary files are unsupported.

SillyTavern 1.19.0's global JSON/urlencoded body parsers and multer run before the plugin router. The first NAS Local Import of a valid raw PNG returned HTTP 400 `INVALID_REQUEST` before Media validation or persistence: body-parser left an empty plain `req.body` placeholder even though the raw request stream was unread, and the old route rejected every non-Buffer defined body. The fix accepts only an undefined body, that exact empty plain placeholder, or an existing Buffer, then reads and bounds the raw bytes itself. An already-consumed stream, a populated/non-plain host body, an empty upload, or a mismatch with a supplied Content-Length fails closed. The raw binary Protocol 1.0 contract remains unchanged; no multipart or Base64 conversion is needed. The regression harness runs the pinned Express 4/body-parser/multer versions before the plugin route and checks both the successful raw upload and consumed-body rejection.

## Acceptance and verification boundary

The installed-host acceptance is recorded in [`PHASE-3-ACCEPTANCE.md`](../PHASE-3-ACCEPTANCE.md). The automated suite covers format validation, animated GIF, malformed/truncated media, bounds, MIME mismatch, same-user concurrent dedupe, quota race, cross-user isolation, immutable Original, explicit deletion, derived rebuild, technical cleanup, unknown newer schema, Network isolation, authenticated HTTP serving, cache policy, the installed-host upload middleware chain and proxy recovery. Individual negative security cases covered by that suite are not claimed as separate NAS observations.


## Phase 6 Governance / Reference Provider boundary

The composition root registers expected Consumer-owned Providers (`localization`, `outfit`) regardless of their current availability. `src/governance` knows only the common Group/Reference contract: opaque group and reference IDs, labels, lifecycle, revision, actions and MediaRef. Localization enumerates its reconciled Scopes, including detached bindings; Outfit enumerates its media-bearing business records. Future real Server Consumers register their own adapter; no Governance business-schema scan or physical Consumer directories are needed. Provider failure/timeout is incomplete analysis, never an empty successful scan.

Asset state precedence is Active reference → active, otherwise Detached reference → detached, otherwise complete zero-reference analysis → unreferenced, otherwise unknown. A missing metadata row is a Broken Reference and stays in the Group/detail query. A row with missing/changed Original is corrupt while retaining its reference state. Detail checks Original bytes against the existing internal digest; no digest/path/source URL is exposed. Original and Derived bytes in SQLite remain the authoritative user quota; only complete unreferenced sizes contribute to cleanup estimates.

Reads return bounded pages (default 24, maximum 48), with server-side filtering/search/sort and paginated details. Analysis joins metadata internally without reading all Originals. Only explicit detail health checks read/hash its Original; thumbnail rebuilding keeps identity and Original unchanged. Core health discovery does not trigger full Governance scans. UI opening/refresh/mutation causes on-demand analysis; no persistent reference index, second metadata DB, background poll or automatic GC is introduced.

Per-user Consumer reference writes and both legacy/new HTTP hard deletes share a process-local coordinator. The final reference check and delete cannot overlap another participating write. Business and Localization retain their collection revision CAS. Expected Providers cannot be silently omitted to permit deletion. The deployment must keep **one active ST process per shared user data volume**, as already required; filesystem changes by administrators and multiple independent writers are outside this coordination guarantee. Unknown/newer storage schemas fail closed without resetting data. No storage schema upgrade or Original rewrite is needed.

Character `bindExisting` validates current host identity, exact locator, existing healthy Media and Catalog CAS without contacting Network. Reference unlink/replace is owned by Localization; active groups require the matching current host. Detached Forget/Rebind retain Media and do not require the old source host. Rebind only targets the explicit current host and refuses a nonempty destination Scope. Outfit reference mutation uses its own collection CAS and validates newly added MediaRefs; manager actions never edit its name/category/graph. All authenticated operations remain user-scoped, same-origin and CSRF protected for writes. Local Providers are outside Governance.
