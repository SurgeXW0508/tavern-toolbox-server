# Local video foundation

## Current scope and continuation

Active branch: `stage/video-foundation`, based on Server main v0.10.1 and Frontend main v0.53.1. P0 contracts and P1 Server groundwork are implemented. The frontend branch currently records the continuation only; there is no Video UI, poster binding, playback-progress persistence, source replacement or Consumer video relation yet. Do not mark P2 or NAS acceptance complete. Core Protocol remains 1.0; existing Worldbook schema 3 and image/audio storage do not change. No version bump or Release is implied by this checkpoint.

Next P2: Video Domain library/manage/confirmed picker/detail/viewer; manual poster via existing Image Domain and a real image Reference Provider; one active view-owned VideoSession; per-user/source-version progress CAS with low-frequency coalescing. P3/P4 add independent Worldbook video attachments/capability and kind-dispatched static preview; original image Cover/Gallery stay independent. Outfit remains separately authorized P5. No empty Consumer Provider is registered in P1 and there is no unregister endpoint until fresh reference protection exists.

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

Each trusted ST user owns `tavern-toolbox-server/video-v1/metadata.sqlite`, schema 1, private directory mode 0700 and DB 0600. Video bytes remain in administrator-authorized external directories. `videos` has stable UUIDs, title, root key/private relative locator, private filesystem fingerprint, MIME, size, source and metadata revisions, creation time; unique root+locator and timestamp/id indexes. `receipts` preserves bounded one-day registration operation replay. No physical copies, Blob/base64 encoding or whole-file content hashes are made. No auto-GC or source deletion exists.

DTOs explicitly contain `kind: video`, `{provider: server, assetId}`, title, MIME, byteSize, sourceRevision, metadataRevision and createdAt. They never contain the source path/fingerprint. IDs do not grant access. Authorization is rechecked against current trusted user/root for read and every native stream. Same locator registration reuses identity; if its fingerprint changed it refuses silently accepting new bytes. Different users have separate DB identities even if the administrator authorizes the same source root.

Fingerprints use device/inode/size/high-resolution modification and change timestamps as strings, not content hashes. Exact detail probes up to 4096 bytes, identifies the bounded MP4 ftyp or WebM EBML DocType profile, and reports available/changed/unavailable. Filename extensions are discovery hints, not MIME authority. Codec decodability remains a device observation; metadata/transport tests do not prove a video can decode. This profile discovers `.mp4`, `.m4v`, `.webm`; other containers remain outside P1.

Back up private Video SQLite consistently with ST stopped, and back up external video directories separately. P2 poster originals and future Worldbook relations will need joint consistent backups. Do not publish metadata, live paths, source names or playback context URLs in diagnostics. Unknown newer or unexpected existing schema fails closed without resetting files. P1 does not alter Worldbook schema and code rollback cannot restore future data migrations.

## Bounded discovery and metadata reads

Browse only opens one directory. It asynchronously enumerates at most 1000 entries including unsupported file types, never recursively scans, checks at most 4096 bytes for each candidate video and closes the handle. Unsupported/damaged files are displayed as unavailable, not selectable. Symlink entries are omitted. Exceeding the budget fails explicitly and produces no partial successful snapshot. Existing registrations remain untouched on all failures. A candidate's fingerprint is rechecked before register. Nested directories use opaque short-lived IDs; no frontend path arguments are accepted.

Each snapshot is immutable, private to user/context/root and five-minute TTL, at most 2/user and 8/global; no background timer. Pages are 50, snapshot admission rejects busy rather than silently evicting a pending selection. Cancel by sessionId releases the retained rows. Disconnect cancels active enumeration. Returned directoryLabel is a root-relative presentation breadcrumb, not a physical path. At most 32 locator components; names and request sizes are bounded. Busy admission is checked before enumeration and at commit.

Catalog default 24/max 48, max 5000 videos/user, indexed stable creation-time/id order and SQL search/count/limit/offset. Page DTO projection touches only returned rows. Search is a substring metadata operation and can scan rows; OFFSET/count are not O(pageSize). Neither catalog nor presentation reads source files or claims live health. Presentation is at most 48 unique IDs and no per-item HTTP requests. Detail/resolve checks only its selected file.

## Native streaming and resource ownership

