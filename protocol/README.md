# Protocol 1.0 — Core discovery

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
