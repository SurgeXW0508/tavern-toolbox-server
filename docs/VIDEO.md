# Local video foundation

## Current scope: P0/P1/P2 Review Fix candidate

Active paired branch: `stage/video-foundation`, based on Server main v0.10.1 and Frontend main v0.53.1. Optional local registration/streaming, Media Center library/manage/picker/detail/viewer, manual Image posters, independent progress CAS and guarded source maintenance are implemented. P2 is a Review Fix candidate pending NAS/physical-device Gate A, not a completed acceptance/release. P3/P4 Worldbook Video relations/preview and optional P5 Outfit remain unimplemented. Core Protocol stays 1.0, Video SQLite is schema 2; Worldbook schema 3 and image/audio storage do not change. No version bump or Release is implied.

## Deployment policy

Video is optional. Missing configuration leaves it disabled with no video filesystem work. Add `video` alongside existing administrator policy fields (merge into the existing policy, do not replace the whole file):

```json
{
  "video": {
    "maxBytes": 8589934592,
    "roots": [{
      "key": "clips",
      "label": "Clips",
      "path": "/media/video-clips",
      "users": ["example-user"]
    }]
  }
}
```

`path` is a container-side absolute directory controlled by the trusted administrator. Configure a read-only bind mount from the chosen NAS directory; the plugin does not edit Docker or move source files. `users` contains exact trusted ST profile handles, not browser-supplied names or boot-local context IDs. Empty users deny everyone. Root keys remain stable across host relocation. At most 16 roots / 128 users per root, unique keys/users, no filesystem root, invalid fields fail Video only. Maximum per-file size defaults to 8 GiB and has an explicit 64 GiB configurable ceiling. Administrator policy changes take effect at restart; there is no live root-policy editor.

The directories and their parents must be controlled by a trusted administrator. The implementation checks containment, each path component, symlinks, regular files, no-follow/nonblocking open and post-open fingerprints. Node path APIs cannot guarantee safety against a malicious administrator racing replacement of parent directories. A read-only container mount also does not prevent writes from the host: keep registered source files immutable during use. In-place modifications can be detected on new access; active already-open bytes are not continuously hashed or revalidated. Full digest verification and byte-level integrity against an external writer are not claimed.

Roots/list health discovery never traverses directories or opens Video SQLite. Metadata stores initialize lazily on explicit operations. A missing root yields a source error, never successful empty scan/removal. Invalid Video configuration does not disable Core, image, audio or Worldbook text operations.

## Ownership, storage and identity

Each trusted ST user owns `tavern-toolbox-server/video-v1/metadata.sqlite`, schema 2, private directory mode 0700 and DB 0600. Video bytes remain in administrator-authorized external directories. `videos` has stable UUIDs, title, root key/private relative locator, private filesystem fingerprint, MIME, size, source and metadata revisions, creation time; unique root+locator and timestamp/id indexes. `receipts` preserves bounded one-day registration operation replay. No physical copies, Blob/base64 encoding or whole-file content hashes are made. No auto-GC or source deletion exists.

DTOs explicitly contain `kind: video`, `{provider: server, assetId}`, title, MIME, byteSize, sourceRevision, metadataRevision and createdAt. They never contain the source path/fingerprint. IDs do not grant access. Authorization is rechecked against current trusted user/root for read and every native stream. Same locator registration reuses identity; if its fingerprint changed it refuses silently accepting new bytes. Different users have separate DB identities even if the administrator authorizes the same source root.

Fingerprints use device/inode/size/high-resolution modification and change timestamps as strings, not content hashes. Exact detail probes up to 4096 bytes, identifies the bounded MP4 ftyp or WebM EBML DocType profile, and reports available/changed/unavailable. Filename extensions are discovery hints, not MIME authority. Codec decodability remains a device observation; metadata/transport tests do not prove a video can decode. This profile discovers `.mp4`, `.m4v`, `.webm`; other containers remain outside P1.

Back up private Video SQLite consistently with ST stopped, and back up external video directories separately. Poster originals and future Worldbook relations need joint consistent backups. Do not publish metadata, live paths, source names or playback context URLs in diagnostics. Unknown newer or unexpected existing schema fails closed without resetting files. Video does not alter Worldbook schema; code rollback cannot reverse a Video DB migration.

