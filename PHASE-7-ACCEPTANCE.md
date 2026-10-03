# Phase 7 — Stable Audio Source & Remote Audio Foundation

Status: **Stable Remote Source implemented, mandatory first real-device stop**. New `stage/phase-7-audio-source` branches start at Frontend `83cdb90d94b92e2edf695fa8fc732062dff7b35c` / Server `2d590c67e1be5a38dade3af9e12581599c357b07`. Old `stage/phase-7-remote-audio` remains experiment history; Adapter Frontend commits never enter this candidate. Formal versions remain Frontend v0.49.0 / Server v0.6.0; Protocol 1.0. No main/tag/release. Do not implement Audio Asset/localization before the first gate passes.

## Behavior and architecture

Browser Direct is the default. The client stores an exact normalized hostname list through `RemoteMediaPreferences`, independently of the deployment Network Allowlist. Pasting a URL stores no path, query, fragment or credentials. Host addition never grants Network permission. Rules belong to the authenticated ST user and affect new renders; existing players keep their lifecycle. `preferences.audioRouting` is a separate, bounded read/add/remove capability: per-user `tavern-toolbox-server/preferences-v1/audio-routing.sqlite`, at most 128 canonical hostnames, atomic SQLite transactions with durable commits. No client-selected user/path, arbitrary KV or Network policy write. Origin/CSRF/protocol and discovery-context binding protect writes, including stale-user tabs. Reads occur at initialization and settings opening; revisions prevent older responses from replacing newer memory snapshots. Legacy browser-local hosts are shown only for explicit merge/import, never read as authoritative rules. No persistent browser cache is added.

Until the first authoritative snapshot is loaded, external HTTP(S) Audio candidates are synchronously quarantined; local/same-origin/blob/data audio stays native. Hydration awaits the snapshot, then routes matches or restores unmatched Direct candidates only through the ST sanitizer. Sync unavailability is visible and never creates a local-only modification. Last confirmed in-memory rules survive read failures; user/boot changes clear them immediately.

The ST 1.19.0 `MessageFormatter` after-Markdown hook holds matched standard HTML Audio sources before DOM insertion. Sources, their order and type remain native. Unmatched direct candidates pass through the host's own MESSAGE_SANITIZE policy separately: ST removes forbidden SOURCE elements, so a deleted sibling must never shift a local fallback. Routed URLs never enter that blocker. Only Formatter-issued in-memory tokens inside `.mes_text` hydrate; no global Audio/new Audio/Web Audio hook, TTS, attachments or other plugin player interception. Same-origin/blob/data audio remains unchanged.

`network.remoteAudio` is an additive capability owned by independent `network-audio`. It shares `approveDestination` and `openApproved` with Image, but uses Streaming Relay instead of complete Image Fetch. Each new GET/Range and redirect validates current Network policy, all DNS answers, protocol, ports and downgrade restrictions; approved public IPs are pinned while Host/TLS SNI retain remote identity. Transport still owns its sockets and never inherits ST's global ProxyAgent. The optional transport profile supplies only server-controlled Accept and validated single Range; browser Cookie/Authorization/Referer/custom headers are not copied upstream.

Protected POST creates a random 192-bit access ID bound to one exact source, Audio profile and authenticated boot-local ST user. IDs are memory-only, expiring, resource bounded and explicitly releasable. Native GET uses the ST session, requires no custom header and never contains the source URL. Inspect returns sanitized failure codes/hostname only; release is idempotent and cannot revoke another user's access. Restarts invalidate old IDs. For standard HTML, source identity stays in memory independently of temporary transport; neither goes into cards, chat, MediaRef, Asset Manager, long-term database or backup. Stable Sources below deliberately persist private metadata and publish a durable opaque path.

Relay copies with backpressure and bounded body reads. 206/Content-Range, 416/Content-Range and ignored-Range 200 remain upstream semantics; no emulation, multi-range or multipart. 200 requires reliable Content-Length; 206/416 require a finite numeric whole-resource total. Validate the whole resource against the size budget, even for a tiny range. Unknown size, compressed representations and arbitrary binary MIME fail closed. Standard audio MIME is accepted without codec conversion; browsers decide playback support.

## Independent limits

Optional deployment-level `audio` configuration is additive; existing configuration needs no edit. Invalid Audio limits disable Audio alone. These defaults are bounded implementation choices, not permanent product contracts:

| Limit | Default |
| --- | --- |
| Whole resource | 256 MiB (configurable to 1 GiB) |
| Connect / headers / first body byte | 5 s / 10 s / 10 s |
| Idle while awaiting upstream data | 30 s; no short total transfer timeout |
| Concurrent streams per user / global | 4 / 16 |
| Stream requests per user per minute | 240; separate from Image |
| Access creations per user per minute | 120 |
| Access records per user / global | 64 / 1024 |
| Access lifetime | 30 min (bounded configurable maximum 60 min) |

