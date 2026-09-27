# Phase 4 Business Collection candidate

This is a code-side candidate, not an accepted installed-host release. The Business module depends on Core, not Media or Network. An unavailable Business Store does not make those modules unavailable. Its generic SQLite Store recognizes a trusted ST user root, consumer namespace, document schema version, collection revision, and bounded opaque document. Outfit semantics are confined to `src/business/outfit.js`.

## Persistence and versions

Each authenticated ST user's `req.user.directories.root` owns `tavern-toolbox-server/business-v1/collections.sqlite`. The internal SQLite schema is v1. The Outfit Business document schema is separately v1; `.ttoutfit` package v8 and Local IndexedDB versions do not determine either Server version. A newer unknown storage version or incompatible Outfit schema fails closed without clearing data. The collection uses a SQLite transaction and an integer revision. Read of an empty collection returns revision 0 without creating a row; a commit with expected revision 0 creates it. Every subsequent commit must provide the exact revision read by the client. A stale write returns `BUSINESS_CONFLICT` and changes nothing.

The first Consumer is `outfit`. Its document holds complete `assets`, `persons` and `wearStates`, including Wardrobe, Outfit, Kit and Item. It deliberately excludes Local migration markers, pending legacy activations, IndexedDB records and Blob stores. Outfit records can contain `{ "provider": "server", "assetId": "<opaque asset ID>" }` as `mediaRef` or `null`. They cannot contain a Local Blob ID, serving URL, digest or filesystem path as a media identity. An added or changed MediaRef must resolve under the same trusted ST user before commit. Existing broken references remain editable so that a cold restore with missing Media can be repaired. Deleting or replacing an Outfit record changes only Business state and never calls Media hard delete.

## Protocol 1.0

All routes require the authenticated ST session and `X-TTB-Protocol: 1.0`; responses use the common JSON envelope with `Cache-Control: no-store` and `nosniff`.

| Operation | Request | Result |
| --- | --- | --- |
| Read | `GET /v1/business/collections/outfit?schemaVersion=1` | `{namespace,schemaVersion,revision,document,updatedAt}` |
| Commit | `PUT /v1/business/collections/outfit` JSON `{schemaVersion:1,revision,document}` | New revision and committed document |

Commit also requires the trusted same-origin Origin and active ST CSRF token. The public capability is `business.collections` contract 1.0 with `read` and `commit`, an Outfit consumer schema declaration, a 2 MiB document bound and collection CAS semantics. The server does not accept a client-selected user, arbitrary namespace registration or generic query language. Invalid body or graph is rejected; old revision is HTTP 409 `BUSINESS_CONFLICT`; unsupported consumer/schema and unavailable Store have separate codes. SillyTavern's global JSON parser precedes this plugin, so enforce an ingress JSON body limit on the NAS as already required for Network.

The Server Media Store remains separate. A successfully imported Media Asset may remain unreferenced if Business commit fails. A cold backup must include both Business and Media roots while SillyTavern is stopped; a code tag does not restore data. A damaged or missing Media Asset never removes its Business record.

## Verification still required

Automated tests cover SQLite revision races, durable cold copy, user-root isolation, business graph validation, MediaRef ownership, Business/Media lifecycle separation and an Express middleware harness shaped like official SillyTavern 1.19.0. The real installed-host vertical slice, second device, editor conflict UX, and missing-media display require NAS acceptance before a v0.4.0 release.