## Bounded discovery and metadata reads

Browse only opens one directory. It asynchronously enumerates at most 1000 entries including unsupported file types, never recursively scans, checks at most 4096 bytes for each candidate video and closes the handle. Unsupported/damaged files are displayed as unavailable, not selectable. Symlink entries are omitted. Exceeding the budget fails explicitly and produces no partial successful snapshot. Existing registrations remain untouched on all failures. A candidate's fingerprint is rechecked before register. Nested directories use opaque short-lived IDs; no frontend path arguments are accepted.

Each snapshot is immutable, private to user/context/root and five-minute TTL, at most 2/user and 8/global; no background timer. Pages are 50, snapshot admission rejects busy rather than silently evicting a pending selection. Cancel by sessionId releases the retained rows. Disconnect cancels active enumeration. Returned directoryLabel is a root-relative presentation breadcrumb, not a physical path. At most 32 locator components; names and request sizes are bounded. Busy admission is checked before enumeration and at commit.

Catalog default 24/max 48, max 5000 videos/user, indexed stable creation-time/id order and SQL search/count/limit/offset. Page DTO projection touches only returned rows. Search is a substring metadata operation and can scan rows; OFFSET/count are not O(pageSize). Neither catalog nor presentation reads source files or claims live health. Presentation is at most 48 unique IDs and no per-item HTTP requests. Detail/resolve checks only its selected file.

## Native streaming and resource ownership

JSON operations require Protocol 1.0 and current X-TTB-Context. All POSTs, including read-only browse/presentation/resolve, require allowed same-origin Origin and current ST session CSRF. Context ID is boot-local and derived from trusted authenticated handle/root, not a durable user key.

Resolve returns a canonical plugin-relative path with transient `context` and `version` query fields. The frontend must apply the actual ST base path, as it already does for Audio. Persist only the MediaRef, never this URL. Native `<video>` cannot add custom headers: GET/HEAD uses the authenticated ST cookie, same-origin guard, exact context query and current source revision. It is not a bearer share link. Switching user or Server boot invalidates the old path; another user with a coincident ID cannot use it.

The common local-file transport now serves Audio and Video using a pinned, already-validated file handle, bounded 64 KiB reads and backpressure. Audio retains its existing signature/range preflight, coordinator and error vocabulary, and no new idle timer; Video applies a 30-second idle timeout. Range allows one interval, open/suffix forms; malformed/multiple/unsafe integer ranges fail before streaming. GET returns 200/206/416, HEAD performs source validation but sends no body. Private no-store/nosniff and same-origin resource policy apply. It never fetches Network.

Video caps active transfer requests at 4/user, 8/global, including pending opens; caps directory-discovery tasks at 2/user and 8/global, independently from other operations (8/user, 32/global, including catalog/progress/reference work and bounded single-file probes). Snapshot retention is separately 2/user and 8/global. All operations still drain during shutdown; no timer/queue is added. Every disconnect/abort/error/short-read/shutdown closes handles and releases budget; shutdown aborts and drains work before DB closure. Streams hold no metadata/reference lock while sending bytes. Transport failures after headers destroy the connection rather than append a JSON envelope. Source update/unregister cancel matching streams after commit.

## P0 decisions frozen for later phases