Client disconnect, DOM removal, chat change, explicit release or shutdown cancels unused upstream work. Backpressure does not count as upstream idle. Active legitimate transfer need not be cut at access expiry; subsequent GET/Range must use a valid access. Frontend can renew an expired/missing access once on playback failure and retains original source and seek position; further failure exposes Retry. Native autoplay/gesture policy remains authoritative.

## Failure and compatibility

Server-routed source failure never restores its original URL. An independently declared local/direct source may still participate in the browser's normal candidate fallback. Failures show a small resource status with Retry/Network management; administrators can explicitly approve the blocked exact host. No toast flood, custom player or user-facing ticket/socket jargon. Missing Audio capability on older Server fails routed candidates. Missing sync capability keeps external audio paused until configuration can be read; same-origin/blob/data Audio and Image/local functions remain available. Older clients ignore the additive capability.

Network/Media/Localization/Governance schemas and existing Image semantics are unchanged. Image remains complete fetch/validated Blob, with its original setting and failure behavior. Audio does not join Media or governance.

## Image RESOURCE_BUSY investigation

The cancellation defect already exists in the current Phase 6 main transport; it is not caused by Audio sharing Image budgets. A real HTTP proxy fixture reproduced a permanent Image slot leak: CONNECT returns 200, then TLS never completes. The connect timer was cleared at CONNECT; `signal.abort` destroyed the pending TLS socket without completing the async Agent callback. Node can defer the outer request error until that callback completes, so `fetchImage` remained awaiting `openApproved` and never reached its counter-release `finally`, even after total timeout/client cancellation. Once slots were exhausted, later Image tests returned RESOURCE_BUSY until restart.

The shared transport now covers the entire CONNECT/TLS acquisition with the existing connect timeout and completes the callback exactly once on timeout, abort, TLS error or premature close, removing its listener/timer and destroying failed connections. No limit, policy, header, certificate verification, IP pinning or fallback change. The real proxy regression fails before the fix (still pending past total timeout), passes after it, and confirms recovery for Desktop/Phone/Tablet clients without restart. The same fixture also exercises actual browser HTTP disconnect through the installed-host route and recovers before connect/total timeout. Existing tests cover real HTTP disconnect, pending DNS, body idle/total timeouts, redirects/validation, shutdown and released per-user/global slots. Audio owns separate counters/rate budgets; its streaming and first-byte/idle lifecycle cannot occupy Image slots. Frontend Image cancellation still reaches Server's response-close controller; Blob, localization, MediaRef and Asset Manager code is unchanged.

This is a confirmed code defect consistent with the reported incident, not proof of the unlogged production trigger. A continuously failing proxy/TLS environment can still cause repeat bounded failures, and legitimate concurrent image requests can transiently return RESOURCE_BUSY; neither should leave permanent occupancy after the corrected lifecycle ends.

## Automated and manual evidence

`test/audio-routing-preferences.test.js` covers durable same-user cross-client reads/add/remove, atomic concurrent edits, user isolation, hostname-only limits, context-bound/CSRF routes and storage failure. `test/network-connect-lifecycle.test.js` reproduces the proxy TLS leak and recovery. `test/audio.test.js` covers isolation, expiry/restart/release, size/header/MIME validation, single Range, 206/416/200, DNS/allowlist/redirect revalidation, idle and abort, independent Image budgets/health, and real HTTP control/session/header/privacy boundaries. Existing network and host-ProxyAgent regression tests remain required. Frontend tests cover normalization, zero request Direct, pre-insertion suppression, atomic multi-source preparation, ST element-removal policy, native candidate fallback, no silent fallback, expiry renewal, chat/removal cleanup and preference UI; client tests cover old Server and protected opaque access.

Local environments that prohibit abstract Unix sockets cannot complete existing Network policy lock tests. Do not weaken the kernel-lock implementation or mark those tests passed; the normal Ubuntu CI must complete full `npm run check` and privacy audit. Browser simulation is not real ST/NAS acceptance.

Real acceptance on SillyTavern 1.19.0 Docker/NAS:

