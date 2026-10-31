# Protocol 1.0 — Core discovery

## Stage additive Account Documents 1.0

Account Settings Sync on `stage/account-settings-sync`, not a formal release. Optional `account.documents` capability advertises `read` / `commit` and registered `constraints.consumers[{id,schemaVersion,maxBytes,limits}]`. Clients negotiate each operation and Consumer schema independently, not by package version. Read availability does not require commit availability; a read-only deployment can serve existing settings. Public Protocol remains 1.0; Business Schema 1 and its revision are independent.

| Operation | Route relative to plugin base | Input |
| --- | --- | --- |
| read | `GET /v1/account/documents/:id?schemaVersion=1` | Registered ID, exact schema query |
| commit | `POST /v1/account/documents/:id/commit` | `{schemaVersion:1,expectedRevision,payload}` |

Both routes require authenticated ST user, `X-TTB-Protocol: 1.0` and exact `X-TTB-Context`; POST also requires trusted same-origin JSON and session CSRF. Success data: `{documentId,schemaVersion,revision,payload,contextId}`. Empty document is revision 0/payload null. First commit expects 0; subsequent commits expect the current independent document revision and increment it once. No delete/reset or arbitrary namespace operation. New boot/context requires reread; revision may legitimately decrease after stopped restore. Responses use the existing success/error envelope and private/no-store headers.

Production Consumer `outfit-settings` is registered at schemaVersion 1. Payload keys: `settingsVersion:5`, boolean `injectionEnabled`, `injectionPosition` enum compatibility/balanced/constraint, activeNarrativePresetId, customNarrativePresets array of `{id,name,builtin:false,protocols:{fixed,scene,mixed}}`. Builtin IDs are balanced/first-reveal/subtle/state-first and cannot be custom IDs; no builtin prompt text is stored. Obsolete active IDs remain parseable so the frontend can apply its current builtin fallback. Limits: ID 100 chars, name 80, each nonblank protocol 8000 JS string code units, preset JSON 96 KiB, 128 custom presets, document JSON 1 MiB UTF-8. Unknown keys, duplicate/custom builtin IDs, invalid types or incomplete protocols reject the entire payload.

Discovery consumers `worldbook-discovery-settings` / `worldbook-discovery-prompts` are independently registered at schemaVersion 1. Settings payload has exactly `promptId, connectionId, count, contextBudget, historyDepth, extractRules, excludeRules, includeStorySummary, includeMvu, includeWorldbook, worldbookMode, worldbookSelections`. IDs use 1–128 ASCII letters/digits/colon/underscore/hyphen; connectionId may be empty (device default policy). Count/history 1–100 integers; budget 4096–1048576; rule arrays <=40 of exact `{start,end}` nonblank strings <=200; booleans exact; mode matched/enabled/selected. Selections map trimmed book names <=512 to unique nonblank string UIDs <=128, <=128 books, <=512/book and <=4096 total. JSON limit 256 KiB. Missing cross-document/runtime references remain representable; frontend owns fail-safe behavior, never implicit repair writes.

Prompt payload is exactly `{schemes:[...]}`. Custom Scheme has exact `{id,name,description,prompt,blocks,schemaVersion:2,createdAt,updatedAt,factory:false}`; `balanced` cannot be a custom ID. Name <=80, description <=180; timestamps nonnegative safe integers. Blocks are ordered, <=107 including the seven required distinct system types principles/worldbook/summary/history/mvu/candidates/request with canonical ID and role (system, except history and user_input respectively). Only principles carries content and must equal Scheme.prompt. Custom blocks have exact `{id,type:'custom',name,role,content}`, unique nonreserved IDs, name <=80, role system/assistant/user. Nonblank trimmed content <=30000 JS code units; <=512 KiB/Scheme, <=128 Schemes, <=2 MiB Library JSON. Unknown keys, duplicates, invalid roles/factory claims/bounds fail whole-document. No cross-document transaction, server merge or migration is implied. Authentication/context/Origin/CSRF/no-store and stopped-restore rules above apply unchanged.

Errors include DOCUMENT_NOT_REGISTERED (404), DOCUMENT_SCHEMA_INCOMPATIBLE / REVISION_CONFLICT / CONTEXT_CHANGED (409), DOCUMENT_INVALID (422), DOCUMENT_TOO_LARGE (413), INVALID_REQUEST (400), CSRF_REJECTED (403), DOCUMENT_STORE_UNAVAILABLE (503). Internal schema/corruption details remain sanitized. No partial payload is saved and conflicts are never automatically retried. Durable path and stopped-backup/rollback rules are in the operator README.