- All public Video contracts are optional/additive 1.0. P1 advertises only implemented operations (protocol/README.md). No progress/Consumer mutation capability is advertised prematurely.
- A Consumer persists an explicit kind and stable video MediaRef, never NAS or playback paths. Image/video lookup keys must include kind. Worldbook images and videos use independent relations/revisions.
- P2 metadata/poster CAS does not increment sourceRevision; only explicit source acceptance/relocation does. Conservative relocation resets progress unless true content identity is proven.
- Future progress wire body: sourceRevision, expectedProgressRevision (0 for absent), writeId UUID, finite nonnegative positionSeconds/durationHint, completed boolean. Independent single-row CAS; one in-flight write/session, 15-second coalescing plus pause/seeked/ended/close. CAS conflict stops automatic writes until explicit takeover; never max(position) or automatic last-arrival overwrite. Reuse same writeId only for the same payload. Read back uncertain outcomes instead of blind replay under a new ID.
- P2 poster updates and image hard deletion use the existing shared per-user reference coordinator. Video is a real expected poster Provider once poster storage ships. Do not import Video source paths into Image Store.
- Future Video consumer references are obtained from registered adapters; Worldbook/Outfit enumerate their own relations. Under the shared user coordinator, fresh complete analysis gates unregister; no async stream/long directory scan runs inside that lock. Single lock acquisition order, no recursive non-reentrant entry. Cross-DB operations are not advertised as distributed transactions.
- Watch session is on-demand and view-owned; closing/identity change releases the media source, requests, listeners/timers. One active video, no background queue, no autoplay after reload. Existing Audio's continued playback behavior is separate.

## Acceptance boundary

SQLite/HTTP/stream/signature fixtures establish transport, authorization, cancellation and persistence behavior. Current synthetic-browser decode evidence and the first user acceptance steps are below; they do not establish real NAS throughput, mobile codec compatibility or long-session heap behavior.

Directory navigation returns bounded `breadcrumbs:[{id,label}]` with directory capability IDs for root and each ancestor (maximum 33). A successful `directoryId` navigation replaces its source snapshot; old file candidates/cursors then expire. A failed navigation preserves the previous snapshot. This bounds retained directory data while allowing navigation back to ancestors without client paths; two independent directory browsers still share the 2/user limit.

## P2 implemented profile and Gate A

P2 implements metadata/poster CAS, independent progress CAS, explicit source replacement/relocation, reference reads and guarded unregister. Video SQLite upgrades schema 1 to **2** transactionally, preserving video IDs/locations; images/audio/Worldbook schemas and Core Protocol do not change. New `poster_asset_id`, `progress` and bounded `commands` receipt storage live only in Video SQLite. A later rollback to P1 requires restoring a pre-upgrade Video DB, not merely changing code. Commands retain at most 10000 one-day entries; full capacity fails explicitly. Progress retains one current-version row/video, no watch-history log.

The Video poster Provider is now registered with Image Governance. It enumerates persisted posters even if root access is disabled/revoked; a missing Video DB means no references, but a damaged/newer DB makes analysis incomplete. Poster writes and image deletion use the existing per-user coordinator. A trusted Video Consumer registry is available for P3: provider `enumerate(context)` returns bounded `{videoId,ownerId,label}` rows; unavailable/incomplete analysis prevents unregister. There are currently no Worldbook/Outfit Video adapters because those phases are not implemented. Source mutation preserves video ID/title/poster and increments sourceRevision, clears progress and aborts old active transfers. Unregister removes registration/progress/poster binding only; source files and image assets remain. Both use CAS/operation receipts; fresh references gate unregister.

Frontend P2 provides Media Center Video library, single-directory source registration, confirmed picker contribution, details, manual image upload/existing-image poster, explicit original VideoSession and multi-page/device continuation. Static poster previews reuse Image thumbnails with bounded requests; no video elements or video bodies are loaded until viewing. There is no video upload, automatic frame extraction, transcoding, remote fallback or background playback. Unsupported device codecs are shown as local playback failures, not global source corruption.

Progress saves coalesce every 15 seconds of playback plus pause/seek/end/normal close. One in-flight write and newest pending value; CAS conflict stops automatic writes until explicit takeover. Uncertain outcome performs one read-back, never a second blind write. Final close captures the nonzero position before clearing the source, with a bounded request still bound to the original account; switch-user contexts cannot submit old progress. Crashes can lose the last interval. Hidden pages pause and clear src; return requires explicit resume. Browser-native fullscreen Escape exits fullscreen before dismissing the viewer.

Local code evidence: targeted Video/session/UI, real SQLite/HTTP and existing suites; Chromium 153 through a local ST-like Express/session/CSRF host at 1280×800, 760×900 and 390×844. A generated 5-second H.264 MP4 decoded, sought to 2 seconds, closed with no Video DOM, and a second page resumed that position. Real PNG upload/poster persistence, title save and directory navigation were exercised. No video stream request occurred while browsing. This is synthetic-host Chromium evidence, not installed SillyTavern/NAS, physical mobile/WebKit, large-file throughput or long-session heap evidence.

