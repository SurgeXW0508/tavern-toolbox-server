# Phase 4 Business Collection

The Business module depends on Core, not Media or Network. An unavailable Business Store does not make those modules unavailable. Its generic SQLite Store recognizes a trusted ST user root, consumer namespace, document schema version, collection revision, and bounded opaque document. Outfit semantics are confined to `src/business/outfit.js`. The official ST 1.19.0 Docker/NAS acceptance scope is recorded in [Phase 4 acceptance](../PHASE-4-ACCEPTANCE.md).

Runtime: Core and Network can run on Node >=20; Phase 4 Business requires Node >=22.13 for `node:sqlite`, independently of Media (which requires Node >=22.13 and Sharp). On older Node, Business reports unavailable without changing the package-wide >=20 engine or disabling Core/Network.

## Persistence and versions

Each authenticated ST user's `req.user.directories.root` owns `tavern-toolbox-server/business-v1/collections.sqlite`. The internal SQLite schema is v1. The Outfit Business document schema is separately v2 (Stage); `.ttoutfit` package v8 and Local IndexedDB versions do not determine either Server version. A newer unknown storage version or incompatible Outfit schema fails closed without clearing data. The collection uses a SQLite transaction and an integer revision. Read of an empty collection returns revision 0 without creating a row; a commit with expected revision 0 creates it. Every subsequent commit must provide the exact revision read by the client. A stale write returns `BUSINESS_CONFLICT` and changes nothing.

The first Consumer is `outfit`. Its document holds complete `assets`, `persons` and `wearStates`, including Wardrobe, Outfit, Kit and Item. It deliberately excludes Local migration markers, pending legacy activations, IndexedDB records and Blob stores. Outfit records can contain `{ "provider": "server", "assetId": "<opaque asset ID>" }` as `mediaRef` or `null`. They cannot contain a Local Blob ID, serving URL, digest or filesystem path as a media identity. An added or changed MediaRef must resolve under the same trusted ST user before commit. Existing broken references remain editable so that a cold restore with missing Media can be repaired. Deleting or replacing an Outfit record changes only Business state and never calls Media hard delete.

## Outfit Schema 2 migration (Stage)

Outfit owns the pure schema-1 → 2 conversion and both strict validators. WearState now carries `wearStateVersion: 2` and ordered `outfitComponents: [{outfitId, kitId}]` instead of top-level `outfitId`/`kitId`. An Outfit appears at most once, each Kit belongs to that Outfit, and Extra/Removed arrays reference atomic Items with mutually exclusive membership. Fixed components are simultaneous; Scene still uses Wardrobe candidates. An existing empty Outfit with no Kits retains an empty Kit ID rather than inventing an asset; normal frontend-created Outfits have their own default Kit.

The trusted Consumer supplies a narrow `{fromVersion, validateSource, convert, validateTarget}` contract to BusinessStore reads. First schema-2 access to an existing schema-1 row acquires BEGIN IMMEDIATE, re-reads the actual version, validates the bounded old document, converts, validates the new document and size, then atomically updates document/schema/revision/time. Revision increases exactly once; already-upgraded reads do not write. Any conversion, validation, capacity or SQL failure rolls back the entire row; future schemas fail closed. No migration registry, background worker, new storage tables or Protocol version is introduced. Internal reference readers also use the current Consumer version, so migration may happen on their first access. MediaRef/Asset/Person identities, business relationships and the separate Video store are unchanged; migration does not import or regenerate media.

Before deploying: stop ST writes and consistently back up the entire per-user plugin directory, including Business, Media, Video, Account Documents and Records; keep any needed Local `.ttoutfit`. Deploy matching Server Stage, then Frontend Stage, restart ST and refresh every client. Old schema-1 clients are rejected for both read/write. Once migrated, a code-only rollback is unsafe: restore the matching pre-migration complete backup with ST stopped. Never edit schema_version manually, delete the new row or use a Local export as a Server restore.

## Protocol 1.0

All routes require the authenticated ST session and `X-TTB-Protocol: 1.0`; responses use the common JSON envelope with `Cache-Control: no-store` and `nosniff`.

| Operation | Request | Result |
| --- | --- | --- |
| Read | `GET /v1/business/collections/outfit?schemaVersion=2` | `{namespace,schemaVersion,revision,document,updatedAt}` |
| Commit | `PUT /v1/business/collections/outfit` JSON `{schemaVersion:2,revision,document}` | New revision and committed document |

Commit also requires the trusted same-origin Origin and active ST CSRF token. The public capability is `business.collections` contract 1.0 with `read` and `commit`, an Outfit consumer schema declaration, a 2 MiB document bound and collection CAS semantics. The server does not accept a client-selected user, arbitrary namespace registration or generic query language. Invalid body or graph is rejected; old revision is HTTP 409 `BUSINESS_CONFLICT`; unsupported consumer/schema and unavailable Store have separate codes. SillyTavern's global JSON parser precedes this plugin, so enforce an ingress JSON body limit on the NAS as already required for Network.

The Server Media Store remains separate. A successfully imported Media Asset may remain unreferenced if Business commit fails. A cold backup must include both Business and Media roots while SillyTavern is stopped; a code tag does not restore data. A damaged or missing Media Asset never removes its Business record.

## Verification boundaries

Automated tests cover SQLite revision races, durable cold copy, user-root isolation, business graph validation, MediaRef ownership, Business/Media lifecycle separation and an Express middleware harness shaped like official SillyTavern 1.19.0. The real installed-host vertical slice, second device, editor conflict UX, missing-media repair and cold restore passed as described in [Phase 4 acceptance](../PHASE-4-ACCEPTANCE.md). Real multi-user isolation was not exercised because this host has one ST user; the trusted user-root boundary remains an automated test claim.

## Optional Outfit Video attachments (P5)

The Video feature did not change the Outfit Business schema; the current Stage upgrade to schema 2 is described above. `assets[].mediaRef` is still Image-only; no videos/attachments fields are accepted or returned in the Business document. The separate `outfit.video` 1.0 capability owns its own schema-1 SQLite, CAS and exact receipts; see [Video P5](VIDEO.md#p5-server-outfit-video) and protocol fixtures. Local schema 7/packages and Server exportSnapshot-unavailable semantics remain.

Only an Asset ID-set change invokes the trusted Outfit lifecycle hooks under the existing coordinator. Pre-commit cleanup can only delete relationships of already-absent owners; successful Business commit precedes post-cleanup. A post-cleanup failure leaves deterministic recoverable rows, filtered from effective Video references by current owner existence. Cleanup before ID reuse prevents resurrection; inability to reconcile fails that Asset-set mutation closed. Existing ordinary metadata/image/person/wear writes remain independent. Video adds no universal attachment API; the current BusinessStore Consumer migration hook is restricted to the schema conversion above. Consistent backups must include business-v1 plus outfit-video-v1/video-v1/media-v1 and shared Worldbook reference state; older Server governance does not understand P5 references even though its Business schema remains readable.