Formal Server v0.11.0 / Frontend v0.54.0 retains Protocol 1.0 and includes independent Worldbook Core, Worldbook Media/Video and Server Outfit Video contracts. Worldbook storage uses schema 4, Video schema 2 and Outfit Video schema 1; wire/feature versions remain independent from storage and release versions. Phase 8 added `audio.library` (see its contract below). The existing Phase 7 public contracts remain [`network.remoteAudio`](#additive-phase-7-networkremoteaudio-contract-10), [`preferences.audioRouting`](#additive-phase-7-preferencesaudiorouting-contract-10), [`audio.sources`](#additive-phase-7-audiosources-contract-10) and [`audio.assets`](#additive-phase-7-audioassets-and-source-binding-operations-10), each with schema/fixture. Selected Source `restore` belongs to audio.sources and returns sensitive metadata only through protected explicit POST.

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

`media.governance` contract 1.0 advertises `summary`, `assets`, `groups`, `detail`, `group`, `action`, `deleteBatch`, optional `groupOverview` / `groupAction`. Query pages have `offset` >= 0, `limit` 1–48 (default 24), `search` <=160 characters, optional `consumer` / Group `provider` (strings <=160), `state` (active/detached/unreferenced/unknown), `kind=image`, `sort=newest|oldest|largest|smallest`, and `broken=true` for Groups. Asset and group detail paginate their Reference arrays too. JSON results are bounded to 256 KiB. The browser never submits reference-count/deletion authority.

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

## Additive Phase 9 Image group maintenance (contract 1.0)

Association browsing (`groups` and `groupOverview`) excludes `lifecycle=active && referenceCount=0` before filtering counts, previews and paging. Detached zero-reference records remain queryable, including state=detached maintenance browsing; unavailable/incomplete Providers retain unknown health/count semantics. This is a browse rule only: full reference analysis and exact Group reads/mutations retain the record, with no store changes or automatic GC.

Optional read `media.governance.groupOverview` exposes GET `/v1/governance/groupOverview` with existing search/consumer/state/broken filters and `previewLimit` 1–6 (default 6), offset 0 only. It returns `{complete,sections:[{id,consumer,label,state,total,items}]}`. Each registered Provider remains represented: complete analysis has an exact filtered Group count and at most previewLimit safe Group summaries; unavailable analysis has total null and no false empty/zero claim. Group summaries include missing-reference `brokenCount` and omit raw reference arrays, URLs/digests/paths. One request performs exactly one Media Catalog and one pass over all Reference Providers, with no Storage read, no per-Consumer requests or preview asset loading. Old Servers may omit this operation; clients retain a single bounded legacy groups request and unknown counts, with explicit scoped browsing. Group `provider` scopes a paginated Collection without mixing identically named Consumers. This read is an additive capability under the same Protocol/contract/authenticated context and 256 KiB response bound; it does not authorize mutation or change IDs/schemas.

Optional `media.governance.groupAction` is advertised separately and unavailable when origin-protected mutations are disabled. Old clients/routes remain valid; old Servers without the operation still support browsing and individual reference maintenance.

- GET group adds Group `brokenCount` (missing reference occurrences across the whole Group) and `usage:{assetCount,exclusiveCount,sharedCount,missingCount}`. Counts deduplicate Asset IDs across all group references. Exclusive/shared counts are `null` when analysis is incomplete; missing assets are separate. Each paginated reference adds existing safe catalog `asset` metadata or `null`, without source URL/digest/path. Group/provider revision remains Consumer-owned.
- POST `/v1/governance/groupAction` accepts `{providerId,groupId,revision,action,cleanup,hostId?}`, with action `unlinkGroup|forgetGroup` and required boolean cleanup. Unknown keys/actions fail. It returns `{revision,unlinkedCount,deletedCount,retainedCount,missingCount,sharedCount,failedCount,cleanup,complete?}`; unlinked counts occurrences, resource counts unique removed Asset candidates. Already-missing catalog entries count as missing (no deletion needed), never retained or failed, with or without cleanup. Without cleanup, existing candidates are retained. With cleanup, incomplete analysis retains existing candidates and reports failures; sharedCount counts existing protected candidates, and failedCount reports unresolved cleanup of retained candidates. deletedCount + retainedCount + missingCount equals the number of unique candidates; shared/failed counts explain retention rather than adding candidates. The missingCount field is additive; older clients may ignore it.
- Character active group supports `unlinkGroup`, matching the Group-owned hostId against the current characters directory identity/proof and Localization revision; it does not require a matching active chat. Detached supports `forgetGroup`; rebind still uses existing action with an explicit current Character selected by the frontend, target nonempty is rejected. Outfit supports `unlinkGroup`, clearing its image reference while preserving the record under Business revision. Providers implement optional `mutateGroup` for one atomic Consumer CAS, returning removed IDs internally. No per-reference loop masquerades as an atomic group write.

The unlink/forget commit and cleanup are intentionally separate. Cleanup reacquires the same per-user reference coordinator and performs one new analysis of every current Provider; it only deletes the exact unique candidates returned by the committed Consumer operation. A new reference created between the two phases protects the asset. The coordinator stays held through the final delete, preventing participating reference writers from entering. No precomputed browser count or Group preview authorizes deletion, no distributed transaction/rollback or global orphan sweep is implied. Partial cleanup does not undo successful unlink. Origin/CSRF/context checks remain identical to existing mutations.

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

Natural title ordering uses zh-CN numeric/base collation and stable Asset ID tie-break. `nextCursor` is opaque offset + snapshot hash; snapshot covers categories, filters and all selected rows/health. Paging after edits/eligibility changes rejects with conflict instead of constructing a mixed playback pool. Search is browsing only. Clients without the optional playbackPool operation omit search and read every page of the chosen category. Clients negotiating playbackPool use the complete read described below. Native stream is unchanged Phase 7 Asset GET; unsupported browser codec must not write Server corrupt health.

`INVALID_REQUEST`=400, `CSRF_REJECTED`=403, unknown Asset/category=404, protocol/context/library conflict/category exists/category capacity=409, unavailable/invalid/incompatible store=503. Product metadata never enters Source reference analysis, retention or Local/Remote decisions. Foundation Asset deletion invokes cleanup under the Audio coordinator; list recovery prunes interrupted deletions without granting retention. Source/Asset/Image schemas unchanged. Schema/fixture: `audio.library-1.0.schema.json`, `audio.library-1.0.fixture.json`; clients additionally verify playbackPath matches the row assetId and category IDs belong to the returned category set before applying the ST base path.

### Optional Audio Library playbackPool

`GET /v1/audio/library/playback-pool?category=all|uncategorized|<categoryId>` is available only when `audio.library` advertises operation `playbackPool`. Category defaults to all; search, hidden, cursor and unknown query fields are rejected. Authentication, exact Protocol 1.0/context, no-store/nosniff and user isolation are the same as list. It is additive; package-version matching is not required.

The DTO uses list fields but contains the entire healthy/visible category, `total === items.length`, `nextCursor === null`, maximum 4096 items and a 4 MiB envelope (`maxPlaybackPoolBytes`). Natural order, canonical paths, unique IDs, category membership and current eligibility rules are unchanged. The same per-user Audio coordinator protects metadata/Asset reads. No retained server snapshot or health cache is created. Client response limits increase only for this operation; normal list stays 50 rows / 128 KiB. Playback still revalidates the selected Asset and its file; the pool never authorizes deletion or guarantees that a file cannot change after the response.

### Optional Audio browse snapshots

`audio.library/browse` (`GET /v1/audio/library/browse`) accepts the same category/search/hidden filters as `list`, and returns its existing 50-row page shape. `audio.assets/browse` (`GET /v1/audio/assets/browse`) accepts only an optional cursor, and returns the existing Asset page/summary shape except that its cursor is `offset~16-hex-token`, not an Asset ID. Both operations must be explicitly negotiated; legacy `list` requests, cursor formats and response ceilings remain supported. Do not mix cursors between operations.

A browse traversal observes membership, order, total and global summary from one scan. Continuations bind the authenticated user root, context, query and process-local token. They compare current validated metadata/reference counts and Asset database change stamps, recheck the returned page's files, then compare metadata again before responding. Internal changes, on-page health changes, expiry, eviction or restart require a fresh first page (`AUDIO_BROWSE_EXPIRED`, HTTP 409); clients must not append results from a new scan or silently switch to legacy pages. Off-page filesystem changes appear on refresh, not retroactively in a scan-time summary. Already displayed client rows are observations, not authority.

The shared Audio read owner retains at most 2 snapshots per user / 8 globally for 60 seconds after scan completion, each with at most 4096 rows. Reads are admitted at most 1 per user / 4 globally (`RESOURCE_BUSY`, HTTP 429), with at most 4 concurrent file checks per read. A 30-second cooperative deadline, request disconnect and shutdown stop scheduling further work; already-issued filesystem calls and queued coordinator acquisition must drain before resources are released. This is not a hard kernel-I/O deadline. Snapshots expire on a sweep and all are released at shutdown.

Filesystem checks occur outside the Source/Asset write coordinator. Capture and final validation use the existing coordinator; an overlapping write causes a conflict rather than a partial result. Complete `playbackPool` always performs a fresh category scan and retains no browse snapshot. Direct reads, stream opening, integrity checks, bindings and deletion retain their live validation and locking. Cached `orphan` counts must never authorize deletion; cleanup still confirms the exact requested IDs against current Source bindings. No persisted schema or global protocol-version change is involved.

Outfit Reference Group description is Consumer-owned display context: 单品, 穿搭组合, 具体搭配 or 场景组. This replaces internal kind strings only in the existing presentation field; Business documents, graph ownership, MediaRef and mutation contracts remain unchanged. Generic clients display the text without parsing Outfit schemas or building a parent tree.

## Worldbook Core 1.0

Optional capability `worldbook.core`, module `worldbook`, contract major 1 / minor 0, schema 1. Independent operation availability: `summary`, `catalog`, `tree`, `detail`, `sources`, `runtime`, `command`, `features`. All routes are relative to the authenticated plugin base and require `X-TTB-Protocol: 1.0` / current `X-TTB-Context`; Runtime and command POSTs additionally require trusted Origin and ST CSRF; features POST is an authenticated read. Core success/failure envelope, response <=128 KiB, POST body <=256 KiB. See [Worldbook semantics and limits](../docs/WORLDBOOK.md).

| Method / route | Input / response data |
| --- | --- |
| GET `/v1/worldbook/summary?page=1` | schemaVersion, columns <=32 (ID/appearance/order/revisions/materialCount), total/page/pageSize/nextPage |
| GET `/v1/worldbook/catalog` | Optional columnId, q <=160, exact type, tags as JSON string array (AND), favorite=true, page; returns items <=20 without Description, referenced columns <=20, total/page/pageSize/pageCount |
| GET `/v1/worldbook/columns/:id/tree?cursor=…` | items <=50: kind/id/name/parentId/order/revision, Material Source ID/locator/UID; column summary, nextCursor=null or treeRevision:offset |
| GET `/v1/worldbook/materials/:id` | Exact material with Description plus its column summary |
| GET `/v1/worldbook/sources?page=1` | Referenced source metadata <=50: id/locator/displayName; total/nextPage |
| POST `/v1/worldbook/runtime` | `{token?,offset,bindings:[{locator,uid}],complete}` <=100/batch; returns token/received/complete/expiresAt |
| POST `/v1/worldbook/commands` | `{commandId,action,data}`; confirmed minimal acknowledgment, affected columns <=2, sourcesAdded/sourceIdsRemoved, replayed; column reorder also sets summaryChanged |

Catalog also accepts runtimeToken for temporary native-enabled intersection, or sourceId + uid to browse individual same-source Materials. Runtime batch offsets allow exact replay, reject modified replay and expire after 60 seconds; tokens are user/context bound and never persisted. Global Catalog filters before grouping by stable Source ID + UID and sorting/paging. Stable tie breakers include Column ID and Material ID. Dataset changes may change later pages; Tree continuation explicitly rejects a changed stamp.

Tags retain input order across writes and queries.

Card: id, columnId, parentId, order, revision, name, materialType, summary, tags, favorite, source `{sourceId,locator,uid,title}`, optional memberCount. Detail adds description. No enabled/mode/native body/keywords/media/cover fields are accepted or returned as business data. Source in writes is explicitly `{locator,uid,title}`, with a new/reused Source ID allocated by Server.

Commands and required data:

- column-create: profile `{title,description,icon:{type,value},accent,order?}`, materials? <=100 with explicit source and metadata, optional importFolderName <=80 (source grouping name, independent of profile.title).
- column-update: id, revision, profile; column-delete: id, revision, structureRevision; column-reorder: id/revision/targetId/targetRevision. Builtin appearance/delete/reorder is forbidden.
- material-create: columnId, parentId (null=root), structureRevision, material `{name,source,materialType?,summary?,description?,tags?,favorite?}`.
- material-update: id, revision, fields (nonempty metadata subset only). New source mutations through fields.source are rejected; use binding-rebind with bindingRevision. Creation still requires an explicit source.
- material-copy / material-move: id, revision, source structureRevision, target columnId/parentId/targetStructureRevision, beforeId?; material-delete: id, revision, structureRevision.
- folder-create: columnId, parentId, structureRevision, name; folder-update: id, revision, structureRevision, name.
- folder-move: id, revision, structureRevision, parentId, beforeId? (within its Column); folder-delete: id, revision, structureRevision, deleteContents (false lifts children; true deletes subtree contents).

`commandId`: 13-digit milliseconds + hyphen + UUID, <=5 minutes in the future and <=7 days old. Receipt/digest and entity writes commit atomically. Same ID/content replays the original acknowledgment after restart; changed content fails WORLDBOOK_IDEMPOTENCY_MISMATCH, expired IDs fail WORLDBOOK_COMMAND_EXPIRED, future clock skew fails WORLDBOOK_CLOCK_SKEW. Abort is not rollback. Clients retain uncertain IDs and explicitly retry original content rather than invent a new Create/Copy. A historical receipt returns replayed=true; the client refreshes bounded Column/Source summaries to observe current state instead of applying old membership deltas. Uncertain forms keep their original command and locked inputs until confirmed.

Typed errors: WORLDBOOK_VALIDATION (400), WORLDBOOK_NOT_FOUND (404), WORLDBOOK_CONFLICT / WORLDBOOK_TREE_CHANGED / command mismatch/expiry/runtime expiry/clock skew (409), WORLDBOOK_BUILTIN / CSRF_REJECTED (403), RESOURCE_BUSY (429), schema/capacity/capability/connection failure (503). Unavailable write operations do not disable valid reads. Logs never include private command/query payloads. Existing Business, Media, Audio, Localization and Governance schemas are unchanged.

### Additive Worldbook 10C features

Core 1.0 / Summary wire schema 1 stay compatible; current capability constraints expose storageSchemaVersion 4 / featureVersion 2 (candidateScopes: global, column, filtered, folder). Card/detail add lifecycle=active|detached, bindingRevision, repairPending, relationRevision, enableCount and lastEnabledAt. Source summaries add revision. Unknown is transient and never a persistent lifecycle.

POST `/v1/worldbook/features`: `kind=bindings|picker|companions|presets|facets|plan|tree-search|roll|discovery|session-end`. Bindings use after/sourceId/id/materialIds (<=50)/scope.columnId and return <=50 compact rows/nextCursor. Picker uses subjectId or presetId, scope `{columnId?,q?,type?,tags?,favorite?}`, selected/page and draftAdd/draftRemove<=100; <=20 cards, selectedCount and owner revision. Presets scope.columnId absent means Global, 20/page. Facets id=types|tags, scope/page, 50/page. Plan requires presetId/revision, runtimeToken for exact Column plans, <=50 compact desired-state bindings/page. Tree-search scope.columnId/q/page returns <=10 matches and necessary ancestors.

Runtime observed mode: `{mode:'observed',token?,offset,bindings:[{locator,uid,enabled}],complete,unknownBooks?}`; unknownBooks only offset 0, <=256. <=100 per transfer and <=65536 observed entries; old enabled-only input <=8192 remains. Catalog status=all|enabled|disabled|detached|unknown and sort=default|recent|frequent. Unknown/disabled are distinct under observed runtime.

Roll/Discovery take scope/runtimeToken/limit<=20, optional sessionId/cursor. Replies include sessionId,nextCursor|null,scopeTotal,candidateCount,seen,remaining and bounded cards/columns; folderPath <=16 names, no Description. Sessions 15 minutes, 4/user/16 global, context/TTL protected; exact cursor retries return the last bounded acknowledgment. Session-end uses sessionId (optional runtimeToken); scope/cursor/limit are rejected.

Folder candidates are additive in featureVersion 2: only roll/discovery accept scope `{columnId,folderId}` with both identities required and no extra filters. Generic Catalog/Facet/Picker/Companion/Binding/Preset/Tree-search scopes reject folderId. The Server recursively resolves all descendant Material placements before existing Runtime eligibility, source deduplication and seeded keyset continuation. Companion expansion remains unchanged, including companions outside the folder. Replies add `folderScope:{columnId,folderId,treeRevision,path}` (path 1..16 names). Every continuation and cached replay checks the captured Column treeRevision and folder ownership; any mismatch returns WORLDBOOK_TREE_CHANGED, never fallback to the Column. Missing/foreign folders fail closed. Expired Folder sessions must be explicitly restarted; clients must not transparently recover a new structure version or execute cached paid results without validating the original session. Old Global/Column/Filtered clients remain compatible. No storage migration or protocol bump.

New commands share the original durable commandId/digest transaction: companions-save `{id,revision,memberIds<=64}`; companions-members `{id,revision,add,remove}`; preset-create `{name,columnId|null,memberIds?}`; preset-update/delete/members `{id,revision,name?|add/remove?}`; preset-capture `{id,revision,runtimeToken}`; usage-increment `{materialIds<=100,at}`; binding-observe `{observations<=100}` expected id/sourceId/locator/uid/bindingRevision and observed active|detached/title; binding-rebind `{id,bindingRevision,source}`; source-rebind `{id,revision,locator}`. No ST writes occur on Server. Source collision/duplicate/expired selection session and runtime unavailable are typed 409 errors.


### Optional Worldbook Media 1.0

Capability `worldbook.media`, module `worldbook-media`, contract 1.0, operations `read`/`command`; maxGallery=6, maxReadMaterials=20. Missing capability does not disable `worldbook.core`. Both POST routes require authenticated session/Protocol/current Context; command additionally requires Origin/CSRF. Core command does not accept Media actions.

- POST `/v1/worldbook/media/read`: `{materialIds:[id]}` (1..20 unique), optional `coversOnly:true`. Returns `{items:[{id,revision,cover:null|relation,gallery?}]}`; covers-only omits Gallery.
- POST `/v1/worldbook/media/commands`: `{commandId,action,data}` with durable digest/receipt semantics. Returns Media state and replay marker.
- Relation: `{kind:"image",role:"cover"|"gallery",position,mediaRef:{provider:"server",assetId:UUID}}`. No bytes, URLs or technical metadata.
- Actions: `media-set-cover {id,revision,kind,mediaRef}`, `media-clear-cover {id,revision}`, `media-gallery-add {id,revision,items:[{kind,mediaRef}]}`, `media-gallery-remove {id,revision,assetId}`, `media-gallery-reorder {id,revision,assetIds}` (complete set), `media-to-cover {id,revision,assetId}`, `media-to-gallery {id,revision}`, `media-reference-unlink {id,revision,referenceId}`, `media-reference-replace {id,revision,referenceId,kind,mediaRef}`. Reference IDs are cover or gallery:UUID.

Media revision conflict returns `WORLDBOOK_MEDIA_CONFLICT` (409); invalid shape/provider/kind returns validation 400, unhealthy/missing new asset returns `WORLDBOOK_MEDIA_UNAVAILABLE` (422). Metadata and Binding revisions are unaffected. Governance reference action for Provider worldbook requires current Context and Media CAS. Existing broken refs can be removed without rereading the asset. See paired-backup/rollback requirements in [Worldbook](../docs/WORLDBOOK.md#upgrade-rollback-and-evidence).


### Media presentation (optional additive read)

`media.assets` exposes optional operation `presentation` and limit `maxPresentationAssets:48`. GET `/v1/media/presentation?assetIds=<JSON array>` accepts 1..48 unique canonical UUID strings, decoded query <=2000 characters, no other/duplicate query keys. Requires current ST user, X-TTB-Protocol 1.0 and X-TTB-Context; no write/Origin policy is required. Private/no-store response: `{items:[{assetId,width,height,animated}],missingAssetIds:[UUID]}`. The two arrays partition the requested set, with no duplicate identities; technical fields are bounded per-page projection, never Worldbook business data. Only a metadata SQL query occurs, no Original/health read. Validation=400, context/protocol mismatch=409, unauthenticated=403, unavailable Store=503. No schema, Protocol major or existing operation changes. Older clients ignore this operation; newer Preview code does not issue per-asset metadata fallback when it is missing.

## Optional Video foundation 1.0 (P1 base, P2 additions below)

The active implementation is specified in [Video](../docs/VIDEO.md). Existing Protocol, image/audio/worldbook contracts remain unchanged. Capabilities: `video.catalog` (`list`, `read`, `presentation`), `video.sources` (`roots`, `browse`, `cancel`, `register`), `video.playback` (`resolve`, `stream`). Missing authorized roots disables Video; invalid Video policy only makes Video unavailable. Core status performs no Video filesystem/SQLite I/O. The P2 additions below extend this base capability list; only implemented operations are advertised.

All JSON calls use `X-TTB-Protocol: 1.0` and exact `X-TTB-Context`. All POSTs require configured same-origin Origin and active ST-session CSRF, `application/json`, at most 8192 bytes and strict key/type validation. JSON responses are at most 65536 bytes. Native stream uses the ST authenticated session, Origin/Sec-Fetch-Site policy and exact context/version query instead of custom headers. All replies use private headers. Errors use the existing JSON error envelope; sources/paths/context URLs are absent from logs.

| Method / path relative to plugin | Request | Response |
| --- | --- | --- |
| GET `/v1/video/roots` | no query | `{roots:[{rootKey,label}]}` authorized roots only |
| POST `/v1/video/source-browse` | exactly one of `{rootKey}`, `{directoryId}`, `{cursor}` | `{sessionId,breadcrumbs,rootKey,directoryLabel,entries,nextCursor,expiresAt}` |
| POST `/v1/video/source-browse/cancel` | `{sessionId}` | `{cancelled:true}`; does not reveal other-user ownership |
| POST `/v1/video/register` | `{candidateId,operationId,title}` | Video DTO plus `reused` |
| GET `/v1/video/items` | optional `search` (120 chars), `offset` (0..5000), `limit` (1..48, default 24) | `{items,total,offset,limit,hasMore}` |
| POST `/v1/video/presentation` | `{assetIds:[1..48 unique UUID]}` | `{items,missingAssetIds}` no source I/O |
| GET `/v1/video/items/:id` | no query | Video DTO plus `sourceState: available/changed/unavailable` and optional friendly `rootLabel` |
| POST `/v1/video/items/:id/playback` | `{}` | Video DTO plus transient `playbackPath` |
| GET or HEAD `/v1/video/items/:id/stream?context=...&version=...` | one optional Range | native 200/206/416, correct lengths; HEAD no body |

Video DTO: `{kind:'video',mediaRef:{provider:'server',assetId:UUID},title,mime,byteSize,sourceRevision,metadataRevision,createdAt}`. UUIDs are canonical lowercase v4; title is trimmed 1..120 characters without control characters. JSON Source/Asset identity never includes a path. Playback path is canonical plugin-relative, prefixed on the client for an ST subpath; context and source version are required query keys with no extras/duplicates.

Discovery entry: `{id,kind:'directory',name}` or `{id,kind:'file',name,byteSize,mime}`; invalid/unsupported profile appears `{id,kind:'unavailable',name,reasonCode}` and is not an authorized candidate. No path parameters exist. A snapshot contains at most 1000 inspected entries, 50/page, 2/user and 8/global, 5-minute TTL. No recursive scan, timer, automatic registration or removal. `cancel` frees the snapshot. A root outage/over-limit/cancel fails with no partial success; registered metadata is retained. Register revalidates fingerprint before commit and preserves same-root/locator identity; changed bytes require a later explicit source operation. Receipt is committed atomically with registration, bound to operationId and request payload, one-day TTL and 10000/user bound. Exact replay can recover a committed result even if the candidate has since expired; a different payload using that operationId fails.

Errors: `INVALID_REQUEST`/`UNSUPPORTED_RANGE` 400; `CSRF_REJECTED`/`FORBIDDEN` 403; `VIDEO_NOT_FOUND` 404; `CONTEXT_CHANGED`/`VIDEO_SOURCE_CHANGED`/`VIDEO_OPERATION_CONFLICT`/`VIDEO_CANDIDATE_EXPIRED`/`VIDEO_CATALOG_FULL` 409; `VIDEO_FORMAT_UNSUPPORTED` 415; `VIDEO_SOURCE_UNAVAILABLE`/`VIDEO_DIRECTORY_LIMIT` 422; `RESOURCE_BUSY` 429; unavailable runtime/store/schema/config 503. Post-header I/O failure closes the binary response. Same-user missing and foreign identities have equivalent not-found behavior when Video is otherwise authorized.

P2 progress/poster/source-replacement contracts are specified below; Consumer relations remain future work. The shared machine-readable P1/P2 request/result/state/error fixtures are `video.foundation-1.0.schema.json` / `video.foundation-1.0.fixture.json`.

Directory navigation returns bounded `breadcrumbs:[{id,label}]` with directory capability IDs for root and each ancestor (maximum 33). A successful `directoryId` navigation replaces its source snapshot; old file candidates/cursors then expire. A failed navigation preserves the previous snapshot. This bounds retained directory data while allowing navigation back to ancestors without client paths; two independent directory browsers still share the 2/user limit.

### Video P2 additive operations / schema 2

`video.catalog` adds update, unregister, operation and references; `video.sources` adds source; optional `video.progress` adds read/write. New Video DTOs include nullable `posterRef` (image MediaRef); old clients may ignore it. JSON POST security, user isolation and private binary headers remain identical to P1. The following routes are relative to `/v1/video`:

| Route | Request / result |
| --- | --- |
| POST `/items/:id/update` | `{operationId,metadataRevision,patch:{title?,posterRef?}}`, nonempty patch; Video DTO result |
| GET `/operations/:operationId` | `{found:false}` or `{found:true,result}`; read-only uncertain-command recovery |
| GET `/items/:id/references` | `{complete,count,references:[{providerId,ownerId,label}]}`, first 100 detail rows |
| POST `/items/:id/unregister` | `{operationId,metadataRevision,sourceRevision}`; `{removed:true}`; fresh complete zero-reference analysis, retains originals |
| POST `/items/:id/source` | `{operationId,sourceRevision,candidateId}`; Video DTO with optional friendly `rootLabel`; explicit acceptance resets progress and increments source version |
| GET `/items/:id/progress` | `{sourceRevision,revision,positionSeconds,durationHint,completed,writeId,updatedAt}`; absent progress has revision 0, zero position, null writeId/updatedAt |
| POST `/items/:id/progress` | `{sourceRevision,expectedProgressRevision,writeId,positionSeconds,durationHint,completed}`; progress DTO result |

Metadata/source/unregister operations have UUID operationId; progress writeId shares the bounded command-receipt store, with action/target/request hash. Exactly identical replay returns the committed result; conflicting payload fails VIDEO_OPERATION_CONFLICT. Source-version mismatch fails VIDEO_SOURCE_CHANGED even if an old progress write was previously committed. POST position/duration must be finite, nonnegative and ≤604800 seconds; completed is boolean. CAS accepts backward seeks. It never reads full files, changes metadata revision or enumerates Consumers. A CAS conflict is VIDEO_PROGRESS_CONFLICT 409; metadata CAS conflict is VIDEO_METADATA_CONFLICT 409. VIDEO_REFERENCED 409 / VIDEO_REFERENCES_INCOMPLETE 503 retain registration; VIDEO_POSTER_UNAVAILABLE 422 rejects unusable images; VIDEO_SOURCE_REGISTERED 409 refuses assigning a file already registered as another video. Read-only operation receipt returns no paths/URL/fingerprint.

Discovery task admission is 2/user, 8/global; all other non-stream Video operations have an independent 8/user, 32/global budget. Retained discovery snapshots remain separately 2/user, 8/global. Streams remain 4/user, 8/global. No request is queued or retried automatically. Frontend gives browse a 60-second deadline and retains 15 seconds for other JSON calls. Source-state observation is distinct from metadata mutation results: title/poster updates do not probe NAS or assert availability.


## Optional Worldbook Video 1.0 / storage schema 4

`worldbook.video` is owned by `worldbook-video`, independent from image-only `worldbook.media`. Operations: `read`, `command`, `operation`. It remains readable/unlinkable when Video roots are disabled; linking validates current user ownership of the Video registration. All three POST routes use Protocol 1.0, current trusted context, Origin/CSRF, JSON body limits and private envelopes, with no query parameters. Core/metadata/image-only command endpoints reject Video commands rather than bypass reference validation.

| Route under `/v1/worldbook/video` | Payload / result |
| --- | --- |
| POST `/read` | `{materialIds:[1..20 unique Material ID]}` → `{items:[{id,revision,attachments:[{kind:'video',position,mediaRef}]}]}` |
| POST `/commands` | `{commandId,action,data}` → `{id,video:{id,revision,attachments},replayed}` |
| POST `/operation` | `{commandId}` → `{found:false}` or `{found:true,result}`; read-only uncertainty recovery |

Actions: `video-add {id,revision,items:[{kind:'video',mediaRef}]}`, `video-remove {id,revision,assetId}`, `video-replace {id,revision,assetId,mediaRef}`, `video-reorder {id,revision,assetIds}`. At most six unique references, contiguous zero-based positions and exact-set reorder; CAS is independent of image/metadata/Binding/progress revisions. Commands retain the existing bounded timestamp-UUID command TTL/digest receipt contract. Exact replay preserves the result; same command ID with altered payload rejects. Ordinary failures never cause an automatic resubmit. `WORLDBOOK_VIDEO_CONFLICT`=409, `WORLDBOOK_VIDEO_UNAVAILABLE`=422; existing validation/not-found/duplicate/capacity/clock/expiry errors apply. No paths, bytes, durations, progress or poster metadata enter relation DTOs.

Image/metadata commands do not alter Video attachments; copy begins media-free, delete uses FK cascade but retains Video registrations/files. Exact reference enumeration has a 30000-row per-target bound, with overflow/unavailable analysis treated as incomplete. Machine-readable request/result/receipt fixtures: `worldbook.video-1.0.schema.json` / `worldbook.video-1.0.fixture.json`. Runtime additionally validates ownership, CAS, contiguous order and command TTL.

## Optional Outfit Video 1.0 / independent relation schema 1

Machine-readable contract and examples: `outfit.video-1.0.schema.json` / `outfit.video-1.0.fixture.json`. Capability `outfit.video` (`outfit-video`) is additive to Protocol 1.0; Business schema 1 / Frontend Outfit schema 7 / Worldbook schema 4 / Video schema 2 do not change.

| Route | Payload → result |
| --- | --- |
| POST `/v1/outfit/video/read` | `{assetId}` → `{assetId,revision,attachments:[{id,kind:'video',position,mediaRef}]}` |
| POST `/v1/outfit/video/commands` | `{commandId,action,data}` → `{relation,replayed}` |
| POST `/v1/outfit/video/operation` | `{commandId}` → `{found:false}` or `{found:true,result}` |

`data` always carries `{assetId,revision}` plus: add `items:[MediaRef]`; replace `attachmentId,mediaRef`; reorder `attachmentIds`; unlink `attachmentId`. Attachment IDs and Video IDs are lowercase UUID v4. Replace retains attachment identity/order; exact-set reorder, unique Video IDs, real Server Asset ownership, command TTL/skew and request hashing are additional runtime checks. Read/receipt/mutation require current context + Origin/CSRF, JSON ≤8 KiB and no query. Max six attachments; initial relation revision 0; 7-day/10,000 command receipts. Conflict/duplicate/replay mismatch/expiry are 409, malformed DTO 400, missing owner/attachment 404, unavailable Video target 422, unavailable/incompatible store 503. Error/response bodies contain no filesystem source, playback or AI fields. Independent relation mutation never increments Business collection revision.

Outfit Video capacity errors are distinct: OUTFIT_VIDEO_CAPACITY (409) means more than six attachments; OUTFIT_VIDEO_RECEIPTS_FULL (503) means the seven-day, 10,000-receipt budget is full; OUTFIT_VIDEO_STORAGE_CAPACITY (503) means a bounded storage/index read exceeded its integrity limit. All are definite rejections, not authorization to resubmit or overwrite. A failed command commits neither a new relation revision nor receipt. DTOs, capability version and independent storage schema remain unchanged.

Server 0.11.0 / Frontend 0.54.0 do not change Protocol 1.0 or these capability contracts. Video store 2 / Worldbook storage 4 / Outfit Video 1 / Business 1 are the released data versions; optional-capability examples are illustrative, not an exhaustive module inventory.