### Operator preparation for first real-device Gate A

1. In the existing Server plugin checkout, inspect `git status` and preserve any local changes. Fetch origin and switch to `stage/video-foundation` (create tracking branch from `origin/stage/video-foundation` if absent), then update with fast-forward only. Run the existing `npm ci --omit=dev --ignore-scripts` installation procedure. Do not overwrite the plugin with an individual JS file. Restart ST after the mount/policy edit below.
2. Add a read-only bind mount to the ST container for a chosen NAS video directory. Example container-side destination `/media/video-clips`; the NAS source is chosen by the operator, never guessed. Keep the existing ST data/plugin mounts. Add the `video` block above to the existing administrator policy file outside plugin code; `path` is that container-side destination and `users` contains the exact ST profile handle. Keep all existing policy fields/allowedOrigins. With no roots configured the Video tab is unavailable by design.
3. If an earlier P1 Video DB exists, stop writes and consistently back up the whole user's `video-v1` directory before upgrade. External videos have their own backup. New installs create schema 2 on first Video operation; this does not migrate existing Worldbook data.
4. Import the paired frontend candidate JSON with the existing stable script ID, choosing overwrite. Source package version remains the formal baseline until release; the candidate name/hash identifies the actual code. Do not use main's older frontend installer for P2 acceptance.

### Gate A (minimum, approximately 10–15 minutes)

- In Video → 目录登记, open the configured root and register a known ordinary MP4 plus one real anime sample. Add a manually selected/uploaded poster, rename one record, refresh and confirm persistence.
- Watch, seek, fullscreen and close. Confirm silence after closing and ordinary chat remains usable. A codec-incompatible sample should show a clear failure and permit normal return; it does not trigger a transcoding requirement.
- Reopen the same user/video on phone or tablet and verify continuation; watch further and confirm desktop sees the newer position. A stale device conflict should offer explicit takeover, not overwrite silently.

Report which step and device failed. Source-offline recovery/dual-device extreme races are later Gate C; Worldbook integration follows P3/P4 after this base is usable. P2 remains a Review Fix candidate pending Gate A, not a release or merge approval.

### Review Fix boundaries

Only metadata-backed viewing changes mark progress dirty; decode failure, restoration, pause/close without changes never reset a saved completed state or consume another progress revision. Duplicate snapshots, including close after pause, do not issue repeated writes. Session/writer identity is video ID plus source revision, with generation/account checks. Ordinary initial progress-read failure permits playback with a persistent warning, but disables saving until explicit read-back/takeover obtains the CAS revision; identity/source mismatches fail closed. No automatic blind recovery write is introduced.

Title/poster updates retain the last observed source state only for the same source revision, with no extra NAS stat. Exact detail returns an optional friendly `rootLabel` from authorized policy; source replacement also returns the new label, without paths. Missing Video presentation is broken separately from no-poster and failed-thumbnail states. Frontend validates all P2 mutations, references, receipts and expected item IDs; malformed results never reach Detail as success.

Directory browse has a frontend 60-second deadline (other calls retain 15 seconds), owner cancellation and server abort checks, no automatic retry or parallel file probe. This is a bounded tolerance for a slow NAS, not a latency promise. Library source-status filtering, duration display and Consumer reference navigation are not implemented: duration/reference UI follows real P3 consumption needs; any future source filter must not stat every registered file during ordinary browsing.

Regressions hold discovery open while two viewers resolve/read progress, independently saturate/release operation admission, and inject failure after migration DDL begins to verify schema-1 rollback/data preservation and subsequent recovery. The machine-readable `video.foundation-1.0.*` now covers P1 and P2 requests/results, absent/saved progress, found/missing receipts, reference completeness and typed HTTP errors. Synthetic Chromium also exercises a progress GET failure (playback continues, zero progress writes), invalid MP4 decode preserving the complete saved progress DTO/revision, and the persistent failure warning; a late play rejection cannot replace the codec failure message. This evidence remains separate from Gate A.
