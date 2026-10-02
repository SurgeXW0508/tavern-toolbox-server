# Phase 7 — Remote Audio Access Foundation

Status: **implemented, real-device acceptance pending**. Both repositories continue on `stage/phase-7-remote-audio`, from Frontend main `644d8c3d4907c903512460ec95bf5a40e8a1db54` / Server main `daa7c4b227c06ffb59652ac4c8c33be2490ddc7e`. Formal versions remain Frontend v0.49.0 / Server v0.6.0; Protocol 1.0. Do not merge, tag or release before the NAS/device checks below.

## Behavior and architecture

Browser Direct is the default. The client stores an exact normalized hostname list through `RemoteMediaPreferences`, independently of the deployment Network Allowlist. Pasting a URL stores no path, query, fragment or credentials. Host addition never grants Network permission. Rules belong to the current browser and affect new renders; existing players keep their lifecycle.

The ST 1.19.0 `MessageFormatter` after-Markdown hook holds matched standard HTML Audio sources before DOM insertion. Sources, their order and type remain native. Unmatched direct candidates pass through the host's own MESSAGE_SANITIZE policy separately: ST removes forbidden SOURCE elements, so a deleted sibling must never shift a local fallback. Routed URLs never enter that blocker. Only Formatter-issued in-memory tokens inside `.mes_text` hydrate; no global Audio/new Audio/Web Audio hook, TTS, attachments or other plugin player interception. Same-origin/blob/data audio remains unchanged.

`network.remoteAudio` is an additive capability owned by independent `network-audio`. It shares `approveDestination` and `openApproved` with Image, but uses Streaming Relay instead of complete Image Fetch. Each new GET/Range and redirect validates current Network policy, all DNS answers, protocol, ports and downgrade restrictions; approved public IPs are pinned while Host/TLS SNI retain remote identity. Transport still owns its sockets and never inherits ST's global ProxyAgent. The optional transport profile supplies only server-controlled Accept and validated single Range; browser Cookie/Authorization/Referer/custom headers are not copied upstream.

Protected POST creates a random 192-bit access ID bound to one exact source, Audio profile and authenticated boot-local ST user. IDs are memory-only, expiring, resource bounded and explicitly releasable. Native GET uses the ST session, requires no custom header and never contains the source URL. Inspect returns sanitized failure codes/hostname only; release is idempotent and cannot revoke another user's access. Restarts invalidate old IDs. Source identity stays in memory independently of transport; neither goes into cards, chat, MediaRef, Asset Manager, long-term database or backup.

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

Server-routed source failure never restores its original URL. An independently declared local/direct source may still participate in the browser's normal candidate fallback. Failures show a small resource status with Retry/Network management; administrators can explicitly approve the blocked exact host. No toast flood, custom player or user-facing ticket/socket jargon. Missing Audio capability on older Server fails only the routed candidates; Direct and Image/local functions remain available. Older clients ignore the additive capability.

Network/Media/Localization/Governance schemas and existing Image semantics are unchanged. Image remains complete fetch/validated Blob, with its original setting and failure behavior. Audio does not join Media or governance.

## Automated and manual evidence

`test/audio.test.js` covers isolation, expiry/restart/release, size/header/MIME validation, single Range, 206/416/200, DNS/allowlist/redirect revalidation, idle and abort, independent Image budgets/health, and real HTTP control/session/header/privacy boundaries. Existing network and host-ProxyAgent regression tests remain required. Frontend tests cover normalization, zero request Direct, pre-insertion suppression, atomic multi-source preparation, ST element-removal policy, native candidate fallback, no silent fallback, expiry renewal, chat/removal cleanup and preference UI; client tests cover old Server and protected opaque access.

Local environments that prohibit abstract Unix sockets cannot complete existing Network policy lock tests. Do not weaken the kernel-lock implementation or mark those tests passed; the normal Ubuntu CI must complete full `npm run check` and privacy audit. Browser simulation is not real ST/NAS acceptance.

Real acceptance on SillyTavern 1.19.0 Docker/NAS:

1. Update Server to this branch, install dependencies, restart ST; import the current hashed Frontend candidate with the stable script ID (overwrite).
2. In Server settings → Remote Audio, add the failing audio URL. Verify only hostname persists. Separately authorize that host in Network if necessary, including any redirected host only after a visible refusal and explicit approval.
3. Cold cache, client proxy OFF, NAS proxy ON: Desktop/Phone/Tablet Chrome each play, pause/resume, seek forward/backward, replay and finish. Test MP3 and M4A; real iOS/iPadOS Chrome still requires its WebKit media stack to be tested.
4. Desktop Network must show same-origin `/v1/network/audio/stream/<opaque-id>` and Range GETs, with no original-host request. Verify one multi-source player and one local/unmatched Audio remain correct; try Forbid External Media enabled.
5. Denied host, Server OFF and proxy OFF must fail visibly without direct fallback; restore, Retry and verify recovery. Removing the rule changes new render to Direct. Switch chat while playing; upstream work should stop. Long legitimate audio must exceed Image's timeout without truncation.
6. Image routing, one localized Image, Asset Manager/Picker, Network allow/remove and local Worldbook/backup remain correct. Keep any existing real data backup; no automatic migration or deletion is introduced.

## Explicit non-goals and extension points

No localization, MediaRef, audio assets/quota/governance, persistent cache, automatic downloads, FFmpeg/transcoding/waveforms, video, HLS/DASH, live/infinite streams, WebRTC/MediaSource, authentication-required remote sources, Referer spoofing, cross-device routing sync, universal proxy or Range emulation.

Future consumers must register explicitly. Future localization resolves source identity before choosing transport; future video can add a concrete profile on the Streaming Relay without duplicating destination safety. A future preference adapter can sync rules without coupling routing to UI or localStorage. None of these future systems is implemented here.