1. Update Server to this branch, install dependencies, restart ST; import the current hashed Frontend candidate with the stable script ID (overwrite).
2. On Desktop in Server settings → Remote Audio, explicitly import legacy browser hosts or add the failing audio URL. Phone/Tablet refresh or open settings: identical hosts must appear without manual addition, and new Audio renders must use Server. Phone deletes a host; Desktop refresh sees removal. Another ST user sees only its own hosts. Verify only hostname persists. Separately authorize that host in Network if necessary, including any redirected host only after a visible refusal and explicit approval.
3. Cold cache, client proxy OFF, NAS proxy ON: Desktop/Phone/Tablet Chrome each play, pause/resume, seek forward/backward, replay and finish. Test MP3 and M4A; real iOS/iPadOS Chrome still requires its WebKit media stack to be tested.
4. Desktop Network must show same-origin `/v1/network/audio/stream/<opaque-id>` and Range GETs, with no original-host request. Verify one multi-source player and one local/unmatched Audio remain correct; try Forbid External Media enabled.
5. Denied host, Server OFF and proxy OFF must fail visibly without direct fallback; restore, Retry and verify recovery. Removing the rule changes new render to Direct. Switch chat while playing; upstream work should stop. Long legitimate audio must exceed Image's timeout without truncation.
6. Image routing, one localized Image, Asset Manager/Picker, Network allow/remove and local Worldbook/backup remain correct. Keep any existing real data backup; no automatic migration or deletion is introduced.

## Explicit non-goals and extension points

No localization, MediaRef, audio assets/quota/governance, persistent cache, automatic downloads, FFmpeg/transcoding/waveforms, video, HLS/DASH, live/infinite streams, WebRTC/MediaSource, authentication-required remote sources, Referer spoofing, universal proxy or Range emulation.

Future consumers must register explicitly. Future localization resolves source identity before choosing transport; future video can add a concrete profile on the Streaming Relay without duplicating destination safety. The synchronized preference adapter remains independent of Formatter, UI and localStorage; real-time pushes are not required. None of these future systems is implemented here.

## Stable Source first-stage gate

Independent `audio.sources` private SQLite Registry persists canonical Source identity, random opaque ID and backend separately from future Assets; does not reuse Image MediaStore. Same-user concurrent creates atomically reuse the exact canonical URL; title/filename never establish identity. Source metadata creation does not fetch or allow a host. Stable root-relative native GET authenticates the current user, resolves backend, and uses the existing Audio Relay/budget (shared with standard Audio, independent of Image), with current Network policy and safe headers on every GET/Range. Restart preserves sources/paths. Delete yields future 404 and does not delete Assets. Source URL/identity hash never enters public DTO or logs. Original URL does live in private Source DB, so its user data backup must remain private. Only Remote is implemented; a Local/unknown backend explicitly fails without fallback.

Automated `test/audio-sources.test.js` covers multiple Registry clients and durable reuse/restart, separate users, canonical identity/query distinction, max count/pagination, private metadata, current Allowlist/DNS/redirect safety, real 200/206/416 and malformed ranges, abort/recovered budgets, Image isolation, protected control/native routes, no upstream browser headers or sensitive logs, deleted sources and unavailable storage. Contract fixture/schema are committed. Chromium 153 consumes the user's complete original media script as module data, only exact URL values replaced. URL/srcdoc/blob iframes without base tag run detached parent Audio, frequency analysis and pause/resume; original full Runtime also boots unchanged. Native Source preview validates forward/back seek and actual Range. No Adapter API/hooks. Browser original-host media requests zero; failure/recovery, another user 404, Server reinitialization unchanged stable URL, and three viewport screenshots checked. This fixture is not NAS or actual device acceptance.

First installed-host validation:

1. Update Server to this new branch SHA/restart; load the matching temporary Frontend JSON. Disable old Adapter scripts, retain the original Runtime/Schema/opening/regex. Network Allowlist still requires independent authorization.
2. In Server settings → Audio Sources → media-library validation copy, load the delivered validation pack and explicitly create/reuse. Download the Stable URL media-library JSON and overwrite-import its original ID. Keep the author's original file. Source IDs must be created in this NAS/current user's Registry, so do not import the validation pack as a script or use developer-fixture IDs.
3. Saved browser music overrides may still point at old URLs. Use explicit replacement on this browser or reselect a converted track in the original player; check Desktop and Phone separately. No silent migration/clearing. Little-phone Runtime has a separate embedded catalog, intentionally unmodified; validate media-library/opening music in this first gate.
4. NAS Proxy ON, Desktop and Phone proxy OFF: loading/play/spectrum/pause/resume must work with original player functions. Stable path only in DevTools; no original-host Audio media request. Use available original seek controls or the Toolbox native Source preview to verify Seek; original library API has no added seek method. Tablet basic play/seek too.
5. Denied host/stopped proxy/server must fail with no direct request; restore then retry/rerender. Restart Server and reuse the same media copy. Standard audio/source Relay and Remote Image smoke must remain intact.

**Stop here until the user confirms**. If relative URL/iframe assumptions fail on the real card, solve that before adding Assets. After pass, implement separate Audio Asset staging/digest/quota/atomic binding and local file Range; stop a second time using the exact same stable-media JSON. Only after that pass complete generic inert JSON string URL scanning/UX. No Runtime Adapter, global interceptor, Image schema changes or release closeout in the first stage.