JSON operations require Protocol 1.0 and current X-TTB-Context. All POSTs, including read-only browse/presentation/resolve, require allowed same-origin Origin and current ST session CSRF. Context ID is boot-local and derived from trusted authenticated handle/root, not a durable user key.

Resolve returns a canonical plugin-relative path with transient `context` and `version` query fields. The frontend must apply the actual ST base path, as it already does for Audio. Persist only the MediaRef, never this URL. Native `<video>` cannot add custom headers: GET/HEAD uses the authenticated ST cookie, same-origin guard, exact context query and current source revision. It is not a bearer share link. Switching user or Server boot invalidates the old path; another user with a coincident ID cannot use it.

The common local-file transport now serves Audio and Video using a pinned, already-validated file handle, bounded 64 KiB reads and backpressure. Audio retains its existing signature/range preflight, coordinator and error vocabulary, and no new idle timer; Video applies a 30-second idle timeout. Range allows one interval, open/suffix forms; malformed/multiple/unsafe integer ranges fail before streaming. GET returns 200/206/416, HEAD performs source validation but sends no body. Private no-store/nosniff and same-origin resource policy apply. It never fetches Network.

Video caps active transfer requests at 4/user, 8/global, including pending opens; separately caps asynchronous catalog/discovery work at 2/user and 8/global. Every disconnect/abort/error/short-read/shutdown closes handles and releases budget; shutdown aborts and drains work before DB closure. Streams hold no metadata/reference lock while sending bytes. Transport failures after headers destroy the connection rather than append a JSON envelope. This stage has no source-mutation operation; later source update/unregister must cancel matching old-version streams after commit.

## P0 decisions frozen for later phases

- All public Video contracts are optional/additive 1.0. P1 advertises only implemented operations (protocol/README.md). No progress/Consumer mutation capability is advertised prematurely.
- A Consumer persists an explicit kind and stable video MediaRef, never NAS or playback paths. Image/video lookup keys must include kind. Worldbook images and videos use independent relations/revisions.
- P2 metadata/poster CAS does not increment sourceRevision; only explicit source acceptance/relocation does. Conservative relocation resets progress unless true content identity is proven.
- Future progress wire body: sourceRevision, expectedProgressRevision (0 for absent), writeId UUID, finite nonnegative positionSeconds/durationHint, completed boolean. Independent single-row CAS; one in-flight write/session, 15-second coalescing plus pause/seeked/ended/close. CAS conflict stops automatic writes until explicit takeover; never max(position) or automatic last-arrival overwrite. Reuse same writeId only for the same payload. Read back uncertain outcomes instead of blind replay under a new ID.
- P2 poster updates and image hard deletion use the existing shared per-user reference coordinator. Video is a real expected poster Provider once poster storage ships. Do not import Video source paths into Image Store.
- Future Video consumer references are obtained from registered adapters; Worldbook/Outfit enumerate their own relations. Under the shared user coordinator, fresh complete analysis gates unregister; no async stream/long directory scan runs inside that lock. Single lock acquisition order, no recursive non-reentrant entry. Cross-DB operations are not advertised as distributed transactions.
- Watch session is on-demand and view-owned; closing/identity change releases the media source, requests, listeners/timers. One active video, no background queue, no autoplay after reload. Existing Audio's continued playback behavior is separate.

## Acceptance boundary

P1 verification uses real SQLite/files, bounded signature fixtures, HTTP through an ST-like Express subpath/session/CSRF chain, streaming sinks, forced backpressure/cancellation/shutdown and 5000-row metadata. Fixtures establish transport/signature behavior, not decoding. No Frontend Video UI, actual video decode, NAS throughput, device heap or multi-device progress is validated yet. First user acceptance is planned after P2: register two real samples, manual poster, watch/seek/fullscreen/close and desktop/phone resume. Do not ask users to exercise raw HTTP/debug UI in P1.

Directory navigation returns bounded `breadcrumbs:[{id,label}]` with directory capability IDs for root and each ancestor (maximum 33). A successful `directoryId` navigation replaces its source snapshot; old file candidates/cursors then expire. A failed navigation preserves the previous snapshot. This bounds retained directory data while allowing navigation back to ancestors without client paths; two independent directory browsers still share the 2/user limit.
