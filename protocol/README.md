# Protocol 1.0 — Core discovery

Phase 7 release v0.7.0 / Frontend v0.50.0 retains Protocol 1.0. Additive public contracts are [`network.remoteAudio`](#additive-phase-7-networkremoteaudio-contract-10), [`preferences.audioRouting`](#additive-phase-7-preferencesaudiorouting-contract-10), [`audio.sources`](#additive-phase-7-audiosources-contract-10) and [`audio.assets`](#additive-phase-7-audioassets-and-source-binding-operations-10), each with schema/fixture. Selected Source `restore` belongs to audio.sources and returns sensitive metadata only through protected explicit POST.

This directory holds the fixed language-neutral Core fixture and JSON Schema for the two success envelopes. Both are public wire contracts, not internal registry objects. The frontend keeps an independent copy of the fixture in `tests/fixtures/`. On a protocol change, update both fixtures deliberately and keep an older supported version's fixture during the compatibility window.

* `GET /api/plugins/tavern-toolbox-server/status` returns bootstrap discovery. It does not need a version header.
* `GET /api/plugins/tavern-toolbox-server/v1/status` requires `X-TTB-Protocol: 1.0`; `meta.protocol` confirms the selected version.
* Both calls require the current SillyTavern session; no userId, filesystem path, cross-origin base URL, dynamic endpoint or backend-supplied HTML/JavaScript is accepted. Both send `Cache-Control: no-store`.
* Success: `{ "ok": true, "data": {...}, "meta": { "requestId": "…", "serverTime": "…", "protocol": { "major": 1, "minor": 0 } } }` (protocol in versioned responses only).
* Failure: `{ "ok": false, "error": { "code": "…", "message": "…", "details": {}, "retryable": false, "outcome": "notApplicable" }, "meta": {...} }`. HTTP status reflects failure. Core has no data write: its outcome is always `notApplicable`. Upstream HTML/502/403 cannot claim this envelope.
* `bootId` changes with the plugin lifecycle. `contextId` changes with the ST user or boot; it is opaque and not an authorization token. `statusRevision` describes state, `policyRevision` describes actual policy. Neither is a persisted object revision or future dataset epoch.
* Unknown optional fields and unfamiliar capability IDs are ignored. Unknown module/capability states, missing required fields and unmatched major/minor ranges cannot authorize operations. Only `core.status` `read` exists in Phase 1.

Phase 2 advertises the optional `network.remoteFetch` capability (contract 1.0, operation `fetch`, profile `image`) in `/v1/status`. Its request schema and public fixture are in `network.remoteFetch-1.0.schema.json` and `network.remoteFetch-1.0.fixture.json`. It uses the same Protocol 1.0 header and JSON failure envelope, while successful JPEG/PNG/WebP/GIF is binary. An older frontend ignores this capability; a newer frontend connecting to Phase 1 sees Core available and Network missing. The release version does not select capability availability.

Phase 4 advertises `business.collections` contract 1.0 (`read`, `commit`), Outfit consumer schema v1 and collection CAS revision independently of the Protocol and Server release versions. The separate bounded Business document route and error codes are documented in [`docs/BUSINESS-COLLECTION.md`](../docs/BUSINESS-COLLECTION.md). `statusRevision` and `contextId` are never Business revisions.

Bounds: success JSON <=256 KiB, at most 64 modules and 128 capabilities (including any trusted future built-ins), at most 32 operations per capability, module/capability IDs <=64 characters, release strings <=64 characters, boot/context/revision identifiers <=128 characters, and the bootstrap range list <=16 items. Core's metadata, error details, string fields, and numeric policies remain finite and non-secret. The Schema documents the public shape; server and client tests also exercise actual HTTP and Client behavior. Do not treat schema validation on the client as authorization on the server.

## Phase 5 optional operations (Protocol remains 1.0)

`network.policy` contract 1.0 declares `read`, `add`, `remove`, an authoritative `limits.maxHosts` (currently 128) and deployment authority. Policy reads also include `maxHosts`; older Servers may supply only the capability limit, and if neither is known the UI shows count without inventing a maximum. Availability reflects trusted context and writeability; frontends must inspect exact operations, and the Server rechecks authorization at execution. All routes are relative to the same authenticated plugin base:

| Method / route | Body / result |
| --- | --- |
| GET `/v1/network/policy` | revision (opaque string), destinationPolicy, transport, allowlistEntryCount, maxHosts, administrator, canManage, readOnlyReason; hosts only for admin |
| POST `/v1/network/policy/add` | `{host, includeSubdomains: boolean, revision}`; returns committed current policy view |
| POST `/v1/network/policy/remove` | `{host, revision}`; returns committed view |
| POST `/v1/localization/forget` | `{hostId, scopeId, revision}` with Catalog integer revision; removes detached Scope/bindings only, returns same catalog view as read |

Policy mutation requires trusted administrator, exact permitted Origin and session CSRF. Stale revision gives `POLICY_CONFLICT`, concurrent live process lock `POLICY_BUSY`, invalid host `INVALID_HOST`, duplicate `HOST_ALREADY_ALLOWED`, missing `HOST_NOT_FOUND`, bound exceeded `ALLOWLIST_FULL`; readonly/external/changed file states are explicit. Failure remains JSON envelope; it never returns raw config, proxy URL, path or exception. Policy revision is unrelated to Catalog revision. Successful mutation persists the single config and activates; external changes are not silently adopted. Config immutable fields cannot be written through these routes. Policy bodies remain hostname-only even when the frontend extracts a hostname from a pasted URL; no path/query/fragment/credentials enter the request. Network and Media advertise their effective byte limits (64 MiB default, configurable through deployment policy up to 256 MiB); Media storage returns the effective quota (2 GiB default, configurable to 1 TiB). The unchanged Protocol version does not imply hardcoded client limits.

An actual allowlist rejection during `network.remoteFetch/fetch` or explicit Character localize may add `{hostname}` to error.details. It identifies the rejected redirect host when applicable and never contains full URL/path/query. Invalid syntax, unsafe DNS and other failure types do not produce a guessed repair target. Existing binary success and older capability compatibility remain unchanged. `media.assets/storage` is reused for `{totalBytes, quotaBytes, ...}` read-only usage; no new Media management API is introduced.

The mutation mutex is owned by the OS for the lifetime of the writer (Linux abstract Unix IPC / Windows named pipe). It is released by process termination, including SIGKILL, without timestamp expiry, PID guessing or stale-file deletion. Legacy `.ttb-lock` artifacts are inert. Unsupported primitives leave mutations unavailable/read-only. This deployment supports one ST instance; it does not coordinate separate container network namespaces sharing a config volume. The frontend labels the policy entry “管理” only when add and remove operations are both available; otherwise a readable policy entry is “查看”.


## Phase 6 optional Governance (Protocol 1.0)

`media.governance` contract 1.0 advertises `summary`, `assets`, `groups`, `detail`, `group`, `action`, `deleteBatch`. Query pages have `offset` >= 0, `limit` 1–48 (default 24), `search` <=160 characters, optional `consumer`, `state` (active/detached/unreferenced/unknown), `kind=image`, `sort=newest|oldest|largest|smallest`, and `broken=true` for Groups. Asset and group detail paginate their Reference arrays too. JSON results are bounded to 256 KiB. The browser never submits reference-count/deletion authority.

| Route | Contract |
| --- | --- |
| GET `/v1/governance/summary` | authoritative storage, complete/providers, unreferenced count/bytes, broken reference count |
| GET `/v1/governance/assets` | bounded metadata page with Server-calculated referenceState/referenceCount/consumer identities |
| GET `/v1/governance/groups` | bounded Reference Group summaries, including detached groups and broken counts |
| GET `/v1/governance/assets/:id` | asset, separate Original/Thumbnail health, paginated references, completeness |
| GET `/v1/governance/groups/:provider/:group` | Group and paginated references including missing media |
| POST `/v1/governance/action` | `{providerId,groupId,action,revision,referenceId?,hostId?,displayName?,mediaRef?}` → Consumer-owned CAS mutation, returns revision only |
| POST `/v1/governance/delete` | `{assetIds}` of 1–48 unique IDs → per-item deleted/code plus deletedCount/retainedCount |
| POST `/v1/localization/bindExisting` | `{hostId,displayName,url,revision,mediaRef}` → existing Localization view, without source/network request |

Character actions: detached `rebind`/`forget`, reference `unlink`/`replace`; active reference mutation requires the matching explicit hostId. Outfit actions: `unlink`/`replace` of reference `image` with Business revision. These actions do not hard-delete Media. Old `/v1/media/assets/:id` DELETE is retained but **reference-aware**. `MEDIA_REFERENCED` returns 409; `REFERENCE_ANALYSIS_INCOMPLETE` returns 503; missing asset/reference, corruption, Consumer conflict and invalid context remain distinct safe codes. Every delete rechecks authoritative current analysis within the per-user write coordinator, including when a stale browser submits an old ID. Batch outcomes can be partial. New reads never expose internal digest, real paths or original source URLs. No cross-user/project/provider query, automatic GC, arbitrary reverse binding or distributed write coordination is added.

Batch deletion obtains the user coordinator once and performs one fresh Reference Analysis for all 1–48 items. Participating reference writes wait until the last item; incomplete analysis retains existing assets. `localization/bindExisting` reports `MEDIA_NOT_FOUND` with HTTP 404 and `MEDIA_CORRUPT` with HTTP 422, preserving the standard error envelope.

## Additive Phase 7 `network.remoteAudio` (contract 1.0)

| Route | Contract |
| --- | --- |
| POST `/v1/network/audio/access` | `{profile:"audio",url}` → `{accessId,expiresAt,profile:"audio"}`; exact source bound to current ST user, Origin/CSRF/protocol required |
| GET `/v1/network/audio/access/:accessId` | Protocol required; `{expiresAt,state:"ready"\|"failed",code,details}`; sanitized failure hostname only |
| POST `/v1/network/audio/release` | `{accessId}` → `{released:true}`; protected and idempotent, cancels this user's active streams |
| GET `/v1/network/audio/stream/:accessId` | Native media GET using ST session, no custom header; validated Single Range → real upstream 200/206/416 with finite length |

The published playback URL is the same-origin base plus `/v1/network/audio/stream/` and opaque ID; no source query parameter. `AUDIO_ACCESS_EXPIRED` (410) reveals no foreign-user access existence. Invalid multi-range is `UNSUPPORTED_RANGE` (400); unknown size `REMOTE_SIZE_UNKNOWN` (422), malformed upstream interval `INVALID_REMOTE_RESPONSE` (502), oversize 413, unsupported MIME 415. Network destination failures retain existing safe codes. Partial-transfer errors close the media connection; inspect supplies the last sanitized failure. Normal native candidate fallback is allowed, but a failed routed candidate is never restored to its original URL.

Audio capability/module health is independent of Image. Protocol major, `network.remoteFetch` and storage schemas remain unchanged; old clients ignore this capability and new clients fail only Audio routing on old servers. See [Phase 7 limits, privacy, unsupported scenarios and device acceptance](../PHASE-7-ACCEPTANCE.md).

## Additive Phase 7 `preferences.audioRouting` (contract 1.0)

Independent `preferences` module; fixed Audio hostname scope only, not an arbitrary settings/KV interface. Durable storage is isolated in the authenticated ST user directory; never accepts a user ID or filesystem path. Read/add/remove work independently of Network activation, while mutation requires allowed Origin and session CSRF. Every operation requires `X-TTB-Protocol: 1.0` and `X-TTB-Context` equal to the current discovery snapshot's contextId; a stale session/boot returns CONTEXT_CHANGED before any write. GET and JSON envelopes use no-store/nosniff.

| Route | Request / data |
| --- | --- |
| GET `/v1/preferences/audio-routing` | `{schemaVersion:1,revision,hosts}` |
| POST `/v1/preferences/audio-routing/add` | `{hosts:[canonicalHostname,...]}` → same snapshot; atomic union against current database state |
| POST `/v1/preferences/audio-routing/remove` | `{hosts:[canonicalHostname,...]}` → same snapshot; atomic subtraction |

At most 128 unique hostnames, each at most 253 ASCII characters; empty snapshot allowed, mutation list requires 1–128 entries. Only canonical lowercase DNS hostnames; rejects full URLs, credentials, paths/query/fragment, wildcards, IP and local suffixes. Explicit legacy import uses atomic add, never whole-array replacement. Revision advances only on change. Duplicate add/missing remove is idempotent. Preference mutations never edit Network Allowlist. INVALID_HOST=422, ROUTING_HOSTS_FULL=409, CONTEXT_CHANGED/PROTOCOL_INCOMPATIBLE=409, CSRF_REJECTED=403; unavailable runtime/storage/schema fail explicitly with 503. Client has no local write fallback.

See `preferences.audioRouting-1.0.schema.json` and `preferences.audioRouting-1.0.fixture.json`; Network/Media/Business schemas and formal Protocol major remain unchanged.

## Additive Phase 7 `audio.sources` (contract 1.0)

Separate `audio-sources` module and private per-ST-user Registry, not Image MediaStore or a generic KV/proxy. Source identity is canonical URL SHA-256, query/order/encoding remain significant; hostname case/default port follow WHATWG canonicalization. No title/filename matching. Original URL and hash remain private; public DTO includes opaque 192-bit `sourceId`, `backend`, `hostname`, nullable `localAssetId`, created/updated milliseconds and exact root-relative `playbackPath`. No URL credentials or fragment; HTTP(S), bounded ports/address validation, max canonical URL 2048 chars. HLS/DASH unsupported.

| Route | Contract |
| --- | --- |
| POST `/v1/audio/sources` | `{url}` → `{source,reused}`; atomic create/reuse; no original-host fetch or permission grant |
| GET `/v1/audio/sources?cursor=<sourceId>` | `{sources,nextCursor}`; sorted sourceId keyset, at most 50 items |
| GET `/v1/audio/sources/:sourceId` | public `source` DTO; foreign/deleted IDs give same safe 404 |
| POST `/v1/audio/sources/:sourceId/restore` | `{}` → `{sourceId,url}`; explicitly selected current-user sensitive recovery metadata, protected POST/no-store, no backend or Network change |
| POST `/v1/audio/sources/:sourceId/delete` | `{}` → `{removed:true}`; Source-only deletion; missing ID 404 |
| GET `/v1/audio/sources/:sourceId/stream` | native ST session, same-origin, no custom protocol headers; current backend uses existing Audio Relay 200/206/416 |

Control requests require `X-TTB-Protocol: 1.0` and current discovery `X-TTB-Context`; mutations also require trusted Origin/session CSRF. Source IDs must be 32 base64url characters; exactly 512 sources maximum per user. Native stable path is `/api/plugins/tavern-toolbox-server/v1/audio/sources/<sourceId>/stream`; not host/URL metadata. GETs are no-store/nosniff with same-origin resource policy. Each Remote stream reapplies current Allowlist, DNS/redirect approval, MIME/finite total size, proxy/TLS and Audio budgets; browser headers are not forwarded. Failure never restores an original URL or chooses another backend.

Stage 1 only had Remote creation/streaming; Stage 2 extends this same additive contract with the operations below. Local uses the independent Audio Asset Store and fails explicitly if unavailable, never falling back. Backend changes retain Source ID/path; Asset content digest and Source URL identity remain distinct. Localization is available through protected Audio job controls below, never a generic URL download endpoint. SQLite Node >=22.13 required independently of Core/other modules. Current storage is `<trusted-user-root>/tavern-toolbox-server/audio-sources-v1/sources.sqlite`, directory 0700/database 0600, version 2 (additive revision migration), FULL transaction durability. Private database/backup contains original signed URLs: treat it as private user data. Private remote URLs, identity hashes and physical file paths are absent from ordinary DTOs/logs. No client-selected user ID or physical path is accepted; opaque Source IDs resolve only within the authenticated user.

`AUDIO_SOURCE_NOT_FOUND`=404, `AUDIO_SOURCES_FULL`=409, `INVALID_REQUEST`/`UNSUPPORTED_RANGE`=400; existing Network safe codes retain their 403/413/415/422/429/502/504 status. Store/schema/runtime unavailable=503, `CONTEXT_CHANGED`/`PROTOCOL_INCOMPATIBLE`=409, `CSRF_REJECTED`=403. Public error details are sanitized hostname only when the existing Network policy rejects it. Schema/fixture: `audio.sources-1.0.schema.json`, `audio.sources-1.0.fixture.json`; dynamic playbackPath must additionally equal its sourceId and timestamps must be monotonic. Protocol major and existing Image/Media/Business contracts unchanged.

## Additive Phase 7 `audio.assets` and Source binding operations (1.0)

Stage 1 Source IDs/path/controls are compatible. Source DTO adds `revision` and nullable public `asset`; old clients can ignore them. Original URL/hash remain private. Asset DTO is opaque `assetId`, exact `/api/plugins/tavern-toolbox-server/v1/audio/assets/<id>/stream`, MIME, byteSize, createdAt, health (`healthy|missing|corrupt`) and exact Source `referenceCount`; no digest/physical path. Source's failed asset inspection is an explicit `{assetId,health:unavailable,code}`; backend is not changed. All controls require protocol/current context; POST also Origin/CSRF. No client user ID or file path.

| Route | Request → result |
| --- | --- |
| POST `/v1/audio/sources/lookup` | `{url}` → `{source|null}`; existing canonical identity only, no creation/fetch |
| POST `/v1/audio/sources/:id/localize` / `repair` | `{revision}` → Audio job; repair explicitly downloads original, healthy Localize reuses |
| POST `/v1/audio/sources/:id/backend` | `{revision,backend:remote|local}` → Source; Local requires retained healthy binding; Remote retains it |
| POST `/v1/audio/sources/:id/releaseLocal` | `{revision}` → Remote Source with null binding; URL unchanged |
| POST `/v1/audio/sources/:id/delete` | legacy `{}` or `{revision}` → removed; external references unknown, no Asset deletion |
| GET `/v1/audio/jobs/:jobId` | current-user/boot job read + renew 45-second lease |
| POST `/v1/audio/jobs/:jobId/cancel` | `{}` → job; completed commits remain |
| GET `/v1/audio/assets?cursor=<id>` / `/:id` | bounded page with storage summary / Asset DTO |
| GET `/v1/audio/assets/:id/stream` | native session Local 200/206/416; never Network |
| POST `/v1/audio/assets/:id/check` / `delete` | `{}` → full-digest Asset health / removed; referenced delete rejected |
| POST `/v1/audio/assets/cleanup` | `{assetIds:[1..50 unique IDs]}` → `{removed:[IDs]}`; exact confirmed set, recheck all refs first |

Audio jobs: `jobId,sourceId,state:pending|downloading|committing|completed|failed|cancelled,receivedBytes,totalBytes|null,code|null,details:{hostname?},source?`. Completed includes Source; failed/cancelled never include raw URL/error. Download+cleanup finishes before terminal state is published. Terminal jobs retained 10 minutes with 128/user,1024/global bounds; localization 2/user,4/global,2-hour operation max. UI polls and cancels; abandoned work expires even without a working client. Network error codes remain safe; no Direct fallback. `AUDIO_SOURCE_CONFLICT` and `AUDIO_ASSET_REFERENCED`=409, unknown Source/Asset/job=404, quota/size=413, invalid content=415, unhealthy Local=422, busy=429, storage/runtime failure=503. Schema/fixtures in `audio.sources-1.0.*` and `audio.assets-1.0.*`.

Source/Asset stores are separate. Ready Asset is durable before Source revision binding; failure/crash cannot produce half-Local. Crash or failed Source CAS can leave a known orphan Asset, never auto-remote or automatic cleanup of good assets. Explicit orphan deletion and interrupted-delete recovery check complete current Source references; Remote retained bindings count. Native stream privacy/session requirements are identical to the existing Source stream, but Local does not depend on Network capability state. Image contracts/schemas are unchanged.


## Phase 7 selected Source recovery (additive 1.0)

`audio.sources/restore` is available only with the existing trusted control-origin policy. Empty-body POST resolves the selected opaque ID under the authenticated ST user and returns the canonical stored original URL. Protocol/context, Origin and session CSRF remain mandatory; another user or deleted ID receives the same safe 404. Extra fields and GET are rejected. Response is no-store/nosniff; source URL is sensitive recovery metadata, never added to normal Source/list/job DTOs or ordinary errors/logs. Restoring references does not fetch, switch backend, modify Asset binding or authorize a host. Contract definitions/fixture include `restoreRequest` and `restoreResult`.

Canonical wire playbackPath stays `/api/plugins/tavern-toolbox-server/...`; clients validate it before applying the trusted current ST base path for deployment/preview. A stable resource is instance/user bound. Other origins or deployment prefixes must not be resolved as current Source IDs by guessing. No new streaming/store schema or Image contract is introduced.


## Additive Phase 8 `audio.library` (1.0)

Independent product metadata keyed by existing Audio Asset ID, scoped only by the authenticated ST session. No client user/path/source/backend fields. All controls require `X-TTB-Protocol: 1.0` and current `X-TTB-Context`; POST also requires trusted Origin/session CSRF. Capability module is `audio-library`, depends on `core` and `audio-assets`. An older Server lacks this optional capability; clients show unavailable instead of browser or Remote fallback.

| Route | Request → result |
| --- | --- |
| GET `/v1/audio/library` | `category=all\|uncategorized\|<id>`, optional `search`, `hidden=true\|false`, `cursor` → page |
| GET `/v1/audio/library/categories` | `{revision,categories:[{categoryId,name}]}` |
| GET `/v1/audio/library/:assetId` | track metadata plus current quick `health` |
| POST `/v1/audio/library/:assetId/update` | `{revision,displayTitle,category:null\|<id>,libraryVisibility:visible\|hidden}` → track metadata |
| POST `/v1/audio/library/:assetId/observe` | `{title}` → track metadata; transactionally initializes only `titleSource:none`; first automatic/user title is preserved |
| POST `/v1/audio/library/categories` | `{operation:create,revision,name}`, `{operation:rename,revision,categoryId,name}` or `{operation:delete,revision,categoryId}` → updated categories |

Track metadata: `assetId,displayTitle,titleSource:none|automatic|user,category:null|categoryId,libraryVisibility:visible|hidden,revision`. An Asset with no stored row reads revision 0, displayTitle `未命名音频`, none/null/visible. Updating category/visibility without changing the effective display title retains titleSource; an actual title change sets user. Observe is first-write-wins only for a title-less row and does not overwrite user edits. Categories have one independent revision for create/rename/delete; stale record/category writes return `AUDIO_LIBRARY_CONFLICT` (409) with a refresh/retry message. Category deletion clears affected record categories and increments each track revision in the same transaction, rejecting outstanding old edits; never deletes Asset.

A list row adds current `health`, canonical session-bound Asset `playbackPath` and `mime`. Default list includes only healthy/visible Assets; `hidden=true` includes hidden and unhealthy existing Assets for explicit inspection/restore. No metadata-only dangling tracks appear. A page is `{items,total,nextCursor,snapshot,revision,categories}`; the top revision belongs to categories, row revision to the track. Maximum 50 rows/page, 4096 Assets, 128 categories; title 120/category 60 JS UTF-16 units, trimmed nonempty/control-free; category IDs are opaque 22-character base64url, Asset IDs retain 32-character Phase 7 form. Bodies are at most 4096 bytes and bounded result envelopes 128 KiB, no-store/nosniff. No original URL, physical path or digest in DTO/logs; metadata names also excluded from operational logs.

Natural title ordering uses zh-CN numeric/base collation and stable Asset ID tie-break. `nextCursor` is opaque offset + snapshot hash; snapshot covers categories, filters and all selected rows/health. Paging after edits/eligibility changes rejects with conflict instead of constructing a mixed playback pool. Search is browsing only; full playback pool must omit search and read every page of the chosen category. Native stream is unchanged Phase 7 Asset GET; unsupported browser codec must not write Server corrupt health.

`INVALID_REQUEST`=400, `CSRF_REJECTED`=403, unknown Asset/category=404, protocol/context/library conflict/category exists/category capacity=409, unavailable/invalid/incompatible store=503. Product metadata never enters Source reference analysis, retention or Local/Remote decisions. Foundation Asset deletion invokes cleanup under the Audio coordinator; list recovery prunes interrupted deletions without granting retention. Source/Asset/Image schemas unchanged. Schema/fixture: `audio.library-1.0.schema.json`, `audio.library-1.0.fixture.json`; clients additionally verify playbackPath matches the row assetId and category IDs belong to the returned category set before applying the ST base path.
