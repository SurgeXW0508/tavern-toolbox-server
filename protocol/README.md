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

`network.policy` contract 1.0 declares `read`, `add`, `remove`, maxHosts 128 and deployment authority. Availability reflects trusted context and writeability; frontends must inspect exact operations, and the Server rechecks authorization at execution. All routes are relative to the same authenticated plugin base:

| Method / route | Body / result |
| --- | --- |
| GET `/v1/network/policy` | revision (opaque string), destinationPolicy, transport, allowlistEntryCount, administrator, canManage, readOnlyReason; hosts only for admin |
| POST `/v1/network/policy/add` | `{host, includeSubdomains: boolean, revision}`; returns committed current policy view |
| POST `/v1/network/policy/remove` | `{host, revision}`; returns committed view |
| POST `/v1/localization/forget` | `{hostId, scopeId, revision}` with Catalog integer revision; removes detached Scope/bindings only, returns same catalog view as read |

Policy mutation requires trusted administrator, exact permitted Origin and session CSRF. Stale revision gives `POLICY_CONFLICT`, concurrent file lock `POLICY_BUSY`, invalid host `INVALID_HOST`, duplicate `HOST_ALREADY_ALLOWED`, missing `HOST_NOT_FOUND`, bound exceeded `ALLOWLIST_FULL`; readonly/external/changed file states are explicit. Failure remains JSON envelope; it never returns raw config, proxy URL, path or exception. Policy revision is unrelated to Catalog revision. Successful mutation persists the single config and activates; external changes are not silently adopted. Config immutable fields cannot be written through these routes.

An actual allowlist rejection during `network.remoteFetch/fetch` or explicit Character localize may add `{hostname}` to error.details. It identifies the rejected redirect host when applicable and never contains full URL/path/query. Invalid syntax, unsafe DNS and other failure types do not produce a guessed repair target. Existing binary success and older capability compatibility remain unchanged. `media.assets/storage` is reused for `{totalBytes, quotaBytes, ...}` read-only usage; no new Media management API is introduced.
